/**
 * T-73 — Coded-UI-Tests (Playwright) live aus der GUI ausführen.
 *
 * Schreibt die für die Komponente generierten *.ui.spec.js in ein Verzeichnis und ruft
 * `npx playwright test` gegen eine Test-URL (Seite mit dem eingebundenen Plugin) auf. Die Ausgabe
 * + bestanden/fehlgeschlagen werden zurückgegeben (für die Live-Anzeige). NICHT Teil des geplanten
 * Jobs — bewusst nur GUI-getriggert. Guards: ohne Specs / ohne URL / ohne Playwright klare Meldung.
 * exec/hasPlaywright sind injizierbar → deterministisch testbar ohne echtes Playwright/Browser.
 *
 * Resultat: src/test/run-ui.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// B-48: KI-generierte Specs werden vor dem Ausführen statisch geprüft. Ein reiner Playwright-DOM-Test
// braucht NIEMALS Node-Fähigkeiten (Prozesse starten, Dateisystem, Netzwerk, eval). Enthält eine Spec
// solche Konstrukte, wird sie NICHT geschrieben/ausgeführt. Unsere eigenen Mock-Specs (nur
// '@playwright/test' + process.env.PLUGIN_URL + DOM) passieren die Prüfung.
const SPEC_DANGER = [
  [/\bchild_process\b/, 'child_process'],
  [/\brequire\s*\(/, 'require()'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\bfrom\s*['"]\s*(?:node:)?(child_process|fs|net|http|https|dns|os|vm|cluster|worker_threads|dgram|tls|repl|inspector|module|process|readline|zlib)\s*['"]/, 'node-core import'],
  [/\b(execSync|spawnSync|spawn|execFile|fork)\s*\(/, 'process spawn'],
  [/\bprocess\s*\.\s*(binding|dlopen|exit|kill|abort|setuid|setgid|chdir)\b/, 'process control'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bfs\s*\.\s*(write|append|unlink|rm|rmdir|mkdir|chmod|chown|createWriteStream|readFile|readdir)/, 'fs access'],
];

/** Statischer Sicherheits-Vorabscan einer generierten Spec. @returns {{safe:boolean, reason?:string}} */
export function scanSpecSafety(content) {
  const src = String(content || '');
  for (const [re, label] of SPEC_DANGER) if (re.test(src)) return { safe: false, reason: label };
  return { safe: true };
}

/** Teilt Specs in ausführbare (safe) und blockierte auf. */
function partitionSafeSpecs(specs) {
  const safe = [], blocked = [];
  for (const s of specs) { const v = scanSpecSafety(s.content); if (v.safe) safe.push(s); else blocked.push({ name: s.name, reason: v.reason }); }
  return { safe, blocked };
}

// Register aktiver Playwright-/UI-Kindprozesse — damit „Abbrechen" den laufenden Test-Run wirklich killt.
const _uiChildren = new Set();

/** Killt alle laufenden UI-/Playwright-Kindprozesse (Abbruch). @returns Anzahl gekillter Prozesse */
export function abortUiChildren() {
  let n = 0;
  for (const c of _uiChildren) { try { c.kill('SIGKILL'); n++; } catch { /* egal */ } }
  return n;
}

function defaultExec(cmd, args, opts) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: process.platform === 'win32' });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
    }
    _uiChildren.add(child);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs ?? 180000);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { _uiChildren.delete(child); clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) }); });
    child.on('close', (code) => { _uiChildren.delete(child); clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Zählt bestanden/fehlgeschlagen aus der Playwright-Ausgabe (list-Reporter + Summary). */
export function parsePlaywrightOutput(out) {
  const text = String(out ?? '');
  const passed = (text.match(/(\d+)\s+passed/i) || [])[1];
  const failed = (text.match(/(\d+)\s+failed/i) || [])[1];
  if (passed != null || failed != null) return { passed: Number(passed ?? 0), failed: Number(failed ?? 0) };
  // Fallback: Markierungen zählen
  return { passed: (text.match(/[✓✔]/g) || []).length, failed: (text.match(/[✘✗×]/g) || []).length };
}

/** Parst den Playwright-JSON-Reporter zu Einzelergebnissen [{scenario,status}] (fuer das Baseline-Gate). */
export function parsePlaywrightJson(out) {
  let data;
  try { data = JSON.parse(String(out ?? '')); } catch { return null; }
  const scenarios = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const statuses = (spec.tests ?? []).flatMap((t) => (t.results ?? []).map((r) => r.status));
      const status = spec.ok ? 'passed' : statuses.includes('failed') || statuses.includes('timedOut') ? 'failed' : statuses.every((s) => s === 'skipped') && statuses.length ? 'skipped' : 'failed';
      scenarios.push({ scenario: spec.title, status });
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of data.suites ?? []) walk(s);
  return scenarios;
}

/**
 * Wie runUiTests, aber liefert Einzelergebnisse je Szenario (Playwright-JSON-Reporter) — fuer die
 * Charakterisierungs-Baseline / das works-as-before-Gate (F-28). Gleiche Guards.
 * @returns {{ran:boolean, reason?:string, ok?:boolean, scenarios?:Array<{scenario,status}>, output?:string}}
 */
export async function runUiTestsDetailed(component, deps = {}) {
  const url = deps.pluginUrl || component?.uiTestUrl || process.env.PLUGIN_URL || '';
  const specs = (component?.codedTests || []).filter((t) => /\.ui\.spec\.js$/i.test(t.name));
  if (!specs.length) return { ran: false, reason: 'Keine Coded-UI-Tests vorhanden — erst „▶ Prüfen" ausführen.' };
  if (!url) return { ran: false, reason: 'Keine Test-URL gesetzt — Seite mit dem eingebundenen Plugin angeben (Feld „UI-Test-URL").' };
  if (deps.hasPlaywright === false) return { ran: false, reason: 'Playwright nicht installiert — einmalig: npm i -D @playwright/test && npx playwright install chromium' };

  const dir = deps.specsDir;
  fs.mkdirSync(dir, { recursive: true });
  // B-48: unsichere Specs vor dem Ausführen aussortieren; B-44: nur den Basename schreiben.
  const { safe, blocked } = partitionSafeSpecs(specs);
  if (!safe.length) return { ran: false, reason: `Alle Coded-UI-Specs von der Sicherheitsprüfung blockiert: ${blocked.map((b) => `${b.name} (${b.reason})`).join('; ')}` };
  for (const s of safe) fs.writeFileSync(path.join(dir, path.basename(s.name)), s.content);
  const exec = deps.exec ?? defaultExec;
  const { code, stdout, stderr } = await exec('npx', ['playwright', 'test', '--reporter=json'], {
    cwd: dir, env: { ...process.env, PLUGIN_URL: url }, timeoutMs: deps.timeoutMs ?? 180000,
  });
  const scenarios = parsePlaywrightJson(stdout) ?? [];
  return { ran: true, ok: code === 0, scenarios, output: `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim().slice(0, 20000) };
}

/**
 * @param {object} component  (mit codedTests:[{name,content}], uiTestUrl?)
 * @param {{pluginUrl?:string, specsDir:string, hasPlaywright?:boolean, exec?:Function}} deps
 */
export async function runUiTests(component, deps = {}) {
  const url = deps.pluginUrl || component?.uiTestUrl || process.env.PLUGIN_URL || '';
  const specs = (component?.codedTests || []).filter((t) => /\.ui\.spec\.js$/i.test(t.name));
  if (!specs.length) return { ran: false, reason: 'Keine Coded-UI-Tests vorhanden — erst „▶ Prüfen" ausführen.' };
  if (!url) return { ran: false, reason: 'Keine Test-URL gesetzt — Seite mit dem eingebundenen Plugin angeben (Feld „UI-Test-URL").' };
  if (deps.hasPlaywright === false) {
    return { ran: false, reason: 'Playwright nicht installiert — einmalig: npm i -D @playwright/test && npx playwright install chromium' };
  }

  const dir = deps.specsDir;
  fs.mkdirSync(dir, { recursive: true });
  // B-48: unsichere Specs aussortieren; B-44: nur den Basename schreiben.
  const { safe, blocked } = partitionSafeSpecs(specs);
  if (!safe.length) return { ran: false, reason: `Alle Coded-UI-Specs von der Sicherheitsprüfung blockiert: ${blocked.map((b) => `${b.name} (${b.reason})`).join('; ')}` };
  for (const s of safe) fs.writeFileSync(path.join(dir, path.basename(s.name)), s.content);

  const exec = deps.exec ?? defaultExec;
  const { code, stdout, stderr } = await exec('npx', ['playwright', 'test', '--reporter=list'], {
    cwd: dir,
    env: { ...process.env, PLUGIN_URL: url },
    timeoutMs: deps.timeoutMs ?? 180000,
  });
  const output = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
  const { passed, failed } = parsePlaywrightOutput(output);
  return { ran: true, ok: code === 0, passed, failed, url, output: output.slice(0, 20000) };
}
