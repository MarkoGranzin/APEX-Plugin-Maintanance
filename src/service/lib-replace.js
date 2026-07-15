/**
 * Ersatz für UNMAINTAINED Bibliotheken: statt nur zu warnen, schlägt die Software einen gepflegten,
 * PERMISSIV lizenzierten (kommerziell nutzbar, pflichtenarm) Nachfolger vor — oder, wenn es keinen gibt,
 * einen selbst gebauten Minimal-Ersatz (MIT, nur die genutzte Funktionalität).
 *
 * Lizenz-Leitplanke: nur Nachfolger mit commercialOk und ohne Copyleft werden automatisch vorgeschlagen.
 * obligations 'none' (MIT/ISC/…) bevorzugt; 'attribution' (Apache/BSD) erlaubt, aber markiert; 'copyleft'/'unknown' → kein Auto-Ersatz.
 *
 * Resultat: src/service/lib-replace.js
 */

import { classifyLicense } from '../sbom/licenses.js';

/**
 * Bekannte gepflegte Nachfolger für unmaintained Libs (Name → Ersatz).
 * to: Paket/Lib-Name · license: SPDX des Nachfolgers · cdn: offizielles Browser-Bundle (für realen Lib-Load) ·
 * note: API-Migrationshinweis für den KI-Agenten · runtime: false = Build-/Test-Tooling (kein Laufzeit-Swap im Mock).
 */
export const REPLACEMENTS = {
  moment: { to: 'dayjs', license: 'MIT', cdn: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js', note: 'dayjs has a moment-like, immutable API: dayjs(input).format(...), .add()/.subtract(). For non-ISO parsing, load the CustomParseFormat plugin.', runtime: true },
  momentjs: { to: 'dayjs', license: 'MIT', cdn: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js', note: 'dayjs has a moment-like, immutable API: dayjs(input).format(...). For non-ISO parsing, load the CustomParseFormat plugin.', runtime: true },
  mxgraph: { to: '@maxgraph/core', license: 'Apache-2.0', cdn: 'https://cdn.jsdelivr.net/npm/@maxgraph/core/dist/maxgraph.umd.min.js', note: 'maxGraph is the official successor to mxGraph (same architecture). mx* classes → @maxgraph/core exports (e.g. mxGraph→Graph, mxClient→…). Adjust the call sites accordingly.', runtime: true },
  mxclient: { to: '@maxgraph/core', license: 'Apache-2.0', cdn: 'https://cdn.jsdelivr.net/npm/@maxgraph/core/dist/maxgraph.umd.min.js', note: 'mxClient → @maxgraph/core (official successor).', runtime: true },
  jsonpath: { to: 'jsonpath-plus', license: 'MIT', cdn: 'https://cdn.jsdelivr.net/npm/jsonpath-plus/dist/index-browser-umd.cjs', note: 'jsonpath-plus: JSONPath({ path, json }) instead of jsonpath.query(json, path). Near drop-in.', runtime: true },
  request: { to: 'node-fetch', license: 'MIT', cdn: null, note: 'In the browser use native fetch(); in Node use node-fetch. request(opts,cb) → fetch(url,opts).then(r=>r.json()).', runtime: true },
  protractor: { to: 'playwright', license: 'Apache-2.0', cdn: null, note: 'E2E test runner — migrate specs to @playwright/test (no runtime swap).', runtime: false },
};

/**
 * Liefert einen LIZENZ-GEPRÜFTEN Ersatzvorschlag für eine unmaintained Lib — oder null.
 * Nur wenn der Nachfolger kommerziell nutzbar ist und KEIN Copyleft/Unbekannt hat.
 * @param {string} name @param {{classify?:Function}} [deps]
 * @returns {null|{from,to,license,licenseInfo,cdn,note,runtime,attribution,strategy:'replace'}}
 */
export function suggestReplacement(name, deps = {}) {
  const classify = deps.classify ?? classifyLicense;
  const e = REPLACEMENTS[String(name || '').toLowerCase()];
  if (!e) return null;
  const licenseInfo = classify(e.license);
  if (!licenseInfo.commercialOk || licenseInfo.obligations === 'copyleft' || licenseInfo.obligations === 'unknown') return null;
  return { from: name, to: e.to, license: e.license, licenseInfo, cdn: e.cdn ?? null, note: e.note, runtime: e.runtime !== false, attribution: licenseInfo.obligations === 'attribution', strategy: 'replace' };
}

/**
 * Ersatz-Plan für eine erkannte Lib-Liste: je unmaintained Lib entweder ein permissiver Nachfolger
 * (strategy 'replace') oder, wenn keiner bekannt ist, ein Self-Build-Hinweis (strategy 'self-build').
 * @param {Array<{name:string,version?:string,unmaintained?:boolean,status?:string}>} libs @param {{classify?:Function}} [deps]
 */
export function planReplacements(libs, deps = {}) {
  const out = [];
  for (const l of libs ?? []) {
    const isUnmaint = l.unmaintained || l.status === 'nicht gepflegt';
    if (!isUnmaint) continue;
    const rep = suggestReplacement(l.name, deps);
    if (rep) out.push({ ...rep, version: l.version });
    else out.push({ from: l.name, to: null, strategy: 'self-build', version: l.version, note: 'No known permissive successor — build a minimal replacement (MIT) yourself for just the used functionality.' });
  }
  return out;
}
