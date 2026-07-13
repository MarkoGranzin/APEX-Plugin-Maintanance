/**
 * B-40 (generisch) — Laufzeit-Assets eines APEX-Plugins/einer Template-Component: erkennen, wie die in die
 * Plugin-.sql EINGEBETTETEN Dateien entstehen, dieses Mapping ins Manifest schreiben (Analyse-Phase) und
 * die eingebetteten Dateien bit-genau ersetzen (Update/Import-Phase). Kind-agnostisch (region/item/DA/TC).
 *
 * Zwei Herkunfts-Arten je eingebetteter Datei:
 *   - 'bundle': via gulp-concat aus mehreren Quellen (gulpfile) gebaut → Quellen konkateniert re-einbetten.
 *   - 'copy':   1:1 aus einer Repo-Datei (gleicher Pfad/Basename) → Datei-Bytes re-einbetten.
 * Nur wenn sich der Inhalt real unterscheidet, wird ersetzt (kein Rausch). APEX-Exportformat:
 *   begin g_varchar2_table := empty; g_varchar2_table(n) := '<HEX 100 Byte>'; end; / … create_plugin_file(…).
 *
 * Reine String-/fs-Logik (dependency-frei); fs-Zugriffe injizierbar → unit-testbar.
 *
 * Resultat: mcp-apex-deploy/lib/plugin-assets.js
 */

import fs from 'node:fs';
import path from 'node:path';

/** gulp-concat-Bündel aus einem gulpfile: [{ bundle:'x.js', sources:['./js/lib/..'] }]. */
export function parseGulpBundles(gulpSrc) {
  const out = [];
  const re = /gulp\.src\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*\)[\s\S]*?\.pipe\(\s*concat\(\s*(?:\{\s*path\s*:\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(gulpSrc))) {
    const raw = m[1];
    const sources = raw.trim().startsWith('[') ? [...raw.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [raw.replace(/['"]/g, '')];
    out.push({ bundle: m[2], sources });
  }
  return out;
}

/** Namen aller in die .sql eingebetteten Plugin-Dateien (p_file_name). */
export function embeddedFileNames(exportSql) {
  return [...String(exportSql || '').matchAll(/p_file_name=>'([^']+)'/g)].map((m) => m[1]);
}

/** Löst gulp-Quellen (auch Globs dir/*.ext) zu echten Dateipfaden im Repo auf. */
export function resolveSources(repoDir, sources, deps = {}) {
  const listDir = deps.listDir ?? ((d) => fs.readdirSync(d));
  const exists = deps.exists ?? ((f) => fs.existsSync(f));
  const files = [];
  for (const s of sources) {
    const rel = s.replace(/^\.\//, '');
    const gm = rel.match(/^(.*)\/\*\.([a-z0-9]+)$/i);
    if (gm) {
      const dir = path.join(repoDir, gm[1]);
      let entries = []; try { entries = listDir(dir); } catch { entries = []; }
      for (const e of entries.filter((f) => f.toLowerCase().endsWith('.' + gm[2].toLowerCase())).sort()) files.push(path.join(dir, e));
    } else {
      const f = path.join(repoDir, rel);
      if (exists(f)) files.push(f);
    }
  }
  return files;
}

/** Bündel-Inhalt = Konkatenation der Quelldateien (wie gulp-concat, Trenner '\n'). @returns Buffer|null */
export function buildBundle(repoDir, sources, deps = {}) {
  const readBuf = deps.readBuf ?? ((f) => fs.readFileSync(f));
  const files = resolveSources(repoDir, sources, deps);
  if (!files.length) return null;
  const parts = files.map((f) => { const b = readBuf(f); return Buffer.isBuffer(b) ? b : Buffer.from(String(b)); });
  const out = []; parts.forEach((p, i) => { if (i) out.push(Buffer.from('\n')); out.push(p); });
  return Buffer.concat(out);
}

/** APEX-Content-Block (begin … g_varchar2_table-HEX-Chunks à 100 Byte … end; /) für die Bytes. */
export function buildContentBlock(buf, chunkBytes = 100) {
  const hex = Buffer.from(buf).toString('hex').toUpperCase();
  const lines = ['begin', 'wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;'];
  let idx = 1;
  for (let i = 0; i < hex.length; i += chunkBytes * 2) lines.push(`wwv_flow_api.g_varchar2_table(${idx++}) := '${hex.slice(i, i + chunkBytes * 2)}';`);
  if (idx === 1) lines.push("wwv_flow_api.g_varchar2_table(1) := '';");
  lines.push('end;', '/', '');
  return lines.join('\n');
}

/** Grenzen des Content-Blocks EINER eingebetteten Datei in der .sql (für Ersetzen/Dekodieren). */
function contentBlockSpan(sql, fileName) {
  const fi = sql.indexOf(`,p_file_name=>'${fileName}'`);
  if (fi < 0) return null;
  const createCallIdx = sql.lastIndexOf('wwv_flow_api.create_plugin_file(', fi);
  if (createCallIdx < 0) return null;
  const createBeginIdx = sql.lastIndexOf('begin', createCallIdx);
  const resetIdx = sql.lastIndexOf('wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;', createBeginIdx);
  if (resetIdx < 0) return null;
  const popBeginIdx = sql.lastIndexOf('begin', resetIdx);
  if (popBeginIdx < 0) return null;
  if (sql.slice(popBeginIdx, createBeginIdx).includes('create_plugin_file(')) return null; // unerwartete Struktur
  return { popBeginIdx, createBeginIdx };
}

/** Dekodiert den AKTUELL eingebetteten Inhalt einer Datei zurück. @returns Buffer|null */
export function decodeEmbeddedFile(exportSql, fileName) {
  const sql = String(exportSql || '');
  const span = contentBlockSpan(sql, fileName);
  if (!span) return null;
  const block = sql.slice(span.popBeginIdx, span.createBeginIdx);
  const hex = [...block.matchAll(/g_varchar2_table\(\d+\) := '([0-9A-Fa-f]*)'/g)].map((m) => m[1]).join('');
  return Buffer.from(hex, 'hex');
}

/** Ersetzt den eingebetteten Inhalt EINER Datei durch neue Bytes (APEX-Exportformat). @returns {ok,sql}|{ok:false,reason} */
export function reembedFile(exportSql, fileName, buf) {
  const sql = String(exportSql || '');
  const span = contentBlockSpan(sql, fileName);
  if (!span) return { ok: false, reason: `nicht eingebettet / unerwartete Struktur: ${fileName}` };
  return { ok: true, sql: sql.slice(0, span.popBeginIdx) + buildContentBlock(buf) + sql.slice(span.createBeginIdx) };
}

/** Findet im Repo die Quelldatei zu einem eingebetteten Namen: exakter relativer Pfad, sonst EINDEUTIGER Basename. */
export function findRepoSource(repoDir, embeddedName, deps = {}) {
  const exists = deps.exists ?? ((f) => fs.existsSync(f));
  const walk = deps.walk ?? defaultWalk;
  const rel = embeddedName.replace(/^\.?\//, '');
  // B-50: embeddedName stammt aus dem (potenziell fremden) Plugin-SQL. Ein exakter Pfad mit ../
  // oder absoluter Pfad würde aus repoDir ausbrechen und beim Re-Embed fremde Dateien einlesen.
  if (withinRepo(repoDir, rel) && exists(path.join(repoDir, rel))) return rel; // exakter Pfad (z.B. map/world-tour.json, js/flipcard.min.js)
  const base = path.basename(rel);
  const matches = walk(repoDir).filter((p) => path.basename(p) === base);
  return matches.length === 1 ? matches[0] : null; // nur bei Eindeutigkeit (sonst ehrlich: unklar)
}

/** B-50: bleibt rel (nach repoDir aufgelöst) innerhalb des Repos? (kein ../, kein absoluter/anderes-Laufwerk-Pfad) */
function withinRepo(repoDir, rel) {
  const root = path.resolve(repoDir ?? '.');
  const r = path.relative(root, path.resolve(root, String(rel ?? '')));
  return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r);
}

function defaultWalk(root, sub = '', acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, sub), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (/^(node_modules|\.git|\.maintenance)$/.test(e.name)) continue;
    const rel = sub ? path.join(sub, e.name) : e.name;
    if (e.isDirectory()) defaultWalk(root, rel, acc); else acc.push(rel.split(path.sep).join('/'));
  }
  return acc;
}

/**
 * ANALYSE-Phase: Mapping der eingebetteten Dateien → Herkunft, für das Manifest-JSON.
 * @returns Array<{file, build:'bundle'|'copy'|'unknown', sources:string[]}>
 */
export function detectEmbeddedAssets(exportSql, repoDir, deps = {}) {
  const exists = deps.exists ?? ((f) => fs.existsSync(f));
  const readText = deps.readText ?? ((f) => fs.readFileSync(f, 'utf8'));
  const embedded = [...new Set(embeddedFileNames(exportSql))];
  const gulpPath = repoDir ? path.join(repoDir, 'gulpfile.js') : null;
  const bundles = gulpPath && exists(gulpPath) ? parseGulpBundles(readText(gulpPath)) : [];
  const byBundle = new Map(bundles.map((b) => [b.bundle, b.sources]));
  return embedded.map((file) => {
    if (byBundle.has(file)) return { file, build: 'bundle', sources: byBundle.get(file) };
    const src = repoDir ? findRepoSource(repoDir, file, deps) : null;
    if (src) return { file, build: 'copy', sources: [src] };
    return { file, build: 'unknown', sources: [] }; // Herkunft unklar → beim Update nicht anfassbar (ehrlich)
  });
}

/**
 * UPDATE/IMPORT-Phase: eingebettete Dateien anhand des Asset-Mappings neu erzeugen und re-einbetten —
 * NUR wenn sich der Inhalt real ändert (kein Rausch). Reine Funktion (fs injizierbar).
 * @returns {sql, updated:[{file,bytes}], skipped:[{file,reason}]}
 */
export function reembedFromAssets(exportSql, assets, repoDir, deps = {}) {
  let sql = String(exportSql || '');
  const updated = [], skipped = [];
  for (const a of assets || []) {
    let buf = null;
    if (a.build === 'bundle') buf = buildBundle(repoDir, a.sources, deps);
    else if (a.build === 'copy' && a.sources[0]) { try { const b = (deps.readBuf ?? ((f) => fs.readFileSync(f)))(path.join(repoDir, a.sources[0])); buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); } catch { buf = null; } }
    if (!buf || !buf.length) { skipped.push({ file: a.file, reason: a.build === 'unknown' ? 'Herkunft unbekannt' : 'Quelle fehlt/leer' }); continue; }
    const cur = decodeEmbeddedFile(sql, a.file);
    if (cur && Buffer.compare(cur, buf) === 0) { skipped.push({ file: a.file, reason: 'unverändert' }); continue; }
    const r = reembedFile(sql, a.file, buf);
    if (!r.ok) { skipped.push({ file: a.file, reason: r.reason }); continue; }
    sql = r.sql; updated.push({ file: a.file, bytes: buf.length });
  }
  return { sql, updated, skipped };
}
