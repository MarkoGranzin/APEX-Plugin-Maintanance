#!/usr/bin/env node
/**
 * Plugin Maintenance — Start-/CLI-Einstieg.
 *
 *   node start.js scan <repo-pfad>     Einmaliger, read-only Pflege-Lauf über ein Repo (Analyse,
 *                                       Inventar, SBOM/Updates, Risiko, Static-First-Gate, Triage).
 *   node start.js serve [port]          Dienst: wöchentlicher Scheduler + Mini-Web-GUI
 *                                       (Dashboard-JSON, Repo-Trigger, readme.html). Default-Port 4317.
 *   node start.js help                  Diese Hilfe.
 *
 * Secrets: Master-Key aus Umgebungsvariable AISPP_MASTER_KEY (für `serve`/Settings mit Secrets).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn as childSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRepo } from './src/service/run-repo.js';
import { createScheduler } from './src/service/scheduler.js';
import { createHistory, recordRun, listRuns } from './src/report/history.js';
import { createSettings } from './src/config/settings.js';
import { createComponentStore } from './src/gui/store.js';
import { apiHandler, metaApiHandler } from './src/gui/api.js';
import { defaultGather } from './src/gui/components.js';
import { syncRepo } from './src/service/workspace.js';
import { autoUpdateComponent } from './src/service/update-component.js';
import { applyVendoredUpdates } from './src/service/lib-update.js';
import { assignRepoToComponent } from './src/service/assign-repo.js';
import { autoReviewFix } from './src/service/autoreview.js';
import { dualReviewFix } from './src/service/dual-review-fix.js';
import { checkLibrariesOnline, libWarningFrom } from './src/service/lib-check.js';
import { buildSbom } from './src/sbom/sbom.js';
import { autoFixComponent } from './src/service/autofix.js';
import { maintainComponent } from './src/service/maintain.js';
import { runUiTests } from './src/test/run-ui.js';
import { captureBaseline } from './src/service/baseline.js';
import { redevelopComponent } from './src/service/redev.js';
import { generateAiMock, writeMock, refineMock, mockInputFingerprint, MOCK_SPEC_VERSION, runMockSelfTests } from './src/test/mock.js';
import { acceptanceFromSelfTest, writeAcceptance, readAcceptance, acceptanceFeatureFile, acceptanceToDevhub } from './src/service/acceptance.js';
import { redevelopDeadLib, buildSliceRebuildPrompt } from './src/service/redev-slices.js';
import { inspectAssets, parseOk } from './src/extract/assets.js';
import { reinjectAsset } from './src/extract/reinject.js';
import { uploadFix } from './src/service/upload.js';
import { slug as slugify } from './src/util/slug.js';
import { resolveAiBackend, aiBackendView } from './src/ai/configure.js';
import { createPrRegistry } from './src/run/dedup.js';
import { SecretStore } from './src/config/secrets.js';
import { renderReport } from './src/report/mail.js';
import { sendReportMail } from './src/report/smtp.js';
import { cronMatches } from './src/service/cron.js';
import { runComponentOnce } from './src/service/run-component.js';
import { runComponentTests } from './src/service/test-runner.js';
import { simpleGit } from 'simple-git';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Datenverzeichnis (Komponenten/Settings/Secrets/Logs/Testpläne). Per AISPP_DATA_DIR umlenkbar,
// damit QA/Tests NIE die echte Nutzer-Konfiguration unter <root>/data berühren (T-58).
const DATA_DIR = process.env.AISPP_DATA_DIR || path.join(__dirname, 'data');
// Build-Marker: muss mit APP_BUILD in public/app.html übereinstimmen. Bei Backend-Änderungen erhöhen.
// Das Frontend vergleicht beide und warnt, wenn der laufende Dienst veraltet ist (Neustart nötig).
const BUILD = '2026-06-28.58';
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const c = (col, s) => `${C[col]}${s}${C.reset}`;

function printScan(result) {
  console.log(c('bold', `\n  Plugin Maintenance — Scan: ${result.repoDir}\n`));
  if (result.artifacts.length === 0) {
    console.log(c('yellow', '  Keine APEX-Plugins/Template-Komponenten erkannt.\n'));
    return;
  }
  for (const a of result.artifacts) {
    const statusCol = a.status === 'ok' ? 'green' : a.status === 'extraktion-unsicher' ? 'red' : 'yellow';
    console.log(`  ${c('bold', a.name)} ${c('dim', `(${a.type})`)}  ${c(statusCol, a.status ?? 'ok')}`);
    console.log(`    Format: ${a.format}   Test-Pfad: ${a.testPath ?? c('yellow', 'zu klären')}`);
    console.log(`    Assets: js=${a.assets.js} css=${a.assets.css} inline=${a.assets.inline} urls=${a.assets.referencedUrls}`);
    if (a.entryPoints.length) console.log(c('dim', `    Einstiegspunkte: ${a.entryPoints.join(', ')}`));
    for (const comp of a.components) console.log(c('dim', `    Lib: ${comp.name}@${comp.version} (${comp.detectedBy})`));
    for (const u of a.updates) if (u.outdated) console.log(c('yellow', `    ⬆ Update: ${u.name} ${u.current} → ${u.latest}`));
    for (const r of a.risks) console.log(c('red', `    ${r.label} ${r.name}: ${r.reasons.join('; ')}`));
    for (const f of a.static.retire.findings) console.log(c('red', `    ⚠ Schwachstelle: ${f.lib}@${f.version} (${f.vuln}, fix ab ${f.fixedFrom})`));
    if (!a.static.lint.ok) console.log(c('red', `    Lint: ${a.static.lint.findings.map((f) => f.message).join('; ')}`));
  }
  const t = result.triage.inconsistency;
  console.log(c('cyan', `\n  Kennzahl: ${t.text}`));
  if (result.triage.triageList.length) {
    console.log(c('yellow', `  Braucht Entscheidung: ${result.triage.triageList.map((x) => x.name).join(', ')}`));
  }
  console.log('');
  console.log(c('bold', '  Report-Vorschau:'));
  console.log(result.report.body.split('\n').map((l) => '    ' + l).join('\n'));
  console.log('');
}

function cmdScan(repoPath) {
  if (!repoPath) return fail('Bitte einen Repo-Pfad angeben:  node start.js scan <pfad>');
  if (!fs.existsSync(repoPath)) return fail(`Pfad nicht gefunden: ${repoPath}`);
  const result = scanRepo(repoPath);
  printScan(result);
}

function cmdServe(portArg) {
  const port = Number(portArg) || 4317;
  const settings = createSettings();
  // Einstellungen persistent (F-21/F-18): bleiben über Neustart erhalten
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  try { if (fs.existsSync(settingsFile)) Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch {}
  // Vom Nutzer gewünscht: Auto-Repair und Push sind dauerhaft an (keine Settings-Toggles mehr).
  // Outward-facing: der Upload-Button fragt weiterhin vor dem Push nach (Bestätigung im Klick).
  settings.autoRepair = true;
  settings.allowPush = true;
  const saveSettings = () => {
    try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch {}
  };

  const history = createHistory();
  const store = createComponentStore({ file: path.join(DATA_DIR, 'components.json') });
  const record = (entry) => recordRun(history, entry);

  // Prüfprotokoll-Archiv je Komponente (F-22) — bleibt auch erhalten, wenn die GUI zu war
  const logDir = path.join(DATA_DIR, 'logs');
  const compLogDir = (component) => path.join(logDir, slugify(component.name));
  const writeLog = (component, text) => {
    try { const d = compLogDir(component); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${Date.now()}.log`), text); } catch {}
  };
  // Testplan (.feature) INS PLUGIN-VERZEICHNIS unter .maintenance/tests/ (analog Baseline/Coded-Tests) →
  // wird beim Upload mitcommittet. Fallback nach DATA_DIR/testplans, wenn (noch) kein Repo-Pfad da ist.
  const testplanDir = path.join(DATA_DIR, 'testplans');
  const onTestPlan = (component, text) => {
    try {
      if (component?.path && fs.existsSync(component.path)) {
        const d = path.join(component.path, '.maintenance', 'tests');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${slugify(component.name)}.feature`), text);
      } else {
        fs.mkdirSync(testplanDir, { recursive: true });
        fs.writeFileSync(path.join(testplanDir, `${slugify(component.name)}.feature`), text);
      }
    } catch { /* Datei-Fehler nicht eskalieren */ }
  };
  // SBOM (CycloneDX) je Plugin persistent ablegen — auch headless verfügbar (T-75)
  const sbomDir = path.join(DATA_DIR, 'sbom');
  const onSbom = (component, sbom) => {
    try { fs.mkdirSync(sbomDir, { recursive: true }); fs.writeFileSync(path.join(sbomDir, `${slugify(component.name)}.cdx.json`), JSON.stringify(sbom, null, 2)); } catch {}
  };
  // Charakterisierungs-Baseline INS PLUGIN-VERZEICHNIS ablegen (F-28/T-92/T-99): Teil des Pflege-Nachweises,
  // wird beim Upload mitcommittet. Fallback nach DATA_DIR/baseline nur, wenn (noch) kein Repo-Pfad da ist.
  const baselineDir = path.join(DATA_DIR, 'baseline');
  const onBaseline = (component, baseline) => {
    try {
      if (component?.path && fs.existsSync(component.path)) {
        const d = path.join(component.path, '.maintenance');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'baseline.json'), JSON.stringify(baseline, null, 2));
      } else {
        fs.mkdirSync(baselineDir, { recursive: true });
        fs.writeFileSync(path.join(baselineDir, `${slugify(component.name)}.json`), JSON.stringify(baseline, null, 2));
      }
    } catch { /* Datei-Fehler nicht eskalieren */ }
  };
  // F-29: laufende Operationen je Komponente serverseitig merken (clone/maintain/migrate/…),
  // damit die GUI auch nach Reload / bei woanders gestartetem Lauf „läuft gerade" anzeigen kann.
  const RUNNING = new Set();
  // F-29+: aktueller Schritt je laufender Komponente (z.B. „Mock: Analyse…") → GUI zeigt, WAS gerade passiert.
  const STEP = new Map();
  const setStep = (id, step) => { if (id) STEP.set(id, step); };
  // Auto-Mock je Plugin (F-28/T-97/T-99): self-contained Testseite + generierte Tests INS REPO schreiben
  // (unter <repo>/.maintenance/), damit sie beim Upload mitcommittet werden; von dort statisch ausliefern.
  // KI-first (T-101): die KI schreibt aus der Analyse einen plugin-spezifischen Mock; ohne KI Fallback
  // auf das statische Template. Kosten begrenzen: einmal je Plugin bauen (force bei assign-repo),
  // sonst wiederverwenden (Full maintenance baut nur, wenn noch keiner existiert) — gleicher Harness vor/nach Migration.
  const buildMockFor = async (component, opts = {}) => {
    try {
      if (!component?.path || !fs.existsSync(component.path)) return null;
      const sl = slugify(component.name);
      const mockUrl = `http://localhost:${port}/mock/${sl}/index.html`;
      const mockDir = path.join(component.path, '.maintenance', 'mock');
      const fpPath = path.join(mockDir, '.mock-fingerprint.json');
      const exists = fs.existsSync(path.join(mockDir, 'index.html'));
      const ai = resolveAiBackend(settings, secretStore);
      const cur0 = store.get(component.id) || {};
      // Alten/statischen Mock auf den KI-Mock hochstufen, sobald ein KI-Backend da ist (einmalig).
      const upgrade = ai.kind !== 'stub' && cur0.mockMode !== 'ai';
      // Versionierte KI-Untersuchung: nur bei UNBEKANNTER Version bauen. Stimmt der eingecheckte Mock-Fingerprint
      // (Plugin-Code + Vertrag + Libs/CSS + Spec-Version) mit dem aktuellen Stand überein → KI sparen, wiederverwenden.
      const fp = mockInputFingerprint(component.path);
      let fpFile = null;
      try { fpFile = JSON.parse(fs.readFileSync(fpPath, 'utf8')); } catch { fpFile = null; }
      const known = exists && fp && fpFile?.fp === fp && fpFile?.mode === 'ai'; // nur ECHTE KI-Mocks gelten als bekannt; static-Fallbacks immer neu versuchen
      if (exists && known && !upgrade) {
        if (opts.force) writeLog(component, '[mock] bekannte Version (Fingerprint match) — KI-Untersuchung übersprungen, eingecheckter Mock wiederverwendet');
        // Self-Test-Bilanz + Modus aus der Fingerprint-Datei wiederherstellen (Badge/Anzeige stimmt auch beim Cache-Treffer).
        const sc = (fpFile && typeof fpFile.total === 'number') ? { views: fpFile.views ?? null, total: fpFile.total, failed: fpFile.failed ?? 0 } : (cur0.mockSelfCheck || null);
        store.update(component.id, { mockUrl, mockFingerprint: fp, mockMode: fpFile?.mode || cur0.mockMode || 'ai', mockSelfCheck: sc, ...(cur0.uiTestUrl ? {} : { uiTestUrl: mockUrl }) });
        return mockUrl;
      }
      setStep(component.id, 'Mock: Plugin wird untersucht…');
      const gen = await generateAiMock(component.path, { ai, name: component.name, onStep: (s) => setStep(component.id, `Mock: ${s}`) }); // KI schreibt; Fallback statisch
      writeMock(mockDir, component.path, gen); // committet (git add .)
      // Selbstkorrektur-Schleife: Self-Tests headless laufen lassen; rote (Fehl-Charakterisierungen) lässt die KI
      // generisch nachbessern (Ist-Werte statt geratener Konstanten) → bis grün. Für JEDES Plugin, ohne Handarbeit.
      try {
        setStep(component.id, 'Mock: Self-Tests prüfen…');
        const ref = await refineMock(gen, {
          ai, url: mockUrl, name: component.name,
          write: (html) => writeMock(mockDir, component.path, { ...gen, html }),
          log: (m) => { writeLog(component, `[mock-selfcheck] ${m}`); setStep(component.id, `Mock: ${m}`); },
        });
        if (ref.after) {
          gen.html = ref.html;
          // „failed" zählt ALLE verbliebenen Probleme (rote Checks + falsch-grüne Dependency-/Leer-Render-Fälle)
          gen.selfCheck = { views: ref.after.views, total: ref.after.total, failed: (ref.failed || ref.after.failed || []).length };
          // T-116: Akzeptanz-Vertrag (technologieunabhängiges Soll) aus der grünen Charakterisierung festhalten
          // → Grundlage für eine spätere slice-weise Neuentwicklung (F-30/T-117).
          try { const contract = acceptanceFromSelfTest(ref.after, { name: component.name, at: new Date().toISOString() }); if (!contract.error) writeAcceptance(component.path, contract); } catch { /* best effort */ }
        }
      } catch (e) { writeLog(component, `[mock-selfcheck] übersprungen: ${e?.message ?? e}`); }
      const testsDir = path.join(component.path, '.maintenance', 'tests');
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, gen.spec.name), gen.spec.content);
      // Fingerprint neben dem (eingecheckten) Mock ablegen → künftige Builds bekannter Versionen sparen die KI.
      // Fingerprint NUR für echte KI-Mocks schreiben — einen static-Fallback (KI nicht verfügbar) nicht cachen,
      // sonst bliebe ein Fehlschlag „bekannt". So wird bei verfügbarer KI automatisch neu gebaut.
      try { if (fp && gen.mode === 'ai') fs.writeFileSync(fpPath, JSON.stringify({ fp, spec: MOCK_SPEC_VERSION, mode: gen.mode, views: gen.selfCheck?.views ?? null, total: gen.selfCheck?.total ?? null, failed: gen.selfCheck?.failed ?? null }, null, 2)); else if (gen.mode !== 'ai') { try { fs.rmSync(fpPath, { force: true }); } catch { /* egal */ } } } catch { /* best effort */ }
      const cur = store.get(component.id) || {};
      const patch = { mockUrl, mockMode: gen.mode, mockNote: gen.fallbackReason || null, mockFingerprint: fp || null, mockSelfCheck: gen.selfCheck || null, codedTests: [...(cur.codedTests || []).filter((t) => t.name !== gen.spec.name), gen.spec] };
      if (!cur.uiTestUrl) patch.uiTestUrl = mockUrl; // Default-Ziel, falls der Nutzer keine eigene URL gesetzt hat
      store.update(component.id, patch);
      return mockUrl;
    } catch { return null; }
  };
  // Report aus dem aktuellen Stand aller Komponenten bauen
  const buildReport = () => {
    const comps = store.list();
    const updated = comps.filter((x) => x.lastChange).map((x) => ({ artifact: x.name, change: x.lastChange.summary, testResult: x.status, gitLink: x.source || '', reviewUrl: x.reviewUrl || null, rebuilt: !!x.rebuilt }));
    const risks = comps.filter((x) => x.libWarning).map((x) => ({ name: x.name, label: '⚠ Libs', reasons: [`${x.libWarning.vulnerable || 0} verwundbar, ${x.libWarning.unmaintained || 0} nicht gepflegt`] }));
    const failures = comps.filter((x) => ['zu klären', 'review-blockiert'].includes(x.status)).map((x) => ({ artifact: x.name, reason: x.status }));
    // T-94: neu gebaute/migrierte Komponenten gesondert ausweisen
    const rebuilt = comps.filter((x) => x.rebuilt).map((x) => ({ artifact: x.name, to: x.rebuiltTo || 'latest', at: x.rebuiltAt || null, reviewUrl: x.reviewUrl || null }));
    // T-95: Lizenz-Auffälligkeiten (copyleft/unbekannt) über alle Libs
    const licenses = [];
    for (const x of comps) for (const l of x.libs || []) {
      const c = l.licenseInfo; if (c && c.level === 'warn') licenses.push({ name: `${x.name}/${l.name}`, id: c.id, reason: c.reason });
    }
    return renderReport({ updated, risks, failures, rebuilt, licenses });
  };

  // Geplanter Lauf je Repo: neu anbinden (fetch+detect) → analysieren → lastChange/Status + History
  const scheduler = createScheduler({
    runJob: async (repo) => {
      const cfg = settings.repos.find((r) => r.name === repo);
      if (!cfg) return;
      try {
        await syncRepo(cfg, { workDir: settings.workDir, store });
      } catch (err) {
        record({ id: `run-${repo}-${history.runs.length + 1}`, status: 'red', failures: [{ artifact: repo, reason: String(err?.message ?? err) }], repo });
        return;
      }
      // Vollautomatische Pflege = dieselbe Orchestrierung wie der manuelle „Full maintenance now"-Button
      // (T-66): inkl. Mock + verifizierter Lib-Migration (B-17). Job committet/pusht bei grün (Push nur allowPush).
      for (const c of store.list().filter((x) => x.repo === repo)) {
        try {
          await fullMaintain(c, { autoUpload: true });
        } catch (err) {
          record({ id: `maint-${repo}-${history.runs.length + 1}`, status: 'red', failures: [{ artifact: c.name, reason: String(err?.message ?? err) }], repo });
        }
      }
    },
  });

  // Verschlüsselter Secret-Speicher (T-12) für interne Repo-Zugangsdaten (F-21)
  const masterKey = process.env.AISPP_MASTER_KEY || 'dev-insecure-key';
  if (masterKey === 'dev-insecure-key') console.log(c('yellow', '  Hinweis: AISPP_MASTER_KEY nicht gesetzt — Secrets werden mit unsicherem Dev-Key verschlüsselt.'));
  const secretsFile = path.join(DATA_DIR, 'secrets.json');
  let initialBlobs = {};
  try { if (fs.existsSync(secretsFile)) initialBlobs = JSON.parse(fs.readFileSync(secretsFile, 'utf8')).blobs ?? {}; } catch {}
  const secretStore = new SecretStore(masterKey, initialBlobs); // persistente Secrets (nur Chiffrate)
  const saveSecrets = () => {
    try { fs.mkdirSync(path.dirname(secretsFile), { recursive: true }); fs.writeFileSync(secretsFile, JSON.stringify(secretStore.toJSON(), null, 2)); } catch {}
  };

  // Auto-Update (F-20): Session-PR-Registry + lokaler Branch-Push
  const prRegistry = createPrRegistry();
  const localGitPush = (repoDir) => async ({ branch }) => {
    const git = simpleGit({ baseDir: repoDir });
    try { await git.addConfig('user.email', 'aisp@local'); await git.addConfig('user.name', 'Plugin Maintenance'); } catch {}
    try { await git.checkoutLocalBranch(branch); } catch { try { await git.checkout(branch); } catch {} }
    try { await git.add('.'); await git.commit(`chore(aisp): update via ${branch}`); } catch {}
    return { branch };
  };

  // Upload (T-76): neuer Branch + Commit + optional Push; PR-Link aus der Quelle.
  const gitFor = (dir) => {
    const git = simpleGit({ baseDir: dir });
    return {
      status: async () => { try { return (await git.status()).files.map((f) => f.path); } catch { return []; } },
      branchCommit: async (b, m) => {
        try { await git.addConfig('user.email', 'aisp@local'); await git.addConfig('user.name', 'Plugin Maintenance'); } catch {}
        try { await git.checkoutLocalBranch(b); } catch { try { await git.checkout(b); } catch {} }
        await git.add('.'); await git.commit(m);
      },
      push: async (b) => { await git.push(['-u', 'origin', b]); }, // braucht Remote + Token; sonst Fehler → pushed:false
    };
  };
  const stampNow = () => new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  // SICHERHEIT (T-76): tatsächlich gepusht wird NUR, wenn der Nutzer es in den Einstellungen erlaubt hat.
  // Ohne Erlaubnis bleibt es bei einem lokalen Branch+Commit (pushed:false).
  const uploadFor = (push) => async (comp) => uploadFix(comp, { git: gitFor(comp.path), push: !!(push && settings.allowPush), stamp: stampNow() });

  // Vollständige Pflege-Orchestrierung (T-66) — EINE Quelle für den Button UND den autonomen Lauf
  // (Scheduler/Cron), damit das Tool standalone wirklich pflegt: Mock sicherstellen → maintainComponent
  // (check/safe-updates/autofix/re-test) → bei breaking Libs: Baseline gegen den Mock + verifizierte
  // Migration (redevelopComponent, B-17 tauscht die Libs real) → adopt „wie zuvor" / sonst Rollback.
  const fullMaintain = async (component, opts = {}) => {
    const id = component.id;
    RUNNING.add(id); // F-29: auch autonome Läufe (Scheduler/Cron) zeigen den „running…"-Indikator in der GUI
    try {
    const ai = resolveAiBackend(settings, secretStore);
    const hasPlaywright = fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test'));
    const specsDir = path.join(DATA_DIR, 'ui-tests', slugify(component.name));
    await buildMockFor(store.get(id)); // Auto-Mock sicherstellen (Default-UI-Test-Ziel)
    const maintainOpts = { ai, updateDeps: { push: localGitPush(component.path), registry: prRegistry, recordRun: record }, logSink: writeLog, onTestPlan, onSbom, recordRun: record };
    if (opts.autoUpload) { maintainOpts.autoUpload = true; maintainOpts.upload = uploadFor(true); } // Job: bei grün auto-commit (Push nur bei allowPush)
    const r = await maintainComponent(store, store.get(id), maintainOpts);
    const breaking = (r.steps || []).filter((s) => s.step === 'migrate' && s.skipped);
    if (breaking.length && r.skipped !== true) {
      if (!hasPlaywright) r.migration = { skipped: true, reason: 'Playwright not installed — needed for the verified migration (Tests tab → Install Playwright)' };
      else if (ai.kind === 'stub') r.migration = { skipped: true, reason: 'No AI backend — needed for the migration (Settings → Test connection)' };
      else {
        let comp = store.get(id);
        if (!comp.baseline || !(comp.baseline.green > 0)) { await captureBaseline(store, comp, { specsDir, hasPlaywright, onBaseline }); comp = store.get(id); }
        if (comp.baseline && comp.baseline.green > 0) {
          r.migration = await redevelopComponent(store, store.get(id), { ai, specsDir, hasPlaywright, reviewFix: dualReviewFix, upload: uploadFor(true), acceptanceContract: readAcceptance(store.get(id)?.path), runMockSelfTests, mockUrl: `http://localhost:${port}/mock/${slugify(store.get(id).name)}/index.html` });
          const fresh = store.get(id); r.after = fresh.status; r.rebuilt = !!fresh.rebuilt;
        } else {
          r.migration = { skipped: true, reason: comp.baseline ? 'Mock baseline not green — migration cannot be verified “as before” (the mock does not load the plugin cleanly)' : 'No baseline could be captured' };
        }
      }
    }
    // B-19: nach erfolgreichem Adopt die Erkennung auffrischen, damit Libs/Status/Badges die NEUEN
    // (getauschten) Versionen zeigen und „vulnerable/outdated" verschwindet (rebuilt-Flag bleibt).
    if (r.rebuilt) {
      try { runComponentOnce(store, store.get(id), { scan: scanRepo, logSink: writeLog, onTestPlan, onSbom }); } catch { /* egal */ }
      try { const enr = await checkLibrariesOnline(store.get(id).libs || []); store.update(id, { libs: enr, libWarning: libWarningFrom(enr) }); } catch { /* offline → später */ }
    }
    return r;
    } finally { RUNNING.delete(id); }
  };

  // API-Kontexte (T-32/T-34, F-18, F-19)
  const apiCtx = { store, gather: defaultGather, opener: {}, scan: scanRepo, logSink: writeLog, onTestPlan, onSbom };
  const metaCtx = {
    settings,
    store,
    scan: scanRepo,
    recordRun: record,
    logSink: writeLog,
    onTestPlan,
    onSbom,
    syncRepo: (repoConfig) => syncRepo(repoConfig, { workDir: settings.workDir, store }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;

    // Helfer fuer /api/components/:id/<action>-Routen: id parsen, Komponente holen, 404 + try/catch→500 zentral.
    const withComponent = async (fn) => {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try { return await fn(c, id); }
      catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    };
    // Wie withComponent, markiert die Komponente aber als „läuft gerade" (F-29) für lange Operationen
    // (clone/maintain/migrate/autofix/baseline/ui-tests) → GUI-Spinner auch nach Reload / extern gestartet.
    const withComponentRunning = async (fn) => {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      RUNNING.add(id);
      try { return await fn(c, id); }
      catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
      finally { RUNNING.delete(id); STEP.delete(id); }
    };

    // Web-GUI + Doku
    if (p === '/' || p === '/app.html') return serveFile(res, path.join(__dirname, 'public', 'app.html'), 'text/html');

    // Auto-Mock-Seiten statisch ausliefern (F-28/T-97/T-99): /mock/<slug>/... → <repo>/.maintenance/mock/...
    if (p.startsWith('/mock/')) {
      const rest = decodeURIComponent(p.slice('/mock/'.length));
      const sl = rest.split('/')[0];
      const sub = rest.slice(sl.length + 1) || 'index.html';
      const comp = store.list().find((x) => slugify(x.name) === sl);
      if (!comp?.path) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('mock not found'); }
      const base = path.normalize(path.join(comp.path, '.maintenance', 'mock'));
      const target = path.normalize(path.join(base, sub || 'index.html'));
      if (!target.startsWith(base)) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(target)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('mock not found'); }
      const ext = path.extname(target).toLowerCase();
      const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': `${ct}; charset=utf-8` });
      return res.end(fs.readFileSync(target));
    }
    if (p === '/readme.html') return serveFile(res, path.join(__dirname, 'readme.html'), 'text/html');

    // Health/Build-Marker: das Frontend vergleicht ihn mit seinem APP_BUILD und warnt bei Abweichung
    // F-29: welche Komponenten gerade einen langen Lauf haben (clone/maintain/migrate/…) → GUI-Spinner
    if (p === '/api/running') return json(res, { running: [...RUNNING], steps: Object.fromEntries(STEP), lastScheduledRunAt, scheduledRunning });

    if (p === '/api/health') return json(res, { ok: true, build: BUILD, hasPlaywright: fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test')), aiReady: resolveAiBackend(settings, secretStore).kind !== 'stub', features: ['vendored-libs', 'sbom', 'deep-tests', 'maintain', 'web-libcheck', 'ui-tests', 'pr-upload', 'lib-update', 'auto-repair', 'characterization', 'redev', 'licenses'] });

    // Playwright aus der App installieren (F-28/T-96): npm i -D @playwright/test + Browser → async
    if (p === '/api/playwright/install' && req.method === 'POST') {
      try {
        const sh = process.platform === 'win32';
        const run = (cmd, args) => new Promise((resolve) => {
          const ch = childSpawn(cmd, args, { cwd: __dirname, shell: sh });
          let out = '';
          ch.stdout?.on('data', (d) => { out += d; });
          ch.stderr?.on('data', (d) => { out += d; });
          ch.on('error', (e) => resolve({ code: -1, out: out + String(e?.message ?? e) }));
          ch.on('close', (code) => resolve({ code: code ?? -1, out }));
        });
        const step1 = await run('npm', ['i', '-D', '@playwright/test']);
        const step2 = step1.code === 0 ? await run('npx', ['playwright', 'install', 'chromium']) : { code: -1, out: 'skipped (npm install failed)' };
        const ok = step1.code === 0 && step2.code === 0;
        return json(res, { ok, hasPlaywright: fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test')), log: (step1.out + '\n' + step2.out).slice(-8000) }, ok ? 200 : 500);
      } catch (err) { return json(res, { ok: false, error: String(err?.message ?? err) }, 500); }
    }

    // KI-Backend: Verbindung testen / Key hinterlegen
    if (p === '/api/ai/test' && req.method === 'POST') {
      try {
        const be = resolveAiBackend(settings, secretStore);
        const r = be.testConnection ? await be.testConnection() : { ok: true, note: be.kind };
        return json(res, { kind: be.kind, ...r });
      } catch (err) { return json(res, { ok: false, error: String(err?.message ?? err) }, 200); }
    }
    if (p === '/api/ai/key' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.key) return json(res, { error: 'key fehlt' }, 400);
      secretStore.set('ai-key', body.key);
      settings.aiBackend = { ...(settings.aiBackend ?? { kind: 'provider' }), secretRef: 'ai-key' };
      saveSecrets(); saveSettings();
      return json(res, { ok: true, aiBackend: aiBackendView(settings) });
    }

    // SMTP-Passwort verschlüsselt hinterlegen
    if (p === '/api/smtp/pass' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.pass) return json(res, { error: 'pass fehlt' }, 400);
      secretStore.set('smtp-pass', body.pass); saveSecrets();
      return json(res, { ok: true });
    }
    // Report jetzt senden — nur wenn SMTP & Empfänger konfiguriert sind
    if (p === '/api/report/send' && req.method === 'POST') {
      if (!settings.smtp?.host || !settings.recipients?.length) {
        return json(res, { ok: false, configured: false, error: 'E-Mail nicht konfiguriert — SMTP-Host und Empfänger in den Einstellungen hinterlegen.' }, 200);
      }
      try {
        const report = buildReport();
        let pass; try { pass = secretStore.get('smtp-pass'); } catch {}
        const r = await sendReportMail(report, { smtp: settings.smtp, pass, recipients: settings.recipients });
        return json(res, { ok: true, ...r });
      } catch (err) { return json(res, { ok: false, error: String(err?.message ?? err) }, 200); }
    }

    // Autonomes Review & Fix (nutzt konfiguriertes KI-Backend)
    if (p.startsWith('/api/components/') && p.endsWith('/autoreview') && req.method === 'POST') return withComponent(async (c) => {
      const ai = resolveAiBackend(settings, secretStore);
      const r = await autoReviewFix(store, c, { ai });
      return json(res, r, r?.error ? 400 : 200);
    });

    // Protokoll-Archiv: Liste bzw. einzelne Logdatei (auch von Läufen ohne offene GUI)
    if (p.startsWith('/api/components/') && /\/logs(\/|$)/.test(p) && req.method === 'GET') {
      const parts = p.split('/'); const id = parts[3]; const name = parts[5];
      const cc = store.get(id);
      if (!cc) return json(res, { error: 'not found' }, 404);
      const d = compLogDir(cc);
      if (name) {
        const f = path.join(d, path.basename(decodeURIComponent(name)));
        if (!fs.existsSync(f)) return json(res, { error: 'not found' }, 404);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(fs.readFileSync(f));
      }
      let files = [];
      try { files = fs.readdirSync(d).filter((x) => x.endsWith('.log')).sort().reverse(); } catch {}
      return json(res, files.map((fn) => ({ name: fn, at: new Date(Number(fn.replace('.log', '')) || 0).toISOString() })));
    }

    // Testplan neu erzeugen (Baseline überschreiben — „erst wenn ich erweitere")
    if (p.startsWith('/api/components/') && p.endsWith('/testplan') && req.method === 'POST') return withComponent(async (cc) => {
      const r = runComponentOnce(store, cc, { scan: scanRepo, logSink: writeLog, onTestPlan, onSbom, regenerateTestPlan: true });
      return json(res, { ok: true, testPlanChanged: r.testPlanChanged });
    });

    // Repo einem Plugin zuordnen (F-21) → async
    if (p.startsWith('/api/components/') && p.endsWith('/assign-repo') && req.method === 'POST') return withComponentRunning(async (c, id) => {
      const body = await readBody(req);
      const r = await assignRepoToComponent(store, id, body || {}, { workDir: settings.workDir, secretStore });
      saveSecrets(); // ggf. neu hinterlegtes Token verschlüsselt persistieren
      if (!r?.error) {
        // Libraries/Typ/Format SOFORT erkennen (read-only) — sonst bleibt die LIBRARIES-Spalte nach dem Import
        // leer bis zum nächsten Check. Gleiche Aufrufe wie die Post-Update-Auffrischung → konsistente Anzeige.
        try { runComponentOnce(store, store.get(id), { scan: scanRepo, logSink: writeLog, onTestPlan, onSbom }); } catch { /* Erkennung best effort */ }
        try {
          const enr = await checkLibrariesOnline(store.get(id).libs || []); store.update(id, { libs: enr, libWarning: libWarningFrom(enr) });
          runComponentOnce(store, store.get(id), { scan: scanRepo, logSink: writeLog, onTestPlan, onSbom }); // nach Web-Check neu zusammenfassen → Status/SUMMARY konsistent zu „outdated"
        } catch { /* offline → Web-Aktualität später */ }
        const mu = await buildMockFor(store.get(id), { force: true }); if (mu) r.mockUrl = mu; // KI-Mock nach Clone (T-97/T-101)
        r.libs = (store.get(id).libs || []).length;
      }
      return json(res, r, r?.error ? 400 : 200);
    });

    // Auto-Update je Komponente (F-20) → async, vor dem synchronen Handler
    if (p.startsWith('/api/components/') && p.endsWith('/update') && req.method === 'POST') return withComponentRunning(async (c, id) => {
      const body = await readBody(req);
      // 0) Aktualität sicherstellen (latest/outdated), damit vendored-Updates erkannt werden
      try { const enr = await checkLibrariesOnline(store.get(id).libs || []); store.update(id, { libs: enr }); } catch { /* offline → weiter */ }
      // 1) URL-basierte Updates (CDN-Refs gegen Vuln-DB). SICHERHEIT: Push nur bei settings.allowPush (T-76)
      const r = await autoUpdateComponent(store, store.get(id), { push: settings.allowPush ? localGitPush(c.path) : undefined, registry: prRegistry, recordRun: record });
      // 2) Vendored-Datei-Updates: safe immer; breaking nur mit force (Nutzer bestätigt, Backup vorhanden)
      const vend = await applyVendoredUpdates(c.path, store.get(id).libs || [], { force: !!body?.force });
      if (vend.results.some((x) => x.applied)) {
        runComponentOnce(store, store.get(id), { scan: scanRepo, logSink: writeLog, onTestPlan, onSbom }); // neu erkennen nach Swap
        try { const enr2 = await checkLibrariesOnline(store.get(id).libs || []); store.update(id, { libs: enr2 }); } catch { /* offline */ }
      }
      const { branchRegistry, ...out } = r;
      return json(res, { ...out, vendored: vend.results, forced: !!body?.force, backups: [...vend.backups.keys()].length });
    });

    // Bibliotheks-Aktualität aus dem Web prüfen (T-59) → async
    if (p.startsWith('/api/components/') && p.endsWith('/libraries/check') && req.method === 'POST') return withComponent(async (c, id) => {
      const enriched = await checkLibrariesOnline(c.libs || []);
      store.update(id, { libs: enriched });
      return json(res, { ok: true, libs: enriched });
    });

    // Upload: Änderungen als neuer Branch + Commit + (optional) Push, PR-Link zurück (T-76) → async
    if (p.startsWith('/api/components/') && p.endsWith('/upload') && req.method === 'POST') return withComponent(async (c, id) => {
      const r = await uploadFor(true)(c); // push nur, wenn settings.allowPush
      if (r.ok) store.update(id, { reviewUrl: r.prUrl ?? null, reviewBranch: r.branch ?? null });
      return json(res, { ...r, pushAllowed: !!settings.allowPush });
    });

    // Coded-UI-Tests (Playwright) live ausführen (T-73) — nur GUI-getriggert, NICHT im Job → async
    if (p.startsWith('/api/components/') && p.endsWith('/ui-tests') && req.method === 'POST') return withComponentRunning(async (c, id) => {
      const body = await readBody(req);
      const url = (body?.url || c.uiTestUrl || '').trim();
      if (url && url !== c.uiTestUrl) store.update(id, { uiTestUrl: url });
      const hasPlaywright = fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test'));
      const r = await runUiTests(store.get(id), { pluginUrl: url, specsDir: path.join(DATA_DIR, 'ui-tests', slugify(c.name)), hasPlaywright });
      return json(res, r);
    });

    // Charakterisierungs-Baseline aufnehmen (F-28/T-92): Ist-Verhalten als Spec festnageln → async
    if (p.startsWith('/api/components/') && p.endsWith('/baseline') && req.method === 'POST') return withComponentRunning(async (c, id) => {
      const body = await readBody(req);
      const url = (body?.url || c.uiTestUrl || '').trim();
      if (url && url !== c.uiTestUrl) store.update(id, { uiTestUrl: url });
      const hasPlaywright = fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test'));
      const b = await captureBaseline(store, store.get(id), { pluginUrl: url, specsDir: path.join(DATA_DIR, 'ui-tests', slugify(c.name)), hasPlaywright, onBaseline });
      return json(res, b);
    });

    // Re-Dev/Migration gegen die Spec (F-28/T-93): KI migriert → UI-Gate → Übernahme nur „grün wie zuvor" → async
    if (p.startsWith('/api/components/') && p.endsWith('/redevelop') && req.method === 'POST') return withComponentRunning(async (c) => {
      const ai = resolveAiBackend(settings, secretStore);
      const hasPlaywright = fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test'));
      const r = await redevelopComponent(store, c, {
        ai,
        pluginUrl: c.uiTestUrl,
        specsDir: path.join(DATA_DIR, 'ui-tests', slugify(c.name)),
        hasPlaywright,
        reviewFix: dualReviewFix, // T-119/2: 2 unabhängige Review-Voten + Rework vor dem works-as-before-Gate
        // T-122: works-as-before-Gate über den Akzeptanz-Vertrag, falls vorhanden (Plugins ohne Playwright-Baseline)
        acceptanceContract: readAcceptance(c.path),
        runMockSelfTests,
        mockUrl: `http://localhost:${port}/mock/${slugify(c.name)}/index.html`,
        upload: uploadFor(true), // Push nur bei settings.allowPush (T-76)
      });
      return json(res, r, r?.error ? 400 : 200);
    });

    // F-30/T-118 — Tote-Lib-Neuentwicklung: slice-weise gegen den Akzeptanz-Vertrag neu bauen (tech-frei,
    // lizenz-gegatet), je Slice KI-Implementierung + Mock-Selbsttest; Übernahme nur „grün wie zuvor", sonst Rollback.
    if (p.startsWith('/api/components/') && p.endsWith('/redevelop-dead-lib') && req.method === 'POST') return withComponentRunning(async (c, id) => {
      const ai = resolveAiBackend(settings, secretStore);
      if (!ai || ai.kind === 'stub') return json(res, { error: 'Kein KI-Backend (Einstellungen → KI).' }, 400);
      const dir = c.path;
      if (!dir || !fs.existsSync(dir)) return json(res, { error: 'Kein Repo zugeordnet.' }, 400);
      const sl = slugify(c.name);
      const mockUrl = `http://localhost:${port}/mock/${sl}/index.html`;
      const contract = readAcceptance(dir);
      const backups = new Map();
      // Eine Slice (= Sicht) implementieren: KI baut die Funktionalität tech-frei/lizenzrein neu, re-injiziert
      // in das primäre Plugin-Asset. Backups je Datei → vollständiger Rollback bei Misserfolg.
      const implementSlice = async (slice, ctx) => {
        setStep(id, `Redev Slice „${slice.view}"`);
        const asset = inspectAssets(dir).find((a) => a.origin);
        if (!asset) return;
        let out = '';
        try { out = String(await ai.complete(buildSliceRebuildPrompt(slice, contract, { name: c.name, deadLib: ctx.deadLib }), {})); } catch { return; }
        out = out.replace(/^```[a-z]*\n?|```$/g, '').trim();
        if (!out || !parseOk(out) || out === asset.code.trim()) return;
        const tgt = asset.origin.type === 'file' ? path.join(dir, asset.origin.path) : path.join(dir, asset.origin.sqlFile);
        if (!backups.has(tgt) && fs.existsSync(tgt)) backups.set(tgt, fs.readFileSync(tgt, 'utf8'));
        reinjectAsset(asset.origin, out, { rootDir: dir });
      };
      const runSelfTests = async () => { await buildMockFor(store.get(id), { force: true }); return runMockSelfTests(mockUrl, { timeoutMs: 14000 }); };
      const rollbackAll = async () => { for (const [t, content] of backups) { try { fs.writeFileSync(t, content); } catch { /* ignore */ } } try { await buildMockFor(store.get(id), { force: true }); } catch { /* ignore */ } };
      const r = await redevelopDeadLib(store, store.get(id), {
        ai, contract, implementSlice, runSelfTests, rollbackAll,
        log: (m) => { writeLog(c, `[redev-dead-lib] ${m}`); setStep(id, `Redev: ${m}`); },
      });
      return json(res, r, r?.error ? 400 : 200);
    });

    // F-30/T-120 — Akzeptanzkriterien exportieren: ?format=json|feature|devhub. Liest acceptance.json
    // oder leitet sie LIVE aus dem Mock-Selbsttest ab (kein KI nötig). devhub-tauglich (Gherkin) + Datei.
    if (p.startsWith('/api/components/') && p.endsWith('/acceptance') && req.method === 'GET') return withComponent(async (c) => {
      const fmt = (url.searchParams.get('format') || 'json').toLowerCase();
      let contract = readAcceptance(c.path);
      if (!contract || !(contract.criteria || []).length) {
        const sl0 = slugify(c.name); const mockUrl = `http://localhost:${port}/mock/${sl0}/index.html`;
        try { const st = await runMockSelfTests(mockUrl, { timeoutMs: 14000 }); if (st.ran) { contract = acceptanceFromSelfTest(st, { name: c.name, at: new Date().toISOString() }); if (!contract.error) writeAcceptance(c.path, contract); } } catch { /* kein Mock/Playwright */ }
      }
      if (!contract || contract.error || !(contract.criteria || []).length) return json(res, { error: 'Kein Akzeptanz-Vertrag — erst einen grünen Mock bauen (Plugin importieren/„Open mock").' }, 400);
      const fn = slugify(c.name);
      if (fmt === 'feature') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${fn}.acceptance.feature"` }); return res.end(acceptanceFeatureFile(contract, { name: c.name })); }
      if (fmt === 'devhub') return json(res, acceptanceToDevhub(contract, { name: c.name }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${fn}.acceptance.json"` }); return res.end(JSON.stringify(contract, null, 2));
    });

    // SBOM (CycloneDX) der Komponente — für Review/Visualisierung (T-69) → GET
    if (p.startsWith('/api/components/') && p.endsWith('/sbom') && req.method === 'GET') return withComponent(async (c) => {
      const sbom = buildSbom(c.name, (c.libs || []).map((l) => ({ name: l.name, version: l.version, detectedBy: l.detectedBy || 'erkannt', evidence: l.source || l.evidence || '' })));
      // Status/Quelle als zusätzliche Properties anreichern (für Review-Auswertung)
      sbom.components.forEach((comp, i) => {
        const l = (c.libs || [])[i];
        if (l) comp.properties.push({ name: 'status', value: l.status || 'unbekannt' }, ...(l.source ? [{ name: 'source', value: l.source }] : []), ...(l.latest ? [{ name: 'latest', value: l.latest }] : []));
      });
      return json(res, sbom);
    });

    // Alles automatisch beheben (T-61) → async
    if (p.startsWith('/api/components/') && p.endsWith('/autofix') && req.method === 'POST') return withComponentRunning(async (c) => {
      const ai = resolveAiBackend(settings, secretStore);
      const r = await autoFixComponent(store, c, {
        ai,
        updateDeps: { push: localGitPush(c.path), registry: prRegistry, recordRun: record },
        logSink: writeLog,
      });
      return json(res, r, r?.error ? 400 : 200);
    });

    // Vollständige Pflege (manuell = automatisch) — eine Orchestrierung (T-66) → async
    if (p.startsWith('/api/components/') && p.endsWith('/maintain') && req.method === 'POST') return withComponent(async (c, id) => {
      const r = await fullMaintain(store.get(id)); // fullMaintain managt RUNNING selbst (auch für autonome Läufe)
      return json(res, r, r?.error ? 400 : 200);
    });

    // Bibliothek manuell hinzufügen (T-67) → async
    if (p.startsWith('/api/components/') && p.endsWith('/libraries') && req.method === 'POST') return withComponent(async (c, id) => {
      const body = await readBody(req);
      if (!body?.name) return json(res, { error: 'Name fehlt' }, 400);
      const lib = { name: String(body.name), version: String(body.version || ''), status: 'unbekannt', detectedBy: 'manuell', source: body.source || null };
      const libs = [...(c.libs || []), lib];
      store.update(id, { libs });
      return json(res, { ok: true, libs });
    });

    // Komponenten-Verwaltung (T-34) → synchroner REST-Handler
    if (p.startsWith('/api/components')) {
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : null;
      try {
        const { status, body: out } = apiHandler(req.method, p, body, apiCtx);
        return json(res, out, status);
      } catch (err) {
        return json(res, { error: String(err?.message ?? err) }, 500);
      }
    }

    // Arbeitsverzeichnis & Repo-Anbindung (F-18) + Lauf (F-19) → async Handler
    if (p === '/api/settings' || p.startsWith('/api/repos') || p === '/api/run' || p === '/api/libraries') {
      const body = req.method !== 'GET' ? await readBody(req) : null;
      try {
        const { status, body: out } = await metaApiHandler(req.method, p, body, metaCtx);
        if (req.method !== 'GET' && (p === '/api/settings' || p.startsWith('/api/repos'))) saveSettings();
        return json(res, out, status);
      } catch (err) {
        return json(res, { error: String(err?.message ?? err) }, 500);
      }
    }

    // Status/Diagnose
    if (p === '/api/dashboard') return json(res, { repos: settings.repos, runs: listRuns(history) });
    if (p === '/api/scan') {
      const repoPath = url.searchParams.get('path');
      if (!repoPath || !fs.existsSync(repoPath)) return json(res, { error: 'path fehlt/ungültig' }, 400);
      return json(res, scanRepo(repoPath));
    }
    if (p === '/api/trigger') {
      const r = scheduler.submit(url.searchParams.get('repo'), { now: undefined, trigger: 'manual' });
      return json(res, r.done ? { accepted: true } : r);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(c('bold', `\n  Plugin Maintenance — Web-GUI: http://localhost:${port}`));
    console.log(c('dim', '  GUI: /   ·   Doku: /readme.html'));
    console.log(c('dim', '  API: /api/components (CRUD, /:id/notes, /:id/review, /:id/open) · /api/scan?path= · /api/dashboard'));
    console.log(c('dim', '  Beenden mit Strg+C.\n'));
  });

  // Zeitplan: jede Minute prüfen, ob der automatische Lauf fällig ist (Cron, settings.schedule).
  // STANDALONE-Pflege: der geplante Lauf macht die VOLLE Pflege (fullMaintain inkl. verifizierter
  // Lib-Migration) für jede verwaltete Komponente — nicht nur scannen — und mailt danach den Report.
  let lastTick = '';
  let scheduledRunning = false;
  let lastScheduledRunAt = null; // Zeitstempel des letzten abgeschlossenen automatischen Laufs (für die GUI-Header-Region)
  setInterval(() => {
    try {
      if (!settings.scheduleEnabled || !settings.schedule) return;
      const now = new Date();
      const stamp = now.toISOString().slice(0, 16);
      if (stamp === lastTick || !cronMatches(settings.schedule, now)) return;
      lastTick = stamp;
      if (scheduledRunning) return; // vorheriger geplanter Lauf noch aktiv → überspringen
      scheduledRunning = true;
      console.log(c('dim', `  [${now.toLocaleString('de-DE')}] geplanter Pflege-Lauf läuft …`));
      (async () => {
        try {
          for (const comp of store.list()) {
            if (!comp.path || !fs.existsSync(comp.path)) continue; // nur angebundene Komponenten
            try { await fullMaintain(comp, { autoUpload: true }); }
            catch (err) { record({ id: `sched-${comp.id}-${history.runs.length + 1}`, status: 'red', failures: [{ artifact: comp.name, reason: String(err?.message ?? err) }] }); }
          }
          if (settings.recipients?.length && settings.smtp?.host) {
            let pass; try { pass = secretStore.get('smtp-pass'); } catch {}
            await sendReportMail(buildReport(), { smtp: settings.smtp, pass, recipients: settings.recipients }).catch(() => {});
          }
        } finally { scheduledRunning = false; lastScheduledRunAt = new Date().toISOString(); }
      })();
    } catch { scheduledRunning = false; }
  }, 60000);
}

function serveFile(res, file, type) {
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('readme.html noch nicht erzeugt');
  }
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(fs.readFileSync(file));
}
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}
// node start.js test [name] — Tests für ALLE verwalteten Plugins/Template-Komponenten (nicht die App)
function cmdTest(filter) {
  const store = createComponentStore({ file: path.join(DATA_DIR, 'components.json') });
  let comps = store.list();
  if (filter) comps = comps.filter((x) => x.name.toLowerCase().includes(String(filter).toLowerCase()));
  if (comps.length === 0) {
    console.log(c('yellow', `\n  Keine ${filter ? `passende ` : ''}verwalteten Plugins/Template-Komponenten gefunden.\n`));
    return;
  }
  console.log(c('bold', `\n  Plugin Maintenance — Tests für ${comps.length} verwaltete Komponente(n)\n`));
  const { results, green, red, skipped, ok } = runComponentTests(comps, { scan: scanRepo });
  for (const r of results) {
    if (r.verdict === 'skipped') {
      console.log(`  ${c('yellow', '● übersprungen')} ${c('bold', r.name)} ${c('dim', `(${r.reason})`)}`);
      continue;
    }
    const tag = r.verdict === 'red' ? c('red', '● rot') : c('green', '● grün');
    console.log(`  ${tag} ${c('bold', r.name)} ${c('dim', `[${r.format ?? '—'}]`)} — ${r.scenarios} Szenario(en), Security ${r.security}, Code ${r.quality}, Schwachstellen ${r.vulnerabilities}`);
    for (const f of r.failures) console.log(c('red', `      ✗ ${f.artifact}: ${f.reason}`));
  }
  console.log(c('bold', `\n  Ergebnis: ${c('green', green + ' grün')}, ${c(red ? 'red' : 'dim', red + ' rot')}, ${skipped} übersprungen\n`));
  process.exitCode = ok ? 0 : 1;
}

function fail(msg) {
  console.error(c('red', `\n  ${msg}\n`));
  process.exitCode = 1;
}
function help() {
  console.log(`
  ${c('bold', 'Plugin Maintenance')}

  node start.js scan <repo-pfad>     Einmaliger read-only Pflege-Lauf (Analyse/SBOM/Risiko/Triage)
  node start.js test [name]           Tests ALLER verwalteten Plugins/Template-Komponenten ausführen
  node start.js serve [port]          Dienst: Scheduler + Mini-Web-GUI (Default-Port 4317)
  node start.js help                  Diese Hilfe
`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'scan': cmdScan(arg); break;
  case 'test': cmdTest(arg); break;
  case 'serve': cmdServe(arg); break;
  case 'help': case undefined: help(); break;
  default: fail(`Unbekannter Befehl: ${cmd}`); help();
}
