/**
 * T-2 — APEX-Plugin & Template-Komponente im Repo erkennen und inventarisieren.
 *
 * Erkennung hängt vom Speicherformat ab (Wissen #509): export-fertig (wwv_flow_api/f4000)
 * vs. roher Quellcode. Dieses Modul findet die Artefakte und sammelt je Artefakt die
 * zugehörigen JS/CSS-Assets als Eingang fürs spätere Fingerprinting/SBOM (T-7).
 * Die Format-Bestimmung + Test-Pfad-Wahl liegt in src/inventory/format.js (T-18).
 *
 * Resultat: src/inventory/inventory.js
 */

import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.idea', '.vscode']);

/** Liest alle Dateien (rekursiv) als relative Pfade. */
export function listFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(path.relative(rootDir, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

/** APEX-Export-Signale im SQL-Text. */
export function sqlSignals(sql) {
  return {
    isApexExport: /wwv_flow_api\./i.test(sql) || /create_plugin\b/i.test(sql) || /f4000_/i.test(sql),
    isPlugin: /wwv_flow_api\.create_plugin\b/i.test(sql) || /create_plugin\b/i.test(sql),
    isTemplateComponent:
      /create_template_component\b/i.test(sql) ||
      /wwv_flow_api\.create_plugin\b[\s\S]{0,400}?p_plugin_type\s*=>\s*'[^']*TEMPLATE[^']*'/i.test(sql),
    hasPluginFile: /create_plugin_file\b/i.test(sql),
    // roher PL/SQL-Quellcode (Package o.ä.) ohne Export-Wrapper
    isPlSqlPackage: /create\s+(or\s+replace\s+)?package\b/i.test(sql),
  };
}

const isJs = (f) => /\.js$/i.test(f) && !/\.min\.test\./i.test(f);
const isCss = (f) => /\.css$/i.test(f);
const isSql = (f) => /\.sql$/i.test(f);
const isTestFile = (f) => /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(f) || /\.(test|spec)\.[jt]s$/i.test(f);

/**
 * Scannt ein ausgecheckes Repo und liefert eine Artefakt-Liste.
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {(p:string)=>string} [opts.readFile] für Tests injizierbar
 * @returns {Artifact[]}
 */
export function detectArtifacts(rootDir, opts = {}) {
  const readFile = opts.readFile ?? ((rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8'));
  const files = (opts.files ?? listFiles(rootDir)).filter((f) => !isTestFile(f));

  const artifacts = [];
  const consumed = new Set();

  // 1) APEX-SQL-Exporte: jede .sql mit Export-Signalen ist ein Artefakt.
  for (const f of files.filter(isSql)) {
    let sql = '';
    try {
      sql = readFile(f);
    } catch {
      continue;
    }
    const sig = sqlSignals(sql);
    if (sig.isApexExport) {
      consumed.add(f);
      artifacts.push({
        name: baseName(f),
        type: sig.isTemplateComponent ? 'template_component' : 'plugin',
        rootFile: f,
        files: [f],
        sqlFiles: [f],
        jsFiles: [],
        cssFiles: [],
        assets: [], // JS/CSS-Vendoring-Eingang für T-7
        signals: sig,
      });
    }
  }

  // 2) Roher Quellcode: lose .js/.css (+ ggf. PL/SQL-Package-.sql), die nicht zu einem Export gehören.
  const looseJs = files.filter((f) => isJs(f) && !consumed.has(f));
  const looseCss = files.filter((f) => isCss(f) && !consumed.has(f));
  const packageSql = files.filter((f) => {
    if (consumed.has(f) || !isSql(f)) return false;
    try {
      return sqlSignals(readFile(f)).isPlSqlPackage;
    } catch {
      return false;
    }
  });

  // Gruppierung roher Artefakte nach Verzeichnis (ein Plugin = ein Ordner ist die häufige Konvention).
  const byDir = new Map();
  const addToDir = (f, bucket) => {
    const dir = path.posix.dirname(f);
    if (!byDir.has(dir)) byDir.set(dir, { jsFiles: [], cssFiles: [], sqlFiles: [] });
    byDir.get(dir)[bucket].push(f);
  };
  looseJs.forEach((f) => addToDir(f, 'jsFiles'));
  looseCss.forEach((f) => addToDir(f, 'cssFiles'));
  packageSql.forEach((f) => addToDir(f, 'sqlFiles'));

  for (const [dir, grp] of byDir) {
    const all = [...grp.jsFiles, ...grp.cssFiles, ...grp.sqlFiles].sort();
    if (all.length === 0) continue;
    artifacts.push({
      name: dir === '.' ? baseName(all[0]) : dir.split('/').pop(),
      type: 'plugin',
      rootFile: grp.jsFiles[0] ?? all[0],
      files: all,
      sqlFiles: grp.sqlFiles,
      jsFiles: grp.jsFiles,
      cssFiles: grp.cssFiles,
      assets: [...grp.jsFiles, ...grp.cssFiles], // Vendoring-Eingang für T-7
      signals: { isApexExport: false, isPlSqlPackage: grp.sqlFiles.length > 0 },
    });
  }

  return artifacts.sort((a, b) => a.name.localeCompare(b.name));
}

function baseName(f) {
  return f.split('/').pop().replace(/\.[^.]+$/, '');
}

/**
 * @typedef {Object} Artifact
 * @property {string} name
 * @property {'plugin'|'template_component'} type
 * @property {string} rootFile
 * @property {string[]} files
 * @property {string[]} sqlFiles
 * @property {string[]} jsFiles
 * @property {string[]} cssFiles
 * @property {string[]} assets  JS/CSS-Assets als Eingang fürs Fingerprinting/SBOM (T-7)
 * @property {object} signals
 */
