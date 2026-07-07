/**
 * T-68 — Vollständige Erkennung vendored Bibliotheken (auch ohne Version im Dateinamen).
 *
 * APEX-Plugins legen Libs unter lib/vendor/ ab — oft umbenannt (jquery.min.js, mxClient.js) ohne
 * Version im Namen. Diese Erkennung mappt bekannte Dateinamen auf Lib-Namen, liest die Version aus
 * dem Datei-Header (z.B. „jQuery v3.4.1", „mxClient.VERSION = '4.2.0'") und meldet je Lib
 * {name, version, detectedBy:'vendored', evidence}. Eigene Plugin-/APEX-Core-Dateien werden ignoriert.
 *
 * Resultat: src/sbom/vendored.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from '../inventory/inventory.js';

// Bekannte Dateinamen → Lib-Name (normalisiert).
const KNOWN = [
  { re: /(^|\/)jquery-migrate/i, name: 'jquery-migrate' },
  { re: /(^|\/)jquery(\.slim)?(\.min)?\.js$/i, name: 'jquery' },
  { re: /(^|\/)mxclient(\.min)?\.js$/i, name: 'mxgraph' },
  { re: /(^|\/)bootstrap(\.min)?\.(js|css)$/i, name: 'bootstrap' },
  { re: /(^|\/)font-?awesome(\.min)?\.css$/i, name: 'font-awesome' },
  { re: /(^|\/)moment(\.min)?\.js$/i, name: 'moment' },
  { re: /(^|\/)lodash(\.min)?\.js$/i, name: 'lodash' },
  { re: /(^|\/)underscore(\.min)?\.js$/i, name: 'underscore' },
  { re: /(^|\/)d3(\.v\d+)?(\.min)?\.js$/i, name: 'd3' },
  { re: /(^|\/)angular(\.min)?\.js$/i, name: 'angular' },
  { re: /(^|\/)chart(\.min)?\.js$/i, name: 'chart.js' },
  { re: /(^|\/)select2(\.min)?\.(js|css)$/i, name: 'select2' },
  { re: /(^|\/)jsonpath[-.]?/i, name: 'jsonpath' },
  { re: /(^|\/)three(\.module)?(\.min)?\.js$/i, name: 'three' },
];

// Eigene Plugin-/APEX-Core-Dateien NICHT als Fremd-Lib zählen.
const OWN = /(^|\/)(script|prescript|app|widget|plugin|main|index)(\.min)?\.(js|css)$/i;
const APEX_CORE = /(^|\/)font-apex/i;

/**
 * T-146 — Version generisch identifizieren, „egal wie versteckt" — OHNE blindes „vX.Y.Z" quer durchs
 * Minify-Bundle (das erzeugte Falschtreffer). Geschichtet nach Verlässlichkeit, jede Schicht ist eng
 * verankert (Schlüsselwort, Wort „Version", Lib-Name-Nähe, oder v-Präfix NUR im Banner-Kopf):
 *   1) explizite Zuweisung  version="1.2.3" / VERSION: '1.2.3'  (irgendwo, bis Größen-Cap) — sehr sicher
 *   2) JSDoc  @version 1.2.3                                     (Kopf)
 *   3) Wort  „Version 3.0.2."                                    (Kopf) — z.B. maptopojson
 *   4) name-adjazent  „<LibName> … v?X.Y.Z"                      (Kopf) — z.B. „Font Awesome 4.7.0", DOMPurify
 *   5) Banner-„vX.Y.Z" (v-Präfix, 3 Teile)                        (Kopf) — z.B. „Masonry PACKAGED v4.2.2"
 * @param {string} content  Dateiinhalt   @param {string} name  erkannter Lib-Name (für die Nähe-Prüfung)
 * @returns {string|null}
 */
function versionFromContent(content, name) {
  if (!content) return null;
  const head = content.slice(0, 4000);
  const body = content.slice(0, 2_000_000);
  // Führender Banner-Kommentar (`/* … */` oder zusammenhängende `//`-Zeilen) — NUR dort dürfen die
  // generischen Muster (Wort „Version", name-adjazent, Banner-„vX.Y.Z") greifen; sonst gäbe ein zufälliges
  // „vX.Y.Z" im Minify-Body Falschtreffer.
  const banner = (head.match(/^\s*(\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*\n?)+)/) || ['', ''])[1];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const nname = norm(name);
  let m;
  // 1) explizite Zuweisung version="1.2.3" / VERSION:'1.2.3' — Schlüsselwort + Quotes → sehr sicher (ganze Datei)
  if ((m = body.match(/\b(?:VERSION|version)\s*[:=]\s*['"`]v?(\d+\.\d+(?:\.\d+)?)['"`]/))) return m[1];
  // 2) JSDoc @version 1.2.3 (im Banner)
  if ((m = banner.match(/@version\s+v?(\d+\.\d+(?:\.\d+)?)/i))) return m[1];
  // 3) Wort „Version 3.0.2" (im Banner)
  if ((m = banner.match(/\bversion\s+v?(\d+\.\d+(?:\.\d+)?)/i))) return m[1];
  // 4) name-adjazent „<LibName> … vX.Y.Z" (im Banner)
  if (nname && nname.length >= 3) {
    const needle = nname.slice(0, Math.min(nname.length, 10));
    for (const mm of banner.matchAll(/([^\n]{0,60}?)\bv?(\d+\.\d+(?:\.\d+)?)\b/gi)) {
      if (norm(mm[1]).includes(needle)) return mm[2];
    }
  }
  // 5) Banner-„vX.Y.Z" (v-Präfix, 3 Teile) — nur im Banner-Kommentar
  if ((m = banner.match(/(?:^|[\s(*/])v(\d+\.\d+\.\d+)\b/))) return m[1];
  return null;
}
// Lib-spezifische Marker, die irgendwo in der (ggf. großen) Datei stehen dürfen.
const ANCHOR = {
  // three: REVISION = '116dev' / "160" / r152 → 0.<rev>.0 (Dev-/Buchstaben-Suffix tolerieren, T-90)
  three: (t) => { const m = t.match(/REVISION\s*[=:]\s*['"]?r?(\d{2,3})(?:dev|[a-z][\w.-]*)?['"]?/i); return m ? `0.${m[1]}.0` : null; },
  mxgraph: (t) => { const m = t.match(/mxClient\.VERSION\s*=\s*['"]([\d.]+)['"]/); return m ? m[1] : null; },
  bootstrap: (t) => { const m = t.match(/bootstrap[^\n]{0,40}?v(\d+\.\d+\.\d+)/i); return m ? m[1] : null; },
};

const versionFromName = (f) => (f.match(/[-.@](\d+\.\d+(?:\.\d+)?)(?:[.-]min)?\.(?:js|css)$/) || [])[1] ?? null;

function nameFromFile(f) {
  for (const k of KNOWN) if (k.re.test(f)) return k.name;
  // generischer Fallback: Basename ohne Version/min/Endung
  const base = f.split('/').pop() || f;
  const n = base.replace(/[-.@]\d+\.\d+(?:\.\d+)?.*$/, '').replace(/\.(min)$/, '').replace(/\.(js|css)$/i, '').replace(/[.-]min$/, '');
  return n.toLowerCase();
}

const isCandidate = (f) => /(^|\/)(lib|libs|vendor|vendors|third[-_]?party|dist)\//i.test(f) || KNOWN.some((k) => k.re.test(f)) || !!versionFromName(f);

/**
 * Erkennt vendored Bibliotheken im Repo.
 * @param {string} dir
 * @param {{readFile?:Function, files?:string[]}} [opts]
 * @returns {{name:string,version:string,detectedBy:string,evidence:string}[]}
 */
export function detectVendoredLibraries(dir, opts = {}) {
  if (!dir || (!opts.files && !fs.existsSync(dir))) return [];
  const files = (opts.files ?? listFiles(dir)).filter((f) => /\.(js|css)$/i.test(f));
  // Version steht bei minifizierten Libs (three REVISION, mxClient VERSION) oft NACH den ersten KB →
  // ganze Datei durchsuchen, aber mit Größenlimit (kein Speicherproblem bei riesigen Bundles). (T-80)
  const MAX_READ = opts.maxRead ?? 8_000_000;
  const readFile = opts.readFile ?? ((rel) => {
    try { const p = path.join(dir, rel); if (fs.statSync(p).size > MAX_READ) return fs.readFileSync(p, 'utf8').slice(0, MAX_READ); return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  });

  const byName = new Map();
  for (const f of files) {
    if (OWN.test(f) || APEX_CORE.test(f)) continue;
    if (!isCandidate(f)) continue;
    const name = nameFromFile(f);
    if (!name) continue;
    let version = versionFromName(f);
    let evidenceHead = null;
    if (!version) {
      const content = readFile(f);
      // Spezielle Nicht-Semver-Marker zuerst (three REVISION, mxClient.VERSION), dann generisch (T-146).
      if (ANCHOR[name]) version = ANCHOR[name](content);
      if (!version) version = versionFromContent(content, name);
      if (!version) evidenceHead = content.slice(0, 1500); // Kopf für den KI-Fallback (T-146), nur wenn unbekannt
    }
    const cand = { name, version: version ?? 'unbekannt', detectedBy: 'vendored', evidence: f, ...(evidenceHead ? { evidenceHead } : {}) };
    const prev = byName.get(name);
    // bevorzuge konkrete Version + nicht-minifizierte Evidenz
    if (!prev || (prev.version === 'unbekannt' && cand.version !== 'unbekannt') || (!/\.min\./.test(f) && /\.min\./.test(prev.evidence))) {
      byName.set(name, cand);
    }
  }
  return [...byName.values()];
}
