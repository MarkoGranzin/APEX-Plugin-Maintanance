/**
 * F-23 (T-95) — Lizenz-Achtsamkeit: bewertet eine Lib-Lizenz danach, ob sie
 *   (A) kommerziell erlaubt ist und (B) keine/geringe Pflichten hat.
 *
 * Kategorien:
 *   - clean        permissiv & pflichtenarm (MIT, ISC, 0BSD, Unlicense, CC0, WTFPL) → ok
 *   - attribution  kommerziell ok, ABER Attributionspflicht (Apache-2.0, BSD-2/3) → Pflicht beachten
 *   - warn         copyleft (GPL/LGPL/AGPL/MPL/EPL/CDDL) ODER unbekannt → kommerziell heikel/Pflichten
 *
 * Resultat: src/sbom/licenses.js
 */

const FREE = ['mit', 'isc', '0bsd', 'unlicense', 'cc0-1.0', 'cc0', 'wtfpl', 'public-domain', 'publicdomain'];
const ATTRIBUTION = ['apache-2.0', 'apache2.0', 'apache', 'bsd', 'bsd-2-clause', 'bsd-3-clause', 'bsd-3-clause-clear', 'zlib', 'mit-0'];
const COPYLEFT = ['gpl', 'gpl-2.0', 'gpl-3.0', 'lgpl', 'lgpl-2.1', 'lgpl-3.0', 'agpl', 'agpl-3.0', 'mpl', 'mpl-2.0', 'epl', 'epl-2.0', 'cddl', 'cc-by-sa', 'cc-by-nc', 'osl', 'eupl'];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^\(|\)$/g, '').replace(/\s+/g, '');

/**
 * @param {string|{type?:string,name?:string}} license SPDX-Id, npm-license-Feld o. Lizenz-Objekt
 * @returns {{id:string, level:'clean'|'attribution'|'warn', commercialOk:boolean, obligations:'none'|'attribution'|'copyleft'|'unknown', ok:boolean, label:string, reason:string}}
 */
export function classifyLicense(license) {
  const raw = typeof license === 'object' && license ? (license.type || license.name || '') : license;
  const id = String(raw ?? '').trim() || 'UNKNOWN';
  const n = norm(raw);

  // OR-Ausdruck (z.B. "(MIT OR Apache-2.0)") → beste (sauberste) Variante gewinnt
  if (/\bor\b/.test(String(raw).toLowerCase())) {
    const parts = String(raw).split(/\s+or\s+/i).map((p) => classifyLicense(p));
    const order = { clean: 0, attribution: 1, warn: 2 };
    return parts.sort((a, b) => order[a.level] - order[b.level])[0];
  }

  const has = (list) => list.some((k) => n === k || n.startsWith(k));
  if (n && has(FREE)) return mk(id, 'clean', true, 'none');
  if (n && has(ATTRIBUTION)) return mk(id, 'attribution', true, 'attribution');
  if (n && has(COPYLEFT)) return mk(id, 'warn', false, 'copyleft');
  return mk(id, 'warn', false, 'unknown');
}

function mk(id, level, commercialOk, obligations) {
  const ok = level === 'clean';
  const label = level === 'clean' ? 'permissive' : level === 'attribution' ? 'permissive (attribution)' : obligations === 'copyleft' ? 'copyleft' : 'unknown';
  const reason = obligations === 'none' ? 'commercial OK, no obligations'
    : obligations === 'attribution' ? 'commercial OK, attribution required'
    : obligations === 'copyleft' ? 'copyleft — commercially risky / source obligations'
    : 'license unknown — review manually';
  return { id, level, commercialOk, obligations, ok, label, reason };
}

const LEVEL_ORDER = { clean: 0, attribution: 1, warn: 2 };

/**
 * T-156 — Lizenzwechsel zwischen zwei Versionen bewerten (installiert → neu/latest).
 * @returns null wenn keine Änderung; sonst { from, to, fromClass, toClass, fromLevel, toLevel, riskier }.
 *   riskier=true, wenn die Lizenzklasse SCHLECHTER wird (permissive → attribution/copyleft/unknown) —
 *   rechtlich relevant. Reine SPDX-Umbenennung ohne Klassenverschlechterung ist changed, aber nicht riskier.
 */
export function licenseChange(fromLicense, toLicense) {
  const a = classifyLicense(fromLicense);
  const b = classifyLicense(toLicense);
  const changed = norm(a.id) !== norm(b.id) || a.level !== b.level;
  if (!changed) return null;
  const riskier = (LEVEL_ORDER[b.level] ?? 2) > (LEVEL_ORDER[a.level] ?? 2);
  return { from: a.id, to: b.id, fromClass: a.label, toClass: b.label, fromLevel: a.level, toLevel: b.level, riskier };
}

/** Zaehlt Lizenz-Auffaelligkeiten ueber eine Lib-Liste (fuer Report/Badge). null wenn alles sauber. */
export function licenseWarningFrom(libs) {
  let copyleft = 0; let unknown = 0; let attribution = 0;
  for (const l of libs ?? []) {
    const c = l.licenseInfo ?? classifyLicense(l.license);
    if (c.obligations === 'copyleft') copyleft++;
    else if (c.obligations === 'unknown') unknown++;
    else if (c.obligations === 'attribution') attribution++;
  }
  return copyleft || unknown || attribution ? { copyleft, unknown, attribution } : null;
}
