/**
 * F-30 (T-116) — Akzeptanz-Vertrag aus der Mock-Charakterisierung.
 *
 * Die grüne Charakterisierung des Mocks (window.__views/__features + „rendert echt") ist das SOLL des
 * Plugins. Hier wird sie als formaler, eingefrorener, TECHNOLOGIE-UNABHÄNGIGER Akzeptanz-Vertrag
 * festgehalten: nur beobachtbares Verhalten (Sicht + Feature-Check + „muss rendern"), keine
 * Implementierungs-/Lib-Details. Dieser Vertrag ist das Soll für jede Neuentwicklung (T-117): egal mit
 * welcher Technologie neu gebaut wird — erfüllt der neue Stand den Vertrag, gilt „works as before".
 *
 * Reine Funktionen (testbar ohne Browser); runMockSelfTests liefert den Ist-Stand.
 *
 * Resultat: src/service/acceptance.js
 */

import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Stabiler Schlüssel je Kriterium (Sicht + Feature) — technologieunabhängig. */
export function criterionKey(view, feature) { return `${norm(view).toLowerCase()}|||${norm(feature).toLowerCase()}`; }

/**
 * Leitet den Akzeptanz-Vertrag aus einem runMockSelfTests-Ergebnis ab: alle GRÜNEN Feature-Checks
 * (rote/falsch-grüne werden NICHT zum Soll — der Vertrag beschreibt nur verlässlich erfülltes Verhalten).
 * @param {{views?:number, rendered?:boolean, features?:Array<{view,feature,ok,detail}>, problems?:Array, total?:number}} st
 * @param {{name?:string, at?:string}} opts
 * @returns {{name, views, renderedRequired, criteria:Array<{view,feature}>, total, source, capturedAt}|{error}}
 */
export function acceptanceFromSelfTest(st, opts = {}) {
  if (!st || !st.ran || !Array.isArray(st.features)) return { error: 'no self-test result' };
  // Nur echte grüne Checks; falsch-grüne (Dependency/leeres Rendern) sind KEIN gültiges Soll.
  const badKeys = new Set((st.problems || []).map((p) => criterionKey(p.view, p.feature)));
  const seen = new Set();
  const criteria = [];
  for (const f of st.features) {
    if (!f || f.ok === false) continue;
    const k = criterionKey(f.view, f.feature);
    if (badKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    criteria.push({ view: norm(f.view), feature: norm(f.feature) });
  }
  return {
    name: opts.name || null,
    views: st.views || new Set(criteria.map((c) => c.view)).size,
    renderedRequired: st.rendered !== false, // das Plugin MUSS echt rendern (kein leerer/Fehler-Stand)
    criteria,
    total: criteria.length,
    source: 'mock-characterization',
    capturedAt: opts.at || null,
  };
}

/**
 * Prüft einen neuen Self-Test-Stand gegen den Vertrag: jedes Soll-Kriterium muss vorhanden UND grün sein,
 * und (falls gefordert) das Plugin muss echt rendern. Technologieunabhängig — nur beobachtbares Verhalten zählt.
 * @returns {{pass:boolean, satisfied:number, total:number, missing:Array, broken:Array, renderOk:boolean}}
 */
export function compareAcceptance(contract, st) {
  const criteria = contract?.criteria || [];
  const byKey = new Map();
  for (const f of (st?.features || [])) byKey.set(criterionKey(f.view, f.feature), f);
  const missing = []; const broken = [];
  for (const c of criteria) {
    const f = byKey.get(criterionKey(c.view, c.feature));
    if (!f) { missing.push(c); continue; }      // Kriterium gar nicht mehr geprüft → nicht erfüllt
    if (f.ok === false) broken.push(c);          // vorhanden, aber rot → Regress
  }
  const renderOk = contract?.renderedRequired ? (st?.rendered !== false) : true;
  const satisfied = criteria.length - missing.length - broken.length;
  const pass = missing.length === 0 && broken.length === 0 && renderOk && (st?.ran === true);
  return { pass, satisfied, total: criteria.length, missing, broken, renderOk };
}

const acceptancePath = (dir) => path.join(dir, '.maintenance', 'acceptance.json');

/** Vertrag neben dem Mock ablegen (reist mit dem eingecheckten Stand). */
export function writeAcceptance(dir, contract) {
  try {
    const p = acceptancePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(contract, null, 2));
    return p;
  } catch { return null; }
}

/** Vertrag lesen (oder null, wenn nicht vorhanden/unlesbar). */
export function readAcceptance(dir) {
  try { return JSON.parse(fs.readFileSync(acceptancePath(dir), 'utf8')); } catch { return null; }
}
