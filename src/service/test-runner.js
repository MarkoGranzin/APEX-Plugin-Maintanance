/**
 * T-57 — Konsolen-Testlauf für ALLE verwalteten Plugins/Template-Komponenten.
 *
 * Führt je Komponente die PLUGIN-Tests aus (Static-First-Gate + Verhaltenstest-Plan über scanRepo) —
 * also genau das, was beim „Prüfen" passiert — und NICHT die Unit-Tests der Pflege-Software (vitest).
 * Liefert ein maschinen- und konsolentaugliches Ergebnis (grün/rot/übersprungen, Exit-Code via ok).
 *
 * Resultat: src/service/test-runner.js
 */

import fs from 'node:fs';
import { scanRepo } from './run-repo.js';

/**
 * @param {Array<{name:string, path?:string, format?:string}>} components  verwaltete Komponenten (Store)
 * @param {{scan?:Function, exists?:Function}} [deps]  scan/exists injizierbar → deterministisch testbar
 * @returns {{results:Array, green:number, red:number, skipped:number, ok:boolean}}
 */
export function runComponentTests(components, deps = {}) {
  const scan = deps.scan ?? scanRepo;
  const exists = deps.exists ?? ((p) => !!p && fs.existsSync(p));
  const results = [];

  for (const comp of components ?? []) {
    if (!exists(comp.path)) {
      results.push({ name: comp.name, verdict: 'skipped', reason: 'no repo assigned' });
      continue;
    }
    const r = scan(comp.path);
    const log = r.log ?? [];
    const scenarios = (String(r.testPlan ?? '').match(/Szenario:/g) ?? []).length;
    const security = log.filter((e) => e.agent === 'Security' && e.severity).length;
    const quality = log.filter((e) => e.agent === 'Code-Review' && e.severity).length;
    const vulnerabilities = log.filter((e) => e.agent === 'retire.js').length;
    const blocked = (r.failures ?? []).length > 0 || log.some((e) => e.agent === 'Review-Gate' && /blockiert/.test(e.result ?? ''));
    results.push({
      name: comp.name,
      verdict: blocked ? 'red' : 'green',
      format: r.format ?? comp.format ?? null,
      scenarios,
      security,
      quality,
      vulnerabilities,
      failures: r.failures ?? [],
    });
  }

  const green = results.filter((x) => x.verdict === 'green').length;
  const red = results.filter((x) => x.verdict === 'red').length;
  const skipped = results.filter((x) => x.verdict === 'skipped').length;
  return { results, green, red, skipped, ok: red === 0 };
}
