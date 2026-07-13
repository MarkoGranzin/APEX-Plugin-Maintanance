/**
 * T-66 — Vollautomatische Pflege = manuelle Pflege: EINE Orchestrierung.
 *
 * maintainComponent führt den kompletten Pflegezyklus aus — identisch, egal ob manuell („Vollständige
 * Pflege jetzt") oder automatisch (Scheduler):
 *   1) prüfen (Tiefen-Analyse/Tests/Review/Protokoll via runComponentOnce → scanRepo)
 *   2) Bibliotheken aus dem Web prüfen (Aktualität/Alter/Quelle) + libsCheckedAt setzen
 *   3) Auto-Fix: deterministische Quick-Fixes + (falls KI) Review-Fixes + ALLE relevanten Lib-Updates
 *   4) erneut prüfen (Re-Test nach den Korrekturen)
 *   5) Lauf protokollieren/melden
 * So erhält jedes Plugin selbstständig alle relevanten Updates. Alle Abhängigkeiten sind injizierbar
 * → deterministisch testbar (ohne Netz/Git/KI).
 *
 * Resultat: src/service/maintain.js
 */

import fs from 'node:fs';
import { scanRepo } from './run-repo.js';
import { runComponentOnce } from './run-component.js';
import { checkLibrariesOnline } from './lib-check.js';
import { autoFixComponent } from './autofix.js';
import { applyVendoredUpdates, rollbackUpdates } from './lib-update.js';
import { planReplacements } from './lib-replace.js';
import { captureBaseline as defaultCaptureBaseline, compareToBaseline as defaultCompareToBaseline } from './baseline.js';
import { beginRun, persistBackups, finishRun } from './run-guard.js';

export async function maintainComponent(store, comp, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const exists = deps.exists ?? ((p) => !!p && fs.existsSync(p));
  const steps = [];
  const cur = () => store.get(comp.id) ?? comp;

  if (!exists(comp.path)) {
    return { component: comp.name, skipped: true, reason: 'no repo assigned', steps };
  }

  const scan = deps.scan ?? scanRepo;
  const runOpts = { scan, logSink: deps.logSink, onTestPlan: deps.onTestPlan, onSbom: deps.onSbom, now };

  // 1) prüfen
  const r1 = runComponentOnce(store, cur(), runOpts);
  steps.push({ step: 'check', status: r1.status, summary: r1.summary });

  // 2) Bibliotheken aus dem Web prüfen (Aktualität/Quelle) — stellt sicher, dass Updates erkannt werden
  try {
    const enriched = await checkLibrariesOnline(cur().libs ?? [], { fetchInfo: deps.fetchInfo, fetch: deps.fetch, now, ai: deps.ai });
    store.update(comp.id, { libs: enriched, libsCheckedAt: now() });
    steps.push({ step: 'lib-check', count: enriched.length, outdated: enriched.filter((l) => l.outdated || l.vulnerable).length });
  } catch (e) {
    steps.push({ step: 'lib-check', error: String(e?.message ?? e) });
  }

  // T-153: VORHER/NACHHER-Gate. „Vorher" = eingefrorene Baseline. Fehlt eine brauchbare Baseline, wird sie
  // JETZT — VOR jeder Änderung — gegen den unveränderten Stand aufgenommen. Nur wenn das Gate aktiv ist
  // (deps.worksAsBefore) und ein UI-Test-Ziel existiert; alles injizierbar → deterministisch testbar.
  const gate = !!deps.worksAsBefore;
  const captureBaselineFn = deps.captureBaseline ?? defaultCaptureBaseline;
  const compareFn = deps.compareToBaseline ?? defaultCompareToBaseline;
  if (gate) {
    const b = cur().baseline;
    const usable = b && (b.scenarios ?? []).some((s) => s.status === 'passed');
    if (!usable && (deps.uiTestUrl || cur().uiTestUrl)) {
      try { await captureBaselineFn(store, cur(), { pluginUrl: deps.uiTestUrl || cur().uiTestUrl, specsDir: deps.specsDir, hasPlaywright: deps.hasPlaywright, exec: deps.exec, runDetailed: deps.runDetailed, captureShot: deps.captureShot, now }); steps.push({ step: 'baseline', captured: true }); }
      catch (e) { steps.push({ step: 'baseline', error: String(e?.message ?? e) }); }
    }
  }

  // 2b) Die SOFTWARE spielt sichere Vendored-Lib-Updates (Minor/Patch) wirklich ein; Breaking nur markieren.
  const applyFn = deps.applyVendoredUpdates ?? applyVendoredUpdates;
  let libBackups = null;
  let appliedLibs = 0;
  let breakingLibs = [];
  try {
    const upd = await applyFn(comp.path, cur().libs ?? [], { fetchFile: deps.fetchFile, fetch: deps.fetch });
    libBackups = upd.backups;
    appliedLibs = upd.results.filter((r) => r.applied).length;
    breakingLibs = upd.results.filter((r) => r.breaking && !r.applied);
    for (const r of upd.results) steps.push({ step: 'lib-update', name: r.name, from: r.from, to: r.to, applied: r.applied, reason: r.reason });
    // B-58: Backups NACH dem Anwenden auf Platte sichern → stirbt der Dienst vor dem works-as-before-Gate,
    // rollt der nächste Start den halb-aktualisierten Stand aus diesen persistierten Backups zurück.
    // NUR bei real existierendem Repo-Verzeichnis — sonst würden Fake-Pfade (Tests) Phantom-.maintenance anlegen.
    if (appliedLibs && libBackups && libBackups.size && comp.path && fs.existsSync(comp.path)) {
      try { beginRun(comp.path, { startedAt: now(), component: comp.name }); persistBackups(comp.path, libBackups); } catch { /* best effort */ }
    }
  } catch (e) { steps.push({ step: 'lib-update', error: String(e?.message ?? e) }); }

  // 3) Auto-Fix: deterministisch + KI (falls Backend) + ALLE relevanten Lib-Updates
  const autoFix = deps.autoFix ?? autoFixComponent;
  let fixResult = null;
  try {
    fixResult = await autoFix(store, cur(), { ai: deps.ai, update: deps.update, updateDeps: deps.updateDeps, autoReviewFix: deps.autoReviewFix, verifyNative: deps.verifyNative, now });
  } catch (e) {
    steps.push({ step: 'autofix', error: String(e?.message ?? e) });
  }
  if (fixResult) steps.push({ step: 'autofix', quickFixes: fixResult.quickFixes ?? 0, libUpdate: !!fixResult.libUpdate, ai: !!fixResult.aiResult });

  // 4) erneut prüfen (Re-Test)
  let r2 = runComponentOnce(store, cur(), runOpts);
  steps.push({ step: 're-test', status: r2.status, summary: r2.summary });

  // 4a) Sicheres Update brach den Build? → Rollback (kein blindes Tauschen ohne grünen Test)
  if (appliedLibs && r2.status === 'zu klären' && libBackups && libBackups.size) {
    rollbackUpdates(libBackups);
    r2 = runComponentOnce(store, cur(), runOpts);
    steps.push({ step: 'lib-update', rolledBack: true, reason: 'regression on re-test after update — rolled back' });
  }

  // 4d) T-153 TIEFES Vorher/Nachher-Gate: nach ANGEWANDTEN Änderungen den Mock „nachher" aktualisieren und die
  // aktuellen UI-Szenarien gegen die eingefrorene Baseline vergleichen (works-as-before). Regression (nicht wie
  // zuvor) → Rollback der Lib-Änderungen (inkl. .sql-Re-Embed) + Mock zurückbauen. Nur bei aktivem Gate.
  let wab = null;
  const changed = appliedLibs || (fixResult && (fixResult.quickFixes || fixResult.aiResult));
  // B-70: „Nachher"-Mock NICHT per KI neu bauen (nicht-deterministische Sichten → falscher „missing"-Regress),
  // sondern nur die vendored Lib-/CSS-Dateien im eingecheckten Mock auf den aktuellen Repo-Stand re-synchronisieren.
  // index.html + Self-Test-Szenarien bleiben identisch → gleiche Keys, echter Lib-Vergleich. Fallback: rebuildMock.
  const refreshAfterMock = async () => { if (deps.refreshMockLibs) await deps.refreshMockLibs(cur()); else if (deps.rebuildMock) await deps.rebuildMock(cur()); };
  if (gate && deps.runDetailed && changed) {
    try {
      await refreshAfterMock(); // „Nachher"-Mock (gleiche Szenarien, aktualisierte Libs)
      const url = deps.uiTestUrl || cur().uiTestUrl;
      const rr = await deps.runDetailed(cur(), { pluginUrl: url, specsDir: deps.specsDir, hasPlaywright: deps.hasPlaywright, exec: deps.exec });
      const cmp = compareFn(cur(), rr.ran ? (rr.scenarios ?? []) : []);
      const regression = rr.ran && !cmp.pass && !cmp.noBaseline && !cmp.noGreenBaseline;
      if (regression && libBackups && libBackups.size) {
        rollbackUpdates(libBackups);
        await refreshAfterMock(); // Libs zurückgerollt → Mock wieder auf den Ausgangsstand re-synchronisieren
        r2 = runComponentOnce(store, cur(), runOpts);
        wab = { pass: false, rolledBack: true, regressions: cmp.regressions?.length ?? 0, summary: cmp.summary };
      } else {
        wab = { pass: !!cmp.pass, mode: cmp.mode, regressions: cmp.regressions?.length ?? 0, staleSpec: !!cmp.staleSpec, summary: cmp.summary };
      }
      steps.push({ step: 'works-as-before', ...wab });
    } catch (e) { steps.push({ step: 'works-as-before', error: String(e?.message ?? e) }); }
  }

  // 4b) BREAKING-Updates (Major) werden NICHT still in die Baseline getauscht — ein statischer Test
  // kann eine Major-Migration nicht verifizieren. Die SOFTWARE bereitet sie per KI-Agent + Coded-UI-Test
  // vor und übernimmt sie erst nach Review (Upload/PR). Hier nur melden, was zu tun ist.
  for (const l of breakingLibs) {
    const can = deps.ai && deps.ai.kind !== 'stub';
    steps.push({
      step: 'migrate', name: l.name, from: l.from, to: l.to, skipped: true,
      reason: can
        ? 'Major update: the software migrates via AI agent + coded UI test; adopted only after review (upload/PR)'
        : 'Major update: an AI backend is required for the software to perform the migration',
    });
  }

  // 4c) UNMAINTAINED Libs werden ERSETZT (nicht nur geupdatet): permissiver Nachfolger bzw. MIT-Self-Build.
  // Wie Breaking-Updates wird das per KI-Migration + works-as-before-Gate übernommen (in fullMaintain/redev).
  const can = deps.ai && deps.ai.kind !== 'stub';
  for (const r of planReplacements(cur().libs ?? [])) {
    steps.push({
      step: 'migrate', name: r.from, to: r.to, replace: true, strategy: r.strategy, license: r.license ?? null, skipped: true,
      reason: r.strategy === 'replace'
        ? (can ? `Unmaintained → replace with ${r.to} (${r.license}${r.attribution ? ', attribution' : ', no obligations'}); migrated via AI + works-as-before gate` : `Unmaintained → replaceable with ${r.to} (${r.license}); an AI backend is required to perform the swap`)
        : (can ? 'Unmaintained, no permissive successor → AI builds a minimal MIT replacement, verified as before' : 'Unmaintained, no permissive successor → an AI backend is required to build a replacement'),
    });
  }

  const status = r2.status === 'ok' ? 'green' : r2.status === 'zu klären' ? 'red' : 'partial';

  // 5) Auto-Upload NUR im Job und NUR bei grün (alle Tests/Review bestanden) — UI lädt separat per Bestätigung hoch
  if (deps.autoUpload && status === 'green' && deps.upload) {
    try {
      const up = await deps.upload(cur());
      if (up?.ok) { store.update(comp.id, { reviewUrl: up.prUrl ?? null, reviewBranch: up.branch ?? null }); steps.push({ step: 'upload', branch: up.branch, pushed: up.pushed, prUrl: up.prUrl }); }
      else steps.push({ step: 'upload', skipped: true, reason: up?.reason });
    } catch (e) { steps.push({ step: 'upload', error: String(e?.message ?? e) }); }
  }
  if (deps.recordRun) {
    deps.recordRun({
      id: deps.idGen ? deps.idGen() : `maint-${comp.repo ?? comp.name}`,
      status,
      updated: [{ artifact: comp.name, change: r2.summary, status: r2.status }],
      failures: [],
      repo: comp.repo ?? null,
    });
  }
  // B-58: Lauf sauber zu Ende gebracht (adoptiert ODER regulär zurückgerollt) → persistierte Backups/Marker
  // räumen, damit der nächste Start diesen Lauf NICHT fälschlich als „unterbrochen" zurückrollt.
  try { finishRun(comp.path); } catch { /* best effort */ }
  return { component: comp.name, skipped: false, before: r1.status, after: r2.status, status, steps, fix: fixResult, worksAsBefore: wab };
}

/** Pflegt alle (oder je Repo gefilterten) Komponenten — dieselbe Orchestrierung wie manuell. */
export async function maintainAll(store, deps = {}) {
  const comps = store.list().filter((c) => !deps.repo || c.repo === deps.repo);
  const results = [];
  for (const c of comps) {
    try { results.push(await maintainComponent(store, c, deps)); }
    catch (err) { results.push({ component: c.name, skipped: false, error: String(err?.message ?? err) }); }
  }
  return results;
}
