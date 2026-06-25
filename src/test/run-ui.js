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
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs ?? 180000);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message ?? e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
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
  for (const s of specs) fs.writeFileSync(path.join(dir, s.name), s.content);
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
  for (const s of specs) fs.writeFileSync(path.join(dir, s.name), s.content);

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
