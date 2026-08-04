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
  // B-71: Leaflet-Familie — flache Uploads (Datei-Import legt basenames ab) müssen ohne lib/-Pfad erkannt werden.
  { re: /(^|\/)leaflet\.markercluster[\w.-]*\.js$/i, name: 'leaflet.markercluster' },
  { re: /(^|\/)leaflet(-src)?(\.esm)?(\.min)?\.(js|css)$/i, name: 'leaflet' },
];

// Eigene Plugin-/APEX-Core-Dateien NICHT als Fremd-Lib zählen.
const OWN = /(^|\/)(script|prescript|app|widget|plugin|main|index)(\.min)?\.(js|css)$/i;
const APEX_CORE = /(^|\/)font-apex/i;
// B-71: Nicht-Laufzeit-Anteile eines Lib-Checkouts (Tests/Specs/Doku/Beispiele) und Build-Konfig-
// Dateien erzeugen NIE Lib-Einträge — sie sind der Fake-Lib-Müll des Leaflet-Falls. `build/` bleibt
// bewusst SICHTBAR (three-artige Checkouts liefern dort aus); Konfig-Dateien darin fängt CONFIG_FILE.
const NON_RUNTIME_PATH = /(^|\/)(test|tests|__tests__|spec|specs|docs?|examples?|demos?|debug|coverage)(\/|$)/i;
const CONFIG_FILE = /(^|\/)(jakefile|gulpfile|gruntfile|karma\.conf|rollup[-.]config|webpack[-.]config[^/]*|vite\.config|hintrc|bower|\.eslintrc[^/]*)(\.[cm]?js)?$/i;
// Datei liegt in einem UNTERORDNER eines Lib-Verzeichnisses (lib/<checkout>/…) → gehört zum Checkout.
const LIB_SUBDIR = /(^|\/)(?:lib|libs|vendor|vendors|third[-_]?party)\/([^/]+)\//i;
// Organisations-Unterordner (lib/js/, lib/css/, …) sind KEINE Checkouts — ihre Dateien bleiben
// Einzeldateien, sonst verschluckt die Gruppierung mehrere Libs zu einer (Review-Befund F1).
const GENERIC_SUBDIR = /^(js|css|src|assets?|fonts?|img|images?|styles?|dist|build|min|es|esm|umd|cjs)$/i;
// Checkout-Ordnernamen normalisieren: „Leaflet.markercluster-master" → „leaflet.markercluster".
const normFolderLib = (s) => String(s).toLowerCase().replace(/[-_.](master|main|trunk|latest|src)$/i, '').replace(/[-_.]v?\d+(\.\d+)*$/, '');
// listFiles-Ignore OHNE dist/build: die ausgelieferte Datei eines Checkouts liegt genau dort.
const VENDOR_IGNORE = new Set(['.git', 'node_modules', '.idea', '.vscode', '.maintenance']);

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
function versionFromContent(content, name, opts = {}) {
  if (!content) return null;
  const head = content.slice(0, 4000);
  const body = content.slice(0, 2_000_000);
  // Führender Banner-Kommentar (`/* … */` oder zusammenhängende `//`-Zeilen) — NUR dort dürfen die
  // generischen Muster (Wort „Version", name-adjazent, Banner-„vX.Y.Z") greifen; sonst gäbe ein zufälliges
  // „vX.Y.Z" im Minify-Body Falschtreffer.
  const banner = (head.match(/^\s*(\/\*[\s\S]*?\*\/|(?:[ \t]*\/\/[^\n]*\n?)+)/) || ['', ''])[1];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const nname = norm(name);
  const layerAssign = () => { const m = body.match(/\b(?:VERSION|version)\s*[:=]\s*['"`]v?(\d+\.\d+(?:\.\d+)?)['"`]/); return m ? m[1] : null; };
  const layerJsdoc = () => { const m = banner.match(/@version\s+v?(\d+\.\d+(?:\.\d+)?)/i); return m ? m[1] : null; };
  const layerWord = () => { const m = banner.match(/\bversion\s+v?(\d+\.\d+(?:\.\d+)?)/i); return m ? m[1] : null; };
  const layerNameAdjacent = () => {
    if (!nname || nname.length < 3) return null;
    const needle = nname.slice(0, Math.min(nname.length, 10));
    for (const mm of banner.matchAll(/([^\n]{0,60}?)\bv?(\d+\.\d+(?:\.\d+)?)\b/gi)) { if (norm(mm[1]).includes(needle)) return mm[2]; }
    return null;
  };
  const layerBannerV = () => { const m = banner.match(/(?:^|[\s(*/])v(\d+\.\d+\.\d+)\b/); return m ? m[1] : null; };
  // B-71: Für die HAUPTDATEI eines Lib-Checkouts ist der name-adjazente Banner („Leaflet 1.7.1") die
  // Lib-Identität — eine body-weite version:-Zuweisung kann zu einem GEBÜNDELTEN Sub-Objekt gehören
  // (leaflet.js enthält version:"1.1.1" eines Subplugins). bannerFirst dreht die Reihenfolge entsprechend.
  const layers = opts.bannerFirst
    ? [layerNameAdjacent, layerJsdoc, layerWord, layerBannerV, layerAssign]
    : [layerAssign, layerJsdoc, layerWord, layerNameAdjacent, layerBannerV];
  for (const layer of layers) { const v = layer(); if (v) return v; }
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

/**
 * B-71 — Header-basierte Lib-Erkennung für ein EINZELNES (z.B. aus der Plugin-SQL EXTRAHIERTES) Asset:
 * Name über die KNOWN-Registry (Dateiname), Version aus dem Banner (name-adjazent zuerst — eine body-weite
 * version:-Zuweisung kann zu einem gebündelten Sub-Objekt gehören). Für den Datei-Import-Fall, in dem die
 * Libs nur EINGEBETTET in der .sql existieren und nie als FS-Datei auftauchen.
 * @returns {null|{name:string,version:string}}
 */
export function identifyAssetByHeader(fileName, content) {
  const f = String(fileName || '');
  const hit = KNOWN.find((k) => k.re.test(f));
  if (!hit) return null;
  const version = versionFromName(f)
    ?? (ANCHOR[hit.name] && ANCHOR[hit.name](String(content || '')))
    ?? versionFromContent(String(content || ''), hit.name, { bannerFirst: true });
  return version ? { name: hit.name, version } : null;
}

function nameFromFile(f) {
  for (const k of KNOWN) if (k.re.test(f)) return k.name;
  // generischer Fallback: Basename ohne Version/min/Endung
  const base = f.split('/').pop() || f;
  const n = base.replace(/[-.@]\d+\.\d+(?:\.\d+)?.*$/, '').replace(/\.(min)$/, '').replace(/\.(js|css)$/i, '').replace(/[.-]min$/, '');
  return n.toLowerCase();
}

// Kandidaten-Indiz für EINZELDATEIEN: lib-/vendor-Pfade, bekannte Namen, Version im Dateinamen.
// `dist/` allein ist bewusst KEIN Indiz (Review-Befund F4): Top-Level-dist enthält den EIGENEN
// Plugin-Build — der würde sonst als Fake-Lib (mit KI-Fallback-Kosten) auftauchen.
const isCandidate = (f) => /(^|\/)(lib|libs|vendor|vendors|third[-_]?party)\//i.test(f) || KNOWN.some((k) => k.re.test(f)) || !!versionFromName(f);

/**
 * Erkennt vendored Bibliotheken im Repo.
 * @param {string} dir
 * @param {{readFile?:Function, files?:string[]}} [opts]
 * @returns {{name:string,version:string,detectedBy:string,evidence:string}[]}
 */
export function detectVendoredLibraries(dir, opts = {}) {
  if (!dir || (!opts.files && !fs.existsSync(dir))) return [];
  const allFiles = opts.files ?? listFiles(dir, { ignore: VENDOR_IGNORE });
  const files = allFiles.filter((f) => /\.(js|css)$/i.test(f));
  // Version steht bei minifizierten Libs (three REVISION, mxClient VERSION) oft NACH den ersten KB →
  // ganze Datei durchsuchen, aber mit Größenlimit (kein Speicherproblem bei riesigen Bundles). (T-80)
  const MAX_READ = opts.maxRead ?? 8_000_000;
  const readFile = opts.readFile ?? ((rel) => {
    try { const p = path.join(dir, rel); if (fs.statSync(p).size > MAX_READ) return fs.readFileSync(p, 'utf8').slice(0, MAX_READ); return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  });

  // B-71 Phase 1: Lib-CHECKOUT-Ordner (lib/<name>/**) je Ordner zu EINER Lib bündeln — statt pro Datei
  // einen Fake-Eintrag zu erzeugen. Einzeldateien (flaches lib/) laufen wie bisher durch Phase 2.
  const groups = new Map(); // key: lib-Unterordner-Pfad → { name, files[] }
  const singles = [];
  for (const f of files) {
    if (OWN.test(f) || APEX_CORE.test(f) || NON_RUNTIME_PATH.test(f) || CONFIG_FILE.test(f)) continue;
    const m = f.match(LIB_SUBDIR);
    if (m && !GENERIC_SUBDIR.test(m[2])) {
      const folderName = normFolderLib(m[2]);
      // Review-Befund F2: eine KNOWN-Datei mit ANDEREM kanonischen Namen als der Checkout-Ordner
      // (lib/vanta-master/deps/jquery.min.js) ist eine EIGENE Lib — als Einzeldatei behandeln,
      // damit BEIDE sichtbar bleiben (kein Hijack der Gruppe, keine fremde package.json-Version).
      const known = KNOWN.find((k) => k.re.test(f));
      if (known && known.name !== folderName) { singles.push(f); continue; }
      const folder = f.slice(0, m.index + m[0].length - 1); // Pfad bis inkl. Checkout-Ordner (F5: index-robust)
      if (!groups.has(folder)) groups.set(folder, { name: folderName, files: [] });
      groups.get(folder).files.push(f);
      continue;
    }
    singles.push(f);
  }

  const byName = new Map();
  const put = (cand, preferOverPrev) => {
    const prev = byName.get(cand.name);
    if (!prev || preferOverPrev(prev)) byName.set(cand.name, cand);
  };

  for (const [folder, g] of groups) {
    // KNOWN-Datei im Checkout → deren kanonischer Name gewinnt (lib/x/jquery.min.js → jquery).
    const knownFile = g.files.find((f) => KNOWN.some((k) => k.re.test(f)));
    const name = knownFile ? nameFromFile(knownFile) : g.name;
    // Versionsquellen in Verlässlichkeits-Reihenfolge: package.json des Checkouts → Hauptdatei-Banner/Anchor.
    let version = null;
    const pkg = readFile(`${folder}/package.json`);
    let m; if (pkg && (m = String(pkg).match(/"version"\s*:\s*"v?(\d+\.\d+(?:\.\d+)?)"/))) version = m[1];
    // Hauptdatei-Kandidaten: die KANONISCHE Auslieferungsdatei (<name>.js/.min.js) schlägt -src/.esm-
    // Varianten (gemischte Checkouts: leaflet.js=1.7.1, leaflet-src*=1.6.0 — das Plugin lädt leaflet.js);
    // danach dist/-Dateien, Name-Match, nicht-minifiziert.
    const rank = (f) => {
      const base = (f.split('/').pop() || '').toLowerCase();
      const canonical = base === `${name}.js` || base === `${name}.min.js` || base === `${name}.css` ? 0 : 2;
      return canonical + (f.toLowerCase().includes(name.slice(0, 6)) ? 0 : 1) + (/\/dist\//i.test(f) ? 0 : 0.5) + (/\.min\./.test(f) ? 0.25 : 0);
    };
    const ordered = [...g.files].sort((a, b) => rank(a) - rank(b));
    let evidence = ordered[0] ?? g.files[0];
    let evidenceHead = null;
    if (!version) {
      for (const f of ordered.slice(0, 4)) {
        const content = readFile(f);
        version = (ANCHOR[name] && ANCHOR[name](content)) || versionFromContent(content, name, { bannerFirst: true }) || versionFromName(f);
        if (version) { evidence = f; break; }
      }
      if (!version) evidenceHead = readFile(ordered[0] ?? '').slice(0, 1500); // KI-Fallback (T-146)
    }
    put({ name, version: version ?? 'unbekannt', detectedBy: 'vendored', evidence, ...(evidenceHead ? { evidenceHead } : {}) },
      (prev) => prev.version === 'unbekannt' && version);
  }

  // Phase 2: Einzeldateien — bisheriges Verhalten (KNOWN/Pfad/Versions-Kandidat, inkl. KI-Fallback).
  for (const f of singles) {
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
    // bevorzuge konkrete Version + nicht-minifizierte Evidenz — aber NIE eine konkrete Version durch
    // 'unbekannt' ersetzen (Review-Befund F3: src/Three.js hätte build/three.min.js@0.150.0 überschrieben).
    const downgrade = cand.version === 'unbekannt' && (byName.get(name)?.version ?? 'unbekannt') !== 'unbekannt';
    put(cand, (prev) => !downgrade && ((prev.version === 'unbekannt' && cand.version !== 'unbekannt') || (!/\.min\./.test(f) && /\.min\./.test(prev.evidence))));
  }
  return [...byName.values()];
}
