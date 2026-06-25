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

// Header-Muster (nur Datei-Anfang ~3 KB) — Lizenz-/Banner-Konventionen. KEIN generisches „vX.Y.Z"
// quer durchs Minify-Bundle (sonst falsche Treffer wie three@2.2.2 aus einem zufälligen Token).
const HEADER_RES = [
  /jquery[^\n]{0,40}?v(\d+\.\d+\.\d+)/i,
  /font\s*awesome[^\n]{0,40}?(\d+\.\d+(?:\.\d+)?)/i, // „Font Awesome 4.7.0 by @davegandy"
  /@version\s+v?(\d+\.\d+(?:\.\d+)?)/i,
];
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
    if (!version) {
      const content = readFile(f);
      const head = content.slice(0, 3000);
      for (const re of HEADER_RES) { const m = head.match(re); if (m) { version = m[1]; break; } }
      // sonst: lib-spezifischer Marker irgendwo in der Datei (kein generisches vX.Y.Z → keine Falschtreffer)
      if (!version && ANCHOR[name]) version = ANCHOR[name](content);
    }
    const cand = { name, version: version ?? 'unbekannt', detectedBy: 'vendored', evidence: f };
    const prev = byName.get(name);
    // bevorzuge konkrete Version + nicht-minifizierte Evidenz
    if (!prev || (prev.version === 'unbekannt' && cand.version !== 'unbekannt') || (!/\.min\./.test(f) && /\.min\./.test(prev.evidence))) {
      byName.set(name, cand);
    }
  }
  return [...byName.values()];
}
