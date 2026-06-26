/**
 * T-62 — Tiefen-AST-Analyse als Basis für umfassende Testgenerierung.
 *
 * Liefert je Funktion: Name, Parameter, Verzweigungen (if/loop/switch/ternary/logical),
 * Fehlerpfade (throw), Rückgaben, DOM-Operationen, gebundene Events (+ Selektoren) und apex.*-Aufrufe.
 * Zusätzlich global die Vereinigung erkannter Events/Selektoren für Coded-UI-Tests.
 * Reine Analyse (kein Netz) — Grundlage für testplan-deep (T-63) und codegen-ui (T-64).
 *
 * Resultat: src/test/analyze-deep.js
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function paramName(p) {
  if (!p) return 'arg';
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'AssignmentPattern') return paramName(p.left);
  if (p.type === 'RestElement') return '...' + paramName(p.argument);
  if (p.type === 'ObjectPattern') return '{…}';
  if (p.type === 'ArrayPattern') return '[…]';
  return 'arg';
}

function memberPath(node) {
  const parts = [];
  let cur = node;
  while (cur?.type === 'MemberExpression') {
    if (cur.property?.type === 'Identifier') parts.unshift(cur.property.name);
    else if (cur.property?.type === 'Literal') parts.unshift(String(cur.property.value));
    cur = cur.object;
  }
  if (cur?.type === 'Identifier') parts.unshift(cur.name);
  return parts.join('.');
}

/** Selektor aus dem Objekt eines Event-Bindings ($('#x') / document.querySelector('.y') / getElementById). */
function selectorOf(o) {
  if (o?.type !== 'CallExpression') return null;
  const c = o.callee;
  const arg = o.arguments?.[0];
  const lit = arg?.type === 'Literal' ? String(arg.value) : null;
  if (!lit) return null;
  if (/[<>]/.test(lit)) return null; // $('<span>') ist Element-ERZEUGUNG, kein Selektor (B-16)
  if (c?.type === 'Identifier' && (c.name === '$' || c.name === 'jQuery')) return lit;
  if (c?.type === 'MemberExpression') {
    const m = c.property?.name;
    if (m === 'querySelector' || m === 'querySelectorAll') return lit;
    if (m === 'getElementById') return '#' + lit;
  }
  return null;
}

function fnName(node, ancestors) {
  if (node.id?.name) return node.id.name;
  const parent = ancestors[ancestors.length - 2];
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if (parent?.type === 'AssignmentExpression') return memberPath(parent.left) || 'anonymous';
  if (parent?.type === 'Property' && parent.key) return parent.key.name ?? String(parent.key.value);
  if (parent?.type === 'MethodDefinition' && parent.key) return parent.key.name ?? String(parent.key.value);
  return 'anonymous';
}

/** Analysiert EINEN Funktionsknoten (Verzweigungen/Throws/DOM/Events/apex innerhalb seines Körpers). */
function analyzeFn(node, name) {
  const f = { name, params: (node.params ?? []).map(paramName), branches: 0, branchKinds: [], throws: 0, returns: 0, domOps: [], events: [], apexCalls: [], selectors: [] };
  const body = node.body ?? {};
  walk.simple(body, {
    IfStatement() { f.branches++; f.branchKinds.push('if'); },
    ForStatement() { f.branches++; f.branchKinds.push('for'); },
    ForInStatement() { f.branches++; f.branchKinds.push('for-in'); },
    ForOfStatement() { f.branches++; f.branchKinds.push('for-of'); },
    WhileStatement() { f.branches++; f.branchKinds.push('while'); },
    DoWhileStatement() { f.branches++; f.branchKinds.push('do-while'); },
    SwitchCase(n) { if (n.test) { f.branches++; f.branchKinds.push('case'); } },
    ConditionalExpression() { f.branches++; f.branchKinds.push('ternary'); },
    LogicalExpression() { f.branches++; f.branchKinds.push('logical'); },
    ThrowStatement() { f.throws++; },
    ReturnStatement() { f.returns++; },
    AssignmentExpression(n) {
      if (n.left?.type === 'MemberExpression' && /^(inner|outer)HTML$/.test(n.left.property?.name ?? '')) f.domOps.push(n.left.property.name);
    },
    CallExpression(n) {
      const callee = n.callee;
      const path = memberPath(callee);
      if (path.startsWith('apex.')) f.apexCalls.push(path);
      const m = callee?.type === 'MemberExpression' ? callee.property?.name : null;
      if (m === 'on' || m === 'addEventListener') {
        const ev = n.arguments?.[0];
        if (ev?.type === 'Literal' && typeof ev.value === 'string') f.events.push({ type: ev.value.split(' ')[0], selector: selectorOf(callee.object) });
      } else if (['click', 'change', 'submit', 'focus', 'blur', 'keyup', 'keydown'].includes(m) && n.arguments?.length) {
        f.events.push({ type: m, selector: selectorOf(callee.object) });
      }
      if (['querySelector', 'querySelectorAll', 'getElementById', 'appendChild', 'createElement', 'removeChild', 'setAttribute'].includes(m)) f.domOps.push(m);
      const sel = selectorOf(n);
      if (sel) f.selectors.push(sel);
    },
  });
  // Dedup
  f.domOps = [...new Set(f.domOps)];
  f.apexCalls = [...new Set(f.apexCalls)];
  f.selectors = [...new Set(f.selectors)];
  return f;
}

/**
 * Tiefenanalyse eines JS-Assets.
 * @param {string} code
 * @returns {{ok:boolean, functions:Array, events:Array, selectors:string[], totals:object, error?:string}}
 */
export function analyzeDeep(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (err) {
    return { ok: false, functions: [], events: [], selectors: [], totals: {}, error: String(err?.message ?? err) };
  }
  const functions = [];
  walk.ancestor(ast, {
    FunctionDeclaration(n, _s, anc) { functions.push(analyzeFn(n, fnName(n, anc))); },
    FunctionExpression(n, _s, anc) { functions.push(analyzeFn(n, fnName(n, anc))); },
    ArrowFunctionExpression(n, _s, anc) { functions.push(analyzeFn(n, fnName(n, anc))); },
  });
  // benannte Funktionen bevorzugen, Dubletten nach Name+Param-Zahl zusammenfassen
  const named = functions.filter((f) => f.name !== 'anonymous');
  const list = named.length ? named : functions;

  const events = [];
  const selectors = new Set();
  for (const f of list) { events.push(...f.events); for (const s of f.selectors) selectors.add(s); }
  const dedupEvents = [];
  const seen = new Set();
  for (const e of events) { const k = `${e.type}|${e.selector ?? ''}`; if (!seen.has(k)) { seen.add(k); dedupEvents.push(e); } }

  const totals = {
    functions: list.length,
    params: list.reduce((a, f) => a + f.params.length, 0),
    branches: list.reduce((a, f) => a + f.branches, 0),
    throws: list.reduce((a, f) => a + f.throws, 0),
    events: dedupEvents.length,
    selectors: selectors.size,
  };
  return { ok: true, functions: list, events: dedupEvents, selectors: [...selectors], totals };
}
