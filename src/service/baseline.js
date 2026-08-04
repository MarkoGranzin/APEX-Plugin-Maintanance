/**
 * F-28 (T-92) — Charakterisierungs-Baseline: das Ist-Verhalten des funktionierenden Plugins
 * als Spec festnageln. Fuehrt die generierten Coded-UI-Tests (Playwright, T-64/T-73) gegen die
 * konfigurierte UI-Test-URL aus und persistiert je Szenario passed/failed + einen Spec-Hash.
 * Ohne Playwright/URL: degradierter Fallback aus dem letzten Pruefprotokoll (klar markiert).
 *
 * compareToBaseline() vergleicht spaeter neue Ergebnisse gegen die Baseline (works-as-before, T-91).
 *
 * Resultat: src/service/baseline.js
 */

import crypto from 'node:crypto';
import { runUiTestsDetailed } from '../test/run-ui.js';
import { worksAsBefore } from './works-as-before.js';
import { captureShot } from '../test/visual.js';

/** Stabiler Hash ueber die UI-Spec-Inhalte — erkennt, ob die Baseline noch zur Spec passt. */
export function specHashOf(codedTests = []) {
  const ui = codedTests.filter((t) => /\.ui\.spec\.js$/i.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const h = crypto.createHash('sha256');
  for (const t of ui) h.update(t.name + '\0' + (t.content ?? ''));
  return h.digest('hex').slice(0, 16);
}

/**
 * Nimmt die Baseline auf und schreibt sie in den Store (+ optionaler onBaseline-Sink).
 * @param {object} store
 * @param {object} comp
 * @param {{pluginUrl?:string, specsDir?:string, hasPlaywright?:boolean, exec?:Function, now?:Function, onBaseline?:Function, runDetailed?:Function}} deps
 */
export async function captureBaseline(store, comp, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const runDetailed = deps.runDetailed ?? runUiTestsDetailed;
  const url = deps.pluginUrl || comp.uiTestUrl || '';
  const hasUiSpecs = (comp.codedTests || []).some((t) => /\.ui\.spec\.js$/i.test(t.name));
  const specHash = specHashOf(comp.codedTests || []);

  let mode = 'ui';
  let scenarios = [];
  let note = '';

  if (hasUiSpecs && url && deps.hasPlaywright !== false) {
    const r = await runDetailed(comp, { pluginUrl: url, specsDir: deps.specsDir, hasPlaywright: deps.hasPlaywright, exec: deps.exec, timeoutMs: deps.timeoutMs });
    if (r.ran) scenarios = r.scenarios ?? [];
    else { mode = 'static'; note = r.reason || ''; }
  } else {
    mode = 'static';
    note = !hasUiSpecs ? 'Keine Coded-UI-Tests — erst Prüfen ausführen' : !url ? 'Keine UI-Test-URL gesetzt' : 'Playwright nicht verfügbar';
  }

  if (mode === 'static') {
    // Degradierter Fallback: Test-Einträge aus dem letzten Protokoll als grobe Baseline
    scenarios = (comp.lastLog?.entries ?? [])
      .filter((e) => e.agent === 'Test')
      .map((e, i) => ({ scenario: e.file || `test-${i}`, status: /rot|fail|fehl/i.test(e.result || '') ? 'failed' : 'passed' }));
  }

  const green = scenarios.filter((s) => s.status === 'passed').length;
  if (!green && !note) note = 'no green scenarios — set a UI test URL and make the UI tests pass before this is a usable baseline';
  // T-104: initialen Screenshot des Ist-Stands aufnehmen — Grundlage für die optische „sieht aus wie zuvor"-Prüfung.
  let shot = null;
  if (url && deps.hasPlaywright !== false && deps.specsDir) {
    try { const r = await (deps.captureShot ?? captureShot)(url, `${deps.specsDir}/baseline-shot.png`, {}); if (r.ok) shot = r.path; } catch { /* Screenshot best effort */ }
  }
  const baseline = { at: now(), mode, specHash, note, green, total: scenarios.length, scenarios, shot };
  store.update(comp.id, { baseline });
  if (deps.onBaseline) { try { deps.onBaseline(comp, baseline); } catch { /* Datei-Fehler nicht eskalieren */ } }
  return baseline;
}

/** Vergleicht neue Spec-Ergebnisse gegen die gespeicherte Baseline (works-as-before, T-91). */
export function compareToBaseline(comp, currentScenarios) {
  const baseline = comp?.baseline;
  if (!baseline || !baseline.scenarios?.length) {
    return { pass: false, regressions: [], newlyGreen: [], summary: 'no baseline captured — run “Capture baseline” on the working build first', noBaseline: true };
  }
  // Rote Baseline (kein vorher-grünes Szenario) → das Gate kann „wie zuvor" NICHT verifizieren
  // (es gäbe nichts zu schützen). Nicht stillschweigend „pass", sondern ablehnen.
  const greenBaseline = baseline.scenarios.filter((s) => s.status === 'passed').length;
  if (!greenBaseline) {
    return { pass: false, regressions: [], newlyGreen: [], noGreenBaseline: true, mode: baseline.mode, summary: 'baseline has no green scenarios — capture a baseline on a WORKING build first (the UI tests must pass before migrating)' };
  }
  const staleSpec = baseline.specHash && comp.codedTests && baseline.specHash !== specHashOf(comp.codedTests);
  const res = worksAsBefore(baseline.scenarios, currentScenarios);
  return { ...res, mode: baseline.mode, staleSpec: !!staleSpec };
}
