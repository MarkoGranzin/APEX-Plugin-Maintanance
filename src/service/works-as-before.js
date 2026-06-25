/**
 * F-28 (T-91) — „works as before"-Gate.
 *
 * Vergleicht die Spec-Ergebnisse des funktionierenden Builds (Baseline) mit den Ergebnissen nach
 * Migration/Neuentwicklung. Regel: KEIN vorher-gruenes Szenario darf jetzt rot/fehlend sein
 * (= kein Regress). Neue gruene Szenarien sind erlaubt. Vorher schon rote Szenarien sind nicht
 * bindend (keine Verschlechterung). Rein und ohne Seiteneffekte → ohne Browser/KI testbar.
 *
 * Ergebnis-Eintrag je Szenario: { id|title|name, status:'passed'|'failed'|'skipped' } ODER
 * { ..., passed:boolean }. Akzeptiert Array oder Map.
 *
 * Resultat: src/service/works-as-before.js
 */

function toStatus(r) {
  if (r.status) return r.status;
  if (r.passed === true) return 'passed';
  if (r.passed === false) return 'failed';
  return 'skipped';
}

function toMap(results) {
  const m = new Map();
  const entries = results instanceof Map ? [...results.entries()].map(([k, v]) => ({ id: k, ...(typeof v === 'string' ? { status: v } : v) })) : (results ?? []);
  for (const r of entries) {
    const key = r.id ?? r.scenario ?? r.title ?? r.name;
    if (key == null) continue;
    m.set(String(key), toStatus(r));
  }
  return m;
}

/**
 * @param {Array|Map} baseline Spec-Ergebnisse des funktionierenden Builds
 * @param {Array|Map} current  Spec-Ergebnisse nach Migration/Neuentwicklung
 * @returns {{pass:boolean, regressions:Array<{scenario:string,was:string,now:string}>, newlyGreen:string[], summary:string}}
 */
export function worksAsBefore(baseline, current) {
  const base = toMap(baseline);
  const cur = toMap(current);
  const regressions = [];
  const newlyGreen = [];

  for (const [key, status] of base) {
    if (status !== 'passed') continue; // nur vorher gruene Szenarien sind bindend
    const now = cur.get(key);
    if (now === undefined) regressions.push({ scenario: key, was: 'passed', now: 'missing' });
    else if (now !== 'passed') regressions.push({ scenario: key, was: 'passed', now });
  }
  for (const [key, status] of cur) {
    if (status === 'passed' && base.get(key) !== 'passed') newlyGreen.push(key);
  }

  const pass = regressions.length === 0;
  const summary = pass
    ? `works as before — no regressions${newlyGreen.length ? `, ${newlyGreen.length} newly green` : ''}`
    : `${regressions.length} regression(s) vs. baseline: ${regressions.map((r) => r.scenario).join(', ')}`;
  return { pass, regressions, newlyGreen, summary };
}
