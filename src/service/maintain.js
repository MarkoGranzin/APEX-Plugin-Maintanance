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

export async function maintainComponent(store, comp, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const exists = deps.exists ?? ((p) => !!p && fs.existsSync(p));
  const steps = [];
  const cur = () => store.get(comp.id) ?? comp;

  if (!exists(comp.path)) {
    return { component: comp.name, skipped: true, reason: 'kein Repo zugeordnet', steps };
  }

  const scan = deps.scan ?? scanRepo;
  const runOpts = { scan, logSink: deps.logSink, onTestPlan: deps.onTestPlan, onSbom: deps.onSbom, now };

  // 1) prüfen
  const r1 = runComponentOnce(store, cur(), runOpts);
  steps.push({ step: 'prüfen', status: r1.status, summary: r1.summary });

  // 2) Bibliotheken aus dem Web prüfen (Aktualität/Quelle) — stellt sicher, dass Updates erkannt werden
  try {
    const enriched = await checkLibrariesOnline(cur().libs ?? [], { fetchInfo: deps.fetchInfo, fetch: deps.fetch, now });
    store.update(comp.id, { libs: enriched, libsCheckedAt: now() });
    steps.push({ step: 'lib-check', count: enriched.length, outdated: enriched.filter((l) => l.outdated || l.vulnerable).length });
  } catch (e) {
    steps.push({ step: 'lib-check', error: String(e?.message ?? e) });
  }

  // 3) Auto-Fix: deterministisch + KI (falls Backend) + ALLE relevanten Lib-Updates
  const autoFix = deps.autoFix ?? autoFixComponent;
  let fixResult = null;
  try {
    fixResult = await autoFix(store, cur(), { ai: deps.ai, update: deps.update, updateDeps: deps.updateDeps, autoReviewFix: deps.autoReviewFix, now });
  } catch (e) {
    steps.push({ step: 'autofix', error: String(e?.message ?? e) });
  }
  if (fixResult) steps.push({ step: 'autofix', quickFixes: fixResult.quickFixes ?? 0, libUpdate: !!fixResult.libUpdate, ai: !!fixResult.aiResult });

  // 4) erneut prüfen (Re-Test)
  const r2 = runComponentOnce(store, cur(), runOpts);
  steps.push({ step: 're-test', status: r2.status, summary: r2.summary });

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
  return { component: comp.name, skipped: false, before: r1.status, after: r2.status, status, steps, fix: fixResult };
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
