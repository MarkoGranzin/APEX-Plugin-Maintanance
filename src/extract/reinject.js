/**
 * T-25 — Re-Injektion: gepatchtes Asset über die sourceMap zurück ins Original-Artefakt schreiben
 *          (Umkehrung der Extraktion T-19).
 *
 * KI-Fix (T-15) und Lib-Update (T-8) verändern das *kanonische* JS — daraus wird erst dann ein
 * committeter PR, wenn das Asset exakt dorthin zurückgeschrieben wird, wo es herkam (Wissen #513).
 * Drei Pfade spiegelbildlich zur Extraktion. Pflichten: minimaler/deterministischer Diff,
 * Round-Trip byte-identisch (extrahieren → unverändert re-injizieren ⇒ gleiche Bytes),
 * 'extraktion-unsicher' wird NICHT automatisch zurückgeschrieben (manueller Eingriff).
 *
 * Resultat: src/extract/reinject.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { findCalls } from './extract.js';
import { buildInlineLiteral } from './inline.js';
import { skipString, unquote } from './sql-scan.js';

/**
 * B-43: Löst einen (potenziell aus fremdem Plugin-SQL stammenden) relativen Pfad innerhalb
 * von rootDir auf und verweigert jeden Ausbruch (absolute Pfade, ../, anderes Laufwerk).
 * So kann eine manipulierte sourceMap-Herkunft nicht außerhalb des Repos schreiben/lesen.
 */
export function resolveWithin(rootDir, p) {
  const realRoot = realpathSafe(path.resolve(rootDir ?? '.'));
  const abs = path.resolve(realRoot, String(p ?? ''));
  // B-68: path.resolve löst SYMLINKS NICHT auf — ein Symlink im Repo (repo/x -> /außerhalb) bestünde die
  // lexische Prüfung, bräche aber real aus. Deshalb den EXISTIERENDEN Pfad-Anteil per realpath kanonisieren
  // (der Ziel-Blattname darf noch fehlen, z.B. neue Datei) und ERST DANN auf Containment prüfen.
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const realAbs = path.join(realpathSafe(probe), path.relative(probe, abs));
  const rel = path.relative(realRoot, realAbs);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Pfad verlässt das Repo-Verzeichnis: ${p}`);
  }
  return realAbs;
}

function realpathSafe(p) { try { return fs.realpathSync(p); } catch { return p; } }

/**
 * Ersetzt nur den p_file_content-Ausdruck genau eines create_plugin_file-Aufrufs (minimaler Diff).
 * Single-Literal und g_varchar2_table werden durch EIN base64-Literal ersetzt; bei unverändertem
 * Single-Literal bleibt die Datei byte-identisch.
 */
export function replacePluginFileContent(sql, fileName, newBase64) {
  for (const call of findCalls(sql, 'create_plugin_file')) {
    const args = call.argsText;
    const nameMatch = args.match(/p_file_name\s*=>\s*'((?:[^']|'')*)'/i);
    if (!nameMatch || unquote(nameMatch[1]) !== fileName) continue;

    // Position des p_file_content-Ausdrucks innerhalb der gesamten SQL bestimmen
    const ce = /p_file_content\s*=>\s*/i.exec(args);
    if (!ce) continue;
    const exprStartInArgs = ce.index + ce[0].length;
    let i = exprStartInArgs;
    let depth = 0;
    while (i < args.length) {
      const c = args[i];
      if (c === "'") { i = skipString(args, i); continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) break;
      i++;
    }
    const absStart = call.argStart + exprStartInArgs;
    const absEnd = call.argStart + i;
    return sql.slice(0, absStart) + `'${newBase64}'` + sql.slice(absEnd);
  }
  throw new Error(`create_plugin_file für "${fileName}" nicht gefunden`);
}

/**
 * Schreibt ein gepatchtes Asset über seine sourceMap-Herkunft zurück.
 * @param {object} origin  sourceMap-Eintrag ({type:'file'|'plugin_file', ...})
 * @param {string} newCode gepatchtes Asset
 * @param {object} [opts]  readFile/writeFile (injizierbar), bundleStatus
 * @returns {{written:boolean, manualNeeded?:boolean, reason?:string, target?:string}}
 */
export function reinjectAsset(origin, newCode, opts = {}) {
  const rootDir = opts.rootDir ?? '.';
  // Default-FS-Zugriffe sind auf rootDir eingesperrt (B-43); injizierte read/write bleiben unberührt.
  const readFile = opts.readFile ?? ((p) => fs.readFileSync(resolveWithin(rootDir, p), 'utf8'));
  const writeFile = opts.writeFile ?? ((p, c) => fs.writeFileSync(resolveWithin(rootDir, p), c));

  // 'extraktion-unsicher' → nie automatisch zurückschreiben
  if (opts.bundleStatus === 'extraktion-unsicher' || origin == null) {
    return { written: false, manualNeeded: true, reason: 'Quelle extraktion-unsicher — manueller Eingriff nötig' };
  }

  if (origin.type === 'file') {
    writeFile(origin.path, newCode);
    return { written: true, target: origin.path };
  }

  if (origin.type === 'plugin_file') {
    const sql = readFile(origin.sqlFile);
    const newBase64 = Buffer.from(newCode, 'utf8').toString('base64');
    const newSql = replacePluginFileContent(sql, origin.fileName, newBase64);
    writeFile(origin.sqlFile, newSql);
    return { written: true, target: origin.sqlFile };
  }

  if (origin.type === 'inline') {
    // Inline-PL/SQL (T-20): das String-Literal an der exakten sourceMap-Stelle ersetzen,
    // PL/SQL-Quoting + ggf. <script>-Wrapper exakt erhalten (minimaler Diff, Round-Trip-fähig).
    const sql = readFile(origin.sqlFile);
    const literal = buildInlineLiteral(newCode, origin);
    const newSql = sql.slice(0, origin.absStart) + literal + sql.slice(origin.absEnd);
    writeFile(origin.sqlFile, newSql);
    return { written: true, target: origin.sqlFile };
  }

  return { written: false, manualNeeded: true, reason: `Unbekannte Herkunft: ${origin.type}` };
}
