/**
 * B-40 — Lib-Update WIRKLICH ausliefern: die gebündelten, in die Plugin-.sql eingebetteten Dateien
 * neu bauen und re-einbetten (statt nur die Quell-Libs in js/lib/ zu tauschen).
 *
 * Hintergrund: Viele APEX-Plugins (RonnyWeiss-Muster) laden zur Laufzeit NICHT js/lib/*.js, sondern
 * gebündelte Dateien (z.B. bida-chart.pkgd.min.js), die ein Build (gulp concat) aus js/lib/ erzeugt und
 * die als HEX-Blob (create_plugin_file → g_varchar2_table → varchar2_to_blob) in der Plugin-.sql liegen.
 * Genau diese .sql wird in APEX installiert. Ein Update von js/lib/ allein erreicht das Plugin NIE.
 *
 * Dieses Modul repliziert den concat-Schritt deterministisch (kein fremder Build nötig) und ersetzt den
 * HEX-Content der betroffenen eingebetteten Datei in der .sql — bit-genau im APEX-Exportformat.
 * Alles rein/injizierbar → unit-testbar ohne Netz/Browser.
 *
 * Resultat: src/service/plugin-bundle.js
 */

import fs from 'node:fs';
import path from 'node:path';

/** Liest aus einem gulpfile die concat-Bündel: [{ bundle:'bida.pkgd.min.js', sources:['./js/lib/..'] }]. */
export function parseGulpBundles(gulpSrc) {
  const out = [];
  const re = /gulp\.src\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")\s*\)[\s\S]*?\.pipe\(\s*concat\(\s*(?:\{\s*path\s*:\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(gulpSrc))) {
    const raw = m[1];
    const sources = raw.trim().startsWith('[')
      ? [...raw.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
      : [raw.replace(/['"]/g, '')];
    out.push({ bundle: m[2], sources });
  }
  return out;
}

/** Löst die gulp-Quellen (auch einfache Globs wie ./css/*.css) zu echten Dateipfaden im Repo auf. */
export function resolveSources(repoDir, sources, deps = {}) {
  const listDir = deps.listDir ?? ((d) => fs.readdirSync(d));
  const exists = deps.exists ?? ((f) => fs.existsSync(f));
  const files = [];
  for (const s of sources) {
    const rel = s.replace(/^\.\//, '');
    const gm = rel.match(/^(.*)\/\*\.([a-z0-9]+)$/i); // dir/*.ext
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

/** Baut den Bündel-Inhalt = Konkatenation der Quelldateien (wie gulp-concat, Trenner '\n'). @returns Buffer */
export function buildBundle(repoDir, sources, deps = {}) {
  const readBuf = deps.readBuf ?? ((f) => fs.readFileSync(f));
  const files = resolveSources(repoDir, sources, deps);
  if (!files.length) return null;
  const parts = files.map((f) => readBuf(f));
  const sep = Buffer.from('\n');
  const joined = [];
  parts.forEach((p, i) => { if (i) joined.push(sep); joined.push(Buffer.isBuffer(p) ? p : Buffer.from(String(p))); });
  return Buffer.concat(joined);
}

/** Erzeugt den APEX-Content-Block (begin … g_varchar2_table-HEX-Chunks … end; /) für die Bytes. */
export function buildContentBlock(buf, chunkBytes = 100) {
  const hex = Buffer.from(buf).toString('hex').toUpperCase();
  const lines = ['begin', 'wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;'];
  let idx = 1;
  for (let i = 0; i < hex.length; i += chunkBytes * 2) lines.push(`wwv_flow_api.g_varchar2_table(${idx++}) := '${hex.slice(i, i + chunkBytes * 2)}';`);
  if (idx === 1) lines.push("wwv_flow_api.g_varchar2_table(1) := '';"); // leere Datei → gültig bleiben
  lines.push('end;', '/', '');
  return lines.join('\n');
}

/** Namen aller in die .sql eingebetteten Plugin-Dateien. */
export function embeddedFileNames(exportSql) {
  return [...String(exportSql || '').matchAll(/p_file_name=>'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Ersetzt den eingebetteten Inhalt EINER Datei in der Plugin-.sql durch neue Bytes (APEX-Exportformat).
 * Findet den create_plugin_file-Block der Datei und tauscht den DIREKT davor liegenden Content-Block
 * (begin … g_varchar2_table … end; /). @returns {ok, sql}|{ok:false, reason}
 */
export function reembedFile(exportSql, fileName, buf) {
  const sql = String(exportSql || '');
  const marker = `,p_file_name=>'${fileName}'`;
  const fi = sql.indexOf(marker);
  if (fi < 0) return { ok: false, reason: `nicht eingebettet: ${fileName}` };
  const createCallIdx = sql.lastIndexOf('wwv_flow_api.create_plugin_file(', fi);
  if (createCallIdx < 0) return { ok: false, reason: 'create_plugin_file-Aufruf nicht gefunden' };
  const createBeginIdx = sql.lastIndexOf('begin', createCallIdx);
  const resetIdx = sql.lastIndexOf('wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;', createBeginIdx);
  if (resetIdx < 0) return { ok: false, reason: 'Content-Block (empty_varchar2_table) nicht gefunden' };
  const popBeginIdx = sql.lastIndexOf('begin', resetIdx);
  if (popBeginIdx < 0) return { ok: false, reason: 'begin des Content-Blocks nicht gefunden' };
  // Sicherheit: zwischen Content-Block und create darf KEIN weiterer create_plugin_file liegen.
  if (sql.slice(popBeginIdx, createBeginIdx).includes('create_plugin_file(')) return { ok: false, reason: 'unerwartete Blockstruktur' };
  const newSql = sql.slice(0, popBeginIdx) + buildContentBlock(buf) + sql.slice(createBeginIdx);
  return { ok: true, sql: newSql };
}

/**
 * Baut alle im gulpfile definierten Bündel neu (aus den — bereits aktualisierten — Quelldateien) und
 * re-embeddet die, die in der .sql eingebettet sind. Reine Funktion (Effekte injizierbar).
 * @returns {sql, updated:[{bundle, bytes}], skipped:[{bundle, reason}]}
 */
export function rebuildEmbeddedBundles({ repoDir, exportSql, gulpSrc }, deps = {}) {
  const bundles = parseGulpBundles(gulpSrc || '');
  const embedded = new Set(embeddedFileNames(exportSql));
  let sql = String(exportSql || '');
  const updated = [], skipped = [];
  for (const b of bundles) {
    if (!embedded.has(b.bundle)) { skipped.push({ bundle: b.bundle, reason: 'nicht in der .sql eingebettet' }); continue; }
    const buf = buildBundle(repoDir, b.sources, deps);
    if (!buf || !buf.length) { skipped.push({ bundle: b.bundle, reason: 'Quelldateien fehlen/leer' }); continue; }
    const r = reembedFile(sql, b.bundle, buf);
    if (!r.ok) { skipped.push({ bundle: b.bundle, reason: r.reason }); continue; }
    sql = r.sql; updated.push({ bundle: b.bundle, bytes: buf.length });
  }
  return { sql, updated, skipped };
}
