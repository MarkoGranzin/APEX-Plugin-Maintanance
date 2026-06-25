/**
 * T-20 — Inline-PL/SQL-JS extrahieren (apex_javascript.add_inline_code / htp.p('<script>…')).
 *
 * Der aufwändigste Fall: JS, das als String IM PL/SQL-Render-Code steckt. Tolerantes Herauslösen,
 * sourceMap mit EXAKTER Position im SQL (Offsets) für die Re-Injektion (T-25). Reine Literale (auch
 * '||'-Konkatenation von Literalen) werden extrahiert; verschachtelte/dynamische Concats mit
 * Nicht-Literalen werden NICHT geraten, sondern als "extraktion-unsicher → zu prüfen" markiert
 * (Wissen #510/#511).
 *
 * Resultat: src/extract/inline.js
 */

import { findCalls } from './extract.js';
import { skipString, unquote, requote } from './sql-scan.js';

/** Span (start/end innerhalb argsText) + Ausdruck des benannten bzw. ersten positionalen Arguments. */
function argSpan(argsText, name) {
  let start = 0;
  if (name) {
    const re = new RegExp(name + '\\s*=>\\s*', 'i');
    const m = re.exec(argsText);
    if (m) start = m.index + m[0].length;
    else if (/=>/.test(argsText)) return null; // benannte Args, aber nicht p_code → kein Treffer
  }
  let i = start;
  let depth = 0;
  while (i < argsText.length) {
    const c = argsText[i];
    if (c === "'") { i = skipString(argsText, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) break;
    i++;
  }
  return { start, end: i, expr: argsText.slice(start, i).trim() };
}

/** Wertet einen Ausdruck als (Konkatenation von) String-Literal(en) aus. */
function evalLiteralConcat(expr) {
  const parts = splitTopLevelConcat(expr);
  const chunks = [];
  for (const p of parts) {
    const m = p.trim().match(/^'((?:[^']|'')*)'$/);
    if (!m) return { ok: false };
    chunks.push(unquote(m[1]));
  }
  return { ok: true, text: chunks.join('') };
}

function splitTopLevelConcat(expr) {
  const parts = [];
  let i = 0;
  let last = 0;
  let depth = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'") { i = skipString(expr, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && expr[i + 1] === '|' && depth === 0) {
      parts.push(expr.slice(last, i));
      i += 2;
      last = i;
      continue;
    }
    i++;
  }
  parts.push(expr.slice(last));
  return parts;
}

const SCRIPT_RE = /^(\s*<script\b[^>]*>)([\s\S]*?)(<\/script>\s*)$/i;

/**
 * Extrahiert inline-JS aus einem SQL-Text.
 * @param {string} sql
 * @param {string} sqlFile
 * @returns {{inline:{name:string,code:string,origin:object}[], unsafe:{reason:string,location:object}[]}}
 */
export function extractInlineJs(sql, sqlFile) {
  const inline = [];
  const unsafe = [];
  let n = 0;

  const handle = (call, callName, argName, requireScript) => {
    const span = argSpan(call.argsText, argName);
    if (!span || !span.expr) return;
    const evaled = evalLiteralConcat(span.expr);
    const absStart = call.argStart + span.start;
    const absEnd = call.argStart + span.end;

    if (!evaled.ok) {
      unsafe.push({ reason: `${callName}: dynamisch zusammengesetztes JS — nicht eindeutig auflösbar`, location: { sqlFile, absStart, absEnd } });
      return;
    }

    let code = evaled.text;
    let wrap = null;
    const sm = code.match(SCRIPT_RE);
    if (sm) {
      wrap = { pre: sm[1], post: sm[3] };
      code = sm[2];
    } else if (requireScript) {
      return; // htp.p ohne <script> ist HTML, kein Inline-JS
    }

    const name = `${sqlFile.split('/').pop().replace(/\.[^.]+$/, '')}.inline${++n}.js`;
    inline.push({
      name,
      code,
      origin: { type: 'inline', sqlFile, call: callName, absStart, absEnd, wrap, form: span.expr.includes('||') ? 'concat' : 'literal' },
    });
  };

  for (const call of findCalls(sql, 'add_inline_code')) handle(call, 'add_inline_code', 'p_code', false);
  // htp.prn zuerst, damit der spezifischere Name nicht von htp.p "geschluckt" wird
  for (const call of findCalls(sql, 'htp.prn')) handle(call, 'htp.prn', null, true);
  for (const call of findCalls(sql, 'htp.p')) handle(call, 'htp.p', null, true);

  return { inline, unsafe };
}

/** Baut aus gepatchtem inline-Code das PL/SQL-Literal zurück (für Re-Injektion T-25). */
export function buildInlineLiteral(newCode, origin) {
  const inner = origin.wrap ? origin.wrap.pre + newCode + origin.wrap.post : newCode;
  return `'${requote(inner)}'`;
}
