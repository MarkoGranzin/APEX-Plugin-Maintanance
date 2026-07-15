/**
 * T-29 / T-30 / T-31 — Review-Gates nach der Pflege, vor dem PR.
 *
 * Zwei Gates, sequentiell (Wissen E-7):
 *  - SECURITY (OWASP & ähnliche): statische Heuristiken (XSS via innerHTML/document.write,
 *    eval/Function, hartkodierte Secrets, javascript:-URLs) + CVE-Libs aus dem SBOM (T-7) +
 *    optional ein injizierbarer Security-Agent (Skill security-review).
 *  - CODE-QUALITÄT: lose Enden (TODO/FIXME/debugger/empty-catch), unbenutzte Variablen,
 *    übermäßige Komplexität (AST) + optional ein Reviewer-Agent (Skills code-review/simplify).
 * Gate-Regel: PR nur, wenn beide ohne blockierende Findings sind. Reviewer sind injizierbar →
 * deterministisch testbar.
 *
 * Resultat: src/run/review.js
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const atLeast = (sev, threshold) => RANK[sev] >= RANK[threshold];

// ---------------- Security (T-29) ----------------

const SECURITY_RULES = [
  { rule: 'xss-innerHTML', re: /\.(inner|outer)HTML\s*=/, severity: 'high', msg: 'Assignment to innerHTML/outerHTML — XSS risk (escape or use textContent)' },
  { rule: 'xss-insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/, severity: 'medium', msg: 'insertAdjacentHTML — XSS risk with unchecked input' },
  { rule: 'xss-document-write', re: /document\.write(ln)?\s*\(/, severity: 'high', msg: 'document.write — XSS/injection risk' },
  { rule: 'code-injection-eval', re: /\beval\s*\(/, severity: 'high', msg: 'eval() — code injection' },
  { rule: 'code-injection-function', re: /\bnew\s+Function\s*\(/, severity: 'high', msg: 'new Function() — code injection' },
  { rule: 'hardcoded-secret', re: /(ghp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/, severity: 'critical', msg: 'Hardcoded secret in code' },
  { rule: 'js-url', re: /['"]javascript:/i, severity: 'medium', msg: 'javascript: URL — potential injection' },
];

/** OWASP-orientierte statische Prüfung eines Assets. */
export function securityScan(code) {
  const findings = [];
  for (const r of SECURITY_RULES) {
    if (r.re.test(code)) findings.push({ rule: r.rule, severity: r.severity, message: r.msg });
  }
  return findings;
}

/**
 * Security-Review eines Change-Sets.
 * @param {{assets:{name:string,code:string}[], cve?:{lib:string,version:string,vuln:string}[]}} change
 * @param {{threshold?:string, ack?:Set<string>, reviewer?:Function}} [opts]
 */
export function securityReview(change, opts = {}) {
  const threshold = opts.threshold ?? 'medium';
  const ack = opts.ack ?? new Set();
  const findings = [];

  for (const asset of change.assets ?? []) {
    for (const f of securityScan(asset.code)) findings.push({ ...f, asset: asset.name, id: `${f.rule}:${asset.name}` });
  }
  for (const v of change.cve ?? []) {
    findings.push({ rule: 'vulnerable-dependency', severity: 'high', asset: v.lib, id: `cve:${v.lib}@${v.version}`, message: `Vulnerable lib ${v.lib}@${v.version} (${v.vuln})` });
  }
  if (opts.reviewer) {
    for (const f of opts.reviewer(change) ?? []) findings.push({ severity: 'medium', ...f, id: f.id ?? `agent:${f.rule ?? 'finding'}:${f.asset ?? ''}` });
  }

  const blocking = findings.filter((f) => atLeast(f.severity, threshold) && !ack.has(f.id));
  return { gate: 'security', pass: blocking.length === 0, findings, blocking };
}

// ---------------- Code-Qualität (T-30) ----------------

const QUALITY_PATTERNS = [
  { rule: 'loose-end-todo', re: /\b(TODO|FIXME|XXX|HACK)\b/, severity: 'medium', msg: 'Loose ends: TODO/FIXME/XXX/HACK in code' },
  { rule: 'loose-end-debugger', re: /\bdebugger\b/, severity: 'medium', msg: 'leftover debugger statement' },
  { rule: 'loose-end-empty-catch', re: /catch\s*\([^)]*\)\s*\{\s*\}/, severity: 'medium', msg: 'Empty catch block (swallowed error)' },
  { rule: 'console-log', re: /console\.(log|debug)\s*\(/, severity: 'low', msg: 'leftover console.log/debug' },
];

/** Heuristik + AST-Prüfung eines Assets auf Qualität/lose Enden. */
export function qualityScan(code, opts = {}) {
  const findings = [];
  for (const p of QUALITY_PATTERNS) {
    if (p.re.test(code)) findings.push({ rule: p.rule, severity: p.severity, message: p.msg });
  }

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch {
    return findings; // Parsefehler ist Sache des Lint-Gates (T-23), nicht hier
  }

  // unbenutzte lokale Variablen (deklariert, nie referenziert)
  const declared = new Map(); // name -> declarator node
  const usage = new Map();
  walk.simple(ast, {
    VariableDeclarator(n) { if (n.id?.type === 'Identifier') declared.set(n.id.name, true); },
    Identifier(n) { usage.set(n.name, (usage.get(n.name) ?? 0) + 1); },
  });
  for (const name of declared.keys()) {
    if ((usage.get(name) ?? 0) <= 1) {
      findings.push({ rule: 'unused-variable', severity: 'medium', message: `Unused variable: ${name}` });
    }
  }

  // übermäßige Komplexität je Funktion (Entscheidungspunkte)
  const maxComplexity = opts.maxComplexity ?? 10;
  walk.simple(ast, {
    FunctionDeclaration(fn) { checkFn(fn); },
    FunctionExpression(fn) { checkFn(fn); },
    ArrowFunctionExpression(fn) { checkFn(fn); },
  });
  function checkFn(fn) {
    let dp = 1;
    walk.simple(fn.body ?? {}, {
      IfStatement() { dp++; }, ForStatement() { dp++; }, ForInStatement() { dp++; }, ForOfStatement() { dp++; },
      WhileStatement() { dp++; }, DoWhileStatement() { dp++; }, SwitchCase() { dp++; }, ConditionalExpression() { dp++; },
      LogicalExpression() { dp++; }, CatchClause() { dp++; },
    });
    if (dp > maxComplexity) {
      findings.push({ rule: 'complexity', severity: 'medium', message: `Function too complex (score ${dp} > ${maxComplexity})` });
    }
  }

  return findings;
}

/**
 * Code-Qualitäts-Review eines Change-Sets.
 * @param {{assets:{name:string,code:string}[]}} change
 * @param {{threshold?:string, reviewer?:Function, maxComplexity?:number}} [opts]
 */
export function qualityReview(change, opts = {}) {
  const threshold = opts.threshold ?? 'medium';
  const findings = [];
  for (const asset of change.assets ?? []) {
    for (const f of qualityScan(asset.code, opts)) findings.push({ ...f, asset: asset.name, id: `${f.rule}:${asset.name}` });
  }
  if (opts.reviewer) {
    for (const f of opts.reviewer(change) ?? []) findings.push({ severity: 'medium', ...f, id: f.id ?? `agent:${f.rule ?? 'finding'}:${f.asset ?? ''}` });
  }
  const blocking = findings.filter((f) => atLeast(f.severity, threshold));
  return { gate: 'quality', pass: blocking.length === 0, findings, blocking };
}

// ---------------- Orchestrierung (T-31) ----------------

/**
 * Führt Security- dann Code-Review aus. Approved nur, wenn beide ohne blockierende Findings.
 * @param {object} change  { assets, cve? }
 * @param {object} [deps]   security/quality (override) + *Opts; sonst die Default-Reviews
 * @returns {{pass:boolean, stage:'security'|'quality'|'approved', security:object, quality?:object}}
 */
export function reviewGate(change, deps = {}) {
  const security = (deps.security ?? securityReview)(change, deps.securityOpts ?? {});
  if (!security.pass) return { pass: false, stage: 'security', security };

  const quality = (deps.quality ?? qualityReview)(change, deps.qualityOpts ?? {});
  if (!quality.pass) return { pass: false, stage: 'quality', security, quality };

  return { pass: true, stage: 'approved', security, quality };
}
