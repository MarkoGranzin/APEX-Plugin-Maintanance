/**
 * T-19 — Extraktor MVP: Plugin-Dateien (base64-BLOB) + lose .js/.css + referenzierte URLs
 *          → kanonisches Bündel + sourceMap.
 *
 * Normalisierung vor allem (Wissen #510): EIN kanonisches Bündel
 *   { artifact, js[], css[], inlineCode[], referencedUrls[], sourceMap, unsafe[] }
 * ist die einzige stabile API; alles dahinter ist format-blind. Inline-in-PL/SQL ist
 * bewusst NICHT hier (→ T-20). Nicht sicher Extrahierbares wird markiert, NICHT geraten
 * (Wissen #511). Die sourceMap hält je Asset die Herkunft fest, damit ein späterer Fix
 * über T-25 zurückfindet.
 *
 * Resultat: src/extract/extract.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractInlineJs } from './inline.js';
import { skipString, unquote } from './sql-scan.js';
// B-75: Dekoder für das klassische HEX-Exportformat (varchar2_to_blob(g_varchar2_table) mit
// Chunk-Befüllung im Vorblock) — existiert bereits generisch im MCP-Modul (T-152), eine Wahrheit.
import { decodeEmbeddedFile } from '../../mcp-apex-deploy/lib/plugin-assets.js';

/** Findet alle Aufrufe `name(...)` mit balancierten Klammern; ignoriert Klammern in '..'-Literalen. */
export function findCalls(text, name) {
  const calls = [];
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'gi');
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "'") { i = skipString(text, i); continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    calls.push({ argsText: text.slice(start, i - 1), index: m.index, argStart: start, argEnd: i - 1 });
    re.lastIndex = i;
  }
  return calls;
}

const isLikelyBase64 = (s) => /^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/\s/g, '').length % 4 === 0;
const classify = (fileName) => (/\.css$/i.test(fileName) ? 'css' : /\.js$/i.test(fileName) ? 'js' : 'other');

/** Zieht eine Versionsnummer aus einer Asset-URL (billigster Treffer). */
export function versionFromUrl(url) {
  const m =
    url.match(/@(\d+\.\d+\.\d+(?:[-.][\w]+)?)/) ||
    url.match(/\/(\d+\.\d+\.\d+(?:[-.][\w]+)?)\//) ||
    url.match(/[-_v](\d+\.\d+\.\d+)(?=[.\-/])/i);
  return m ? m[1] : null;
}

/** Sammelt http(s)-Asset-URLs (.js/.css) aus einem Text. */
export function referencedUrlsFrom(text) {
  const urls = new Set();
  const re = /https?:\/\/[^\s'"()]+\.(?:js|css)(?:\?[^\s'"()]*)?/gi;
  let m;
  while ((m = re.exec(text))) urls.add(m[0]);
  return [...urls].map((url) => ({ url, version: versionFromUrl(url), kind: classify(url) }));
}

/** Liefert das Argument-Ausdrucks-Fragment hinter `p_x =>` (bis zum top-level Komma/Ende). */
function namedArgExpr(argsText, argName) {
  const re = new RegExp(argName + '\\s*=>\\s*', 'i');
  const m = re.exec(argsText);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  const start = i;
  while (i < argsText.length) {
    const c = argsText[i];
    if (c === "'") { i = skipString(argsText, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) break;
    i++;
  }
  return argsText.slice(start, i).trim();
}

/**
 * Wertet einen p_file_content-Ausdruck aus.
 * @returns {{ok:true, text:string} | {ok:false, reason:string}}
 */
function evalContentExpr(expr) {
  if (!expr) return { ok: false, reason: 'no p_file_content found' };

  // Fall 1: einzelnes String-Literal
  const lit = expr.match(/^'((?:[^']|'')*)'$/);
  if (lit) return decodeChunks([unquote(lit[1])]);

  // Fall 2: wwv_flow_api.g_varchar2_table('chunk', 'chunk', ...)
  if (/g_varchar2_table\s*\(/i.test(expr)) {
    const inner = findCalls(expr, 'g_varchar2_table')[0]?.argsText ?? '';
    const chunks = [...inner.matchAll(/'((?:[^']|'')*)'/g)].map((c) => unquote(c[1]));
    if (chunks.length === 0) return { ok: false, reason: 'g_varchar2_table without literal chunks' };
    // Falls auch nicht-literale Argumente enthalten sind → unsicher
    const onlyLiterals = inner.replace(/'(?:[^']|'')*'/g, '').replace(/[\s,]/g, '') === '';
    if (!onlyLiterals) return { ok: false, reason: 'g_varchar2_table contains non-literal parts' };
    return decodeChunks(chunks);
  }

  // Fall 3: Bezeichner/Funktionsaufruf/Konkatenation → dynamisch, nicht raten
  return { ok: false, reason: 'p_file_content is dynamic/non-literal — not unambiguously resolvable' };
}

function decodeChunks(chunks) {
  const joined = chunks.join('');
  if (!isLikelyBase64(joined)) {
    return { ok: false, reason: 'content is not decodable base64' };
  }
  try {
    return { ok: true, text: Buffer.from(joined, 'base64').toString('utf8') };
  } catch {
    return { ok: false, reason: 'base64 decoding failed' };
  }
}

/**
 * Extrahiert ein Artefakt in ein kanonisches Bündel.
 * @param {import('../inventory/inventory.js').Artifact} artifact
 * @param {object} [opts]
 * @param {(rel:string)=>string} [opts.readFile]
 * @returns {CanonicalBundle}
 */
export function extractArtifact(artifact, opts = {}) {
  const readFile =
    opts.readFile ?? ((rel) => fs.readFileSync(path.join(opts.rootDir ?? '.', rel), 'utf8'));

  const bundle = {
    artifact: artifact.name,
    js: [],
    css: [],
    inlineCode: [], // T-20 befüllt dies später
    referencedUrls: [],
    sourceMap: {},
    unsafe: [],
    status: 'ok',
  };

  // (2) lose .js/.css as-is — origin auch AM Asset (B-75: die Header-Fingerprint-Stufe unterscheidet
  // FS-Dateien von eingebetteten plugin_files, ohne die sourceMap konsultieren zu müssen).
  for (const f of artifact.jsFiles ?? []) {
    const origin = { type: 'file', path: f };
    bundle.js.push({ name: f.split('/').pop(), code: readFile(f), origin });
    bundle.sourceMap[f.split('/').pop()] = origin;
  }
  for (const f of artifact.cssFiles ?? []) {
    const origin = { type: 'file', path: f };
    bundle.css.push({ name: f.split('/').pop(), code: readFile(f), origin });
    bundle.sourceMap[f.split('/').pop()] = origin;
  }

  // (1)+(3) APEX-SQL-Export: base64-Plugin-Dateien dekodieren, referenzierte URLs sammeln
  for (const sqlFile of artifact.sqlFiles ?? []) {
    let sql = '';
    try {
      sql = readFile(sqlFile);
    } catch {
      continue;
    }

    for (const call of findCalls(sql, 'create_plugin_file')) {
      const fileName = (namedArgExpr(call.argsText, 'p_file_name') || '').match(/^'((?:[^']|'')*)'$/)?.[1];
      const name = fileName ? unquote(fileName) : null;
      const contentExpr = namedArgExpr(call.argsText, 'p_file_content');
      let res = evalContentExpr(contentExpr);

      // B-75: klassisches Exportformat — p_file_content referenziert die im VORBLOCK mit HEX-Chunks
      // befüllte g_varchar2_table (varchar2_to_blob(wwv_flow_api.g_varchar2_table)). Der generische
      // Dekoder (T-152) findet den Chunk-Block rückwärts vom create_plugin_file-Aufruf.
      if (!res.ok && name && /g_varchar2_table/i.test(contentExpr || '')) {
        const buf = decodeEmbeddedFile(sql, name);
        if (buf && buf.length) {
          const isCode = /\.(js|css|json)$/i.test(name);
          if (!isCode) continue; // LICENSE/Bilder: dekodierbar, aber kein Code-Asset — kein unsafe-Rauschen
          res = { ok: true, text: buf.toString('utf8') };
        }
      }

      if (!res.ok || !name) {
        bundle.unsafe.push({
          reason: res.ok ? 'p_file_name fehlt' : res.reason,
          location: { sqlFile, fileName: name ?? '(unbekannt)' },
        });
        continue; // NICHT raten
      }

      const kind = classify(name);
      const origin = { type: 'plugin_file', sqlFile, fileName: name, call: 'create_plugin_file' };
      const entry = { name, code: res.text, origin };
      if (kind === 'css') {
        bundle.css.push(entry);
      } else {
        bundle.js.push(entry); // .js und sonstige → js-Slot (MVP)
      }
      bundle.sourceMap[name] = origin;
    }

    // (3) referenzierte URLs (File URLs to Load / CDN)
    bundle.referencedUrls.push(...referencedUrlsFrom(sql));

    // (4) Inline-PL/SQL-JS (T-20): add_inline_code / htp.p('<script>…')
    const { inline, unsafe } = extractInlineJs(sql, sqlFile);
    for (const entry of inline) {
      bundle.inlineCode.push({ name: entry.name, code: entry.code });
      bundle.sourceMap[entry.name] = entry.origin;
    }
    bundle.unsafe.push(...unsafe);
  }

  // Dedup referencedUrls
  const seen = new Set();
  bundle.referencedUrls = bundle.referencedUrls.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  if (bundle.unsafe.length > 0 && bundle.js.length === 0 && bundle.css.length === 0) {
    bundle.status = 'extraktion-unsicher';
  } else if (bundle.unsafe.length > 0) {
    bundle.status = 'teilweise-unsicher';
  }

  return bundle;
}

/**
 * @typedef {Object} CanonicalBundle
 * @property {string} artifact
 * @property {{name:string,code:string}[]} js
 * @property {{name:string,code:string}[]} css
 * @property {{name:string,code:string,location:object}[]} inlineCode
 * @property {{url:string,version:(string|null),kind:string}[]} referencedUrls
 * @property {Record<string,object>} sourceMap   Herkunft je Asset (Rückweg für T-25)
 * @property {{reason:string,location:object}[]} unsafe
 * @property {'ok'|'teilweise-unsicher'|'extraktion-unsicher'} status
 */
