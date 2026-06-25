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
import { fileURLToPath } from 'node:url';
import { scanRepo } from './src/service/run-repo.js';
import { createScheduler } from './src/service/scheduler.js';
import { createHistory, recordRun, listRuns } from './src/report/history.js';
import { createSettings } from './src/config/settings.js';
import { createComponentStore } from './src/gui/store.js';
import { apiHandler, metaApiHandler } from './src/gui/api.js';
import { defaultGather } from './src/gui/components.js';
import { syncRepo } from './src/service/workspace.js';
import { runManaged } from './src/service/run-component.js';
import { autoUpdateComponent } from './src/service/update-component.js';
import { assignRepoToComponent } from './src/service/assign-repo.js';
import { autoReviewFix } from './src/service/autoreview.js';
import { checkLibrariesOnline } from './src/service/lib-check.js';
import { buildSbom } from './src/sbom/sbom.js';
import { autoFixComponent } from './src/service/autofix.js';
import { maintainComponent } from './src/service/maintain.js';
import { runUiTests } from './src/test/run-ui.js';
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
const BUILD = '2026-06-25.3';
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
  const saveSettings = () => {
    try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch {}
  };

  const history = createHistory();
  const store = createComponentStore({ file: path.join(DATA_DIR, 'components.json') });
  const record = (entry) => recordRun(history, entry);

  // Prüfprotokoll-Archiv je Komponente (F-22) — bleibt auch erhalten, wenn die GUI zu war
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'plugin';
  const logDir = path.join(DATA_DIR, 'logs');
  const compLogDir = (component) => path.join(logDir, slugify(component.name));
  const writeLog = (component, text) => {
    try { const d = compLogDir(component); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${Date.now()}.log`), text); } catch {}
  };
  // Testplan reproduzierbar als .feature-Datei ablegen
  const testplanDir = path.join(DATA_DIR, 'testplans');
  const onTestPlan = (component, text) => {
    try { fs.mkdirSync(testplanDir, { recursive: true }); fs.writeFileSync(path.join(testplanDir, `${slugify(component.name)}.feature`), text); } catch {}
  };
  // Report aus dem aktuellen Stand aller Komponenten bauen
  const buildReport = () => {
    const comps = store.list();
    const updated = comps.filter((x) => x.lastChange).map((x) => ({ artifact: x.name, change: x.lastChange.summary, testResult: x.status, gitLink: x.source || '' }));
    const risks = comps.filter((x) => x.libWarning).map((x) => ({ name: x.name, label: '⚠ Libs', reasons: [`${x.libWarning.vulnerable || 0} verwundbar, ${x.libWarning.unmaintained || 0} nicht gepflegt`] }));
    const failures = comps.filter((x) => ['zu klären', 'review-blockiert'].includes(x.status)).map((x) => ({ artifact: x.name, reason: x.status }));
    return renderReport({ updated, risks, failures });
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
      // Vollautomatische Pflege = dieselbe Orchestrierung wie der manuelle „Vollständige Pflege"-Button (T-66)
      const ai = resolveAiBackend(settings, secretStore);
      for (const c of store.list().filter((x) => x.repo === repo)) {
        try {
          await maintainComponent(store, c, { ai, updateDeps: { push: localGitPush(c.path), registry: prRegistry, recordRun: record }, logSink: writeLog, onTestPlan, recordRun: record });
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

  // API-Kontexte (T-32/T-34, F-18, F-19)
  const apiCtx = { store, gather: defaultGather, opener: {}, scan: scanRepo, logSink: writeLog, onTestPlan };
  const metaCtx = {
    settings,
    store,
    scan: scanRepo,
    recordRun: record,
    logSink: writeLog,
    onTestPlan,
    syncRepo: (repoConfig) => syncRepo(repoConfig, { workDir: settings.workDir, store }),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const p = url.pathname;

    // Web-GUI + Doku
    if (p === '/' || p === '/app.html') return serveFile(res, path.join(__dirname, 'public', 'app.html'), 'text/html');
    if (p === '/readme.html') return serveFile(res, path.join(__dirname, 'readme.html'), 'text/html');

    // Health/Build-Marker: das Frontend vergleicht ihn mit seinem APP_BUILD und warnt bei Abweichung
    if (p === '/api/health') return json(res, { ok: true, build: BUILD, features: ['vendored-libs', 'sbom', 'deep-tests', 'maintain', 'web-libcheck', 'ui-tests'] });

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
    if (p.startsWith('/api/components/') && p.endsWith('/autoreview') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try {
        const ai = resolveAiBackend(settings, secretStore);
        const r = await autoReviewFix(store, c, { ai });
        return json(res, r, r?.error ? 400 : 200);
      } catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

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
    if (p.startsWith('/api/components/') && p.endsWith('/testplan') && req.method === 'POST') {
      const id = p.split('/')[3]; const cc = store.get(id);
      if (!cc) return json(res, { error: 'not found' }, 404);
      try { const r = runComponentOnce(store, cc, { scan: scanRepo, logSink: writeLog, onTestPlan, regenerateTestPlan: true }); return json(res, { ok: true, testPlanChanged: r.testPlanChanged }); }
      catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

    // Repo einem Plugin zuordnen (F-21) → async
    if (p.startsWith('/api/components/') && p.endsWith('/assign-repo') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      const body = await readBody(req);
      try {
        const r = await assignRepoToComponent(store, id, body || {}, { workDir: settings.workDir, secretStore });
        saveSecrets(); // ggf. neu hinterlegtes Token verschlüsselt persistieren
        return json(res, r, r?.error ? 400 : 200);
      } catch (err) {
        return json(res, { error: String(err?.message ?? err) }, 500);
      }
    }

    // Auto-Update je Komponente (F-20) → async, vor dem synchronen Handler
    if (p.startsWith('/api/components/') && p.endsWith('/update') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try {
        const r = await autoUpdateComponent(store, c, { push: localGitPush(c.path), registry: prRegistry, recordRun: record });
        const { branchRegistry, ...out } = r;
        return json(res, out);
      } catch (err) {
        return json(res, { error: String(err?.message ?? err) }, 500);
      }
    }

    // Bibliotheks-Aktualität aus dem Web prüfen (T-59) → async
    if (p.startsWith('/api/components/') && p.endsWith('/libraries/check') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try {
        const enriched = await checkLibrariesOnline(c.libs || []);
        store.update(id, { libs: enriched });
        return json(res, { ok: true, libs: enriched });
      } catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

    // Coded-UI-Tests (Playwright) live ausführen (T-73) — nur GUI-getriggert, NICHT im Job → async
    if (p.startsWith('/api/components/') && p.endsWith('/ui-tests') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      const body = await readBody(req);
      const url = (body?.url || c.uiTestUrl || '').trim();
      if (url && url !== c.uiTestUrl) store.update(id, { uiTestUrl: url });
      const slug = slugify(c.name);
      const hasPlaywright = fs.existsSync(path.join(__dirname, 'node_modules', '@playwright', 'test'));
      try {
        const r = await runUiTests(store.get(id), { pluginUrl: url, specsDir: path.join(DATA_DIR, 'ui-tests', slug), hasPlaywright });
        return json(res, r);
      } catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

    // SBOM (CycloneDX) der Komponente — für Review/Visualisierung (T-69) → GET
    if (p.startsWith('/api/components/') && p.endsWith('/sbom') && req.method === 'GET') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      const sbom = buildSbom(c.name, (c.libs || []).map((l) => ({ name: l.name, version: l.version, detectedBy: l.detectedBy || 'erkannt', evidence: l.source || l.evidence || '' })));
      // Status/Quelle als zusätzliche Properties anreichern (für Review-Auswertung)
      sbom.components.forEach((comp, i) => {
        const l = (c.libs || [])[i];
        if (l) comp.properties.push({ name: 'status', value: l.status || 'unbekannt' }, ...(l.source ? [{ name: 'source', value: l.source }] : []), ...(l.latest ? [{ name: 'latest', value: l.latest }] : []));
      });
      return json(res, sbom);
    }

    // Alles automatisch beheben (T-61) → async
    if (p.startsWith('/api/components/') && p.endsWith('/autofix') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try {
        const ai = resolveAiBackend(settings, secretStore);
        const r = await autoFixComponent(store, c, {
          ai,
          updateDeps: { push: localGitPush(c.path), registry: prRegistry, recordRun: record },
          logSink: writeLog,
        });
        return json(res, r, r?.error ? 400 : 200);
      } catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

    // Vollständige Pflege (manuell = automatisch) — eine Orchestrierung (T-66) → async
    if (p.startsWith('/api/components/') && p.endsWith('/maintain') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      try {
        const ai = resolveAiBackend(settings, secretStore);
        const r = await maintainComponent(store, c, { ai, updateDeps: { push: localGitPush(c.path), registry: prRegistry, recordRun: record }, logSink: writeLog, onTestPlan, recordRun: record });
        return json(res, r, r?.error ? 400 : 200);
      } catch (err) { return json(res, { error: String(err?.message ?? err) }, 500); }
    }

    // Bibliothek manuell hinzufügen (T-67) → async
    if (p.startsWith('/api/components/') && p.endsWith('/libraries') && req.method === 'POST') {
      const id = p.split('/')[3];
      const c = store.get(id);
      if (!c) return json(res, { error: 'not found' }, 404);
      const body = await readBody(req);
      if (!body?.name) return json(res, { error: 'Name fehlt' }, 400);
      const lib = { name: String(body.name), version: String(body.version || ''), status: 'unbekannt', detectedBy: 'manuell', source: body.source || null };
      const libs = [...(c.libs || []), lib];
      store.update(id, { libs });
      return json(res, { ok: true, libs });
    }

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

  // Zeitplan: jede Minute prüfen, ob der automatische Check fällig ist (Cron, settings.schedule)
  let lastTick = '';
  setInterval(() => {
    try {
      if (!settings.scheduleEnabled || !settings.schedule) return;
      const now = new Date();
      const stamp = now.toISOString().slice(0, 16);
      if (stamp === lastTick || !cronMatches(settings.schedule, now)) return;
      lastTick = stamp;
      console.log(c('dim', `  [${now.toLocaleString('de-DE')}] geplanter Check läuft …`));
      runManaged({ store, scan: scanRepo, recordRun: record, logSink: writeLog, onTestPlan });
      if (settings.recipients?.length && settings.smtp?.host) {
        let pass; try { pass = secretStore.get('smtp-pass'); } catch {}
        sendReportMail(buildReport(), { smtp: settings.smtp, pass, recipients: settings.recipients }).catch(() => {});
      }
    } catch {}
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
