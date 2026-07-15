/**
 * T-21 — AST-Analyse des kanonischen JS: Einstiegspunkte, apex.*-/jQuery-/AJAX-Aufrufe,
 *          DOM-Zugriffe (acorn/acorn-walk).
 *
 * Warum AST statt Heuristik (Wissen #510): der Fremdcode ist stilistisch uneinheitlich
 * (IIFE vs. globale Funktionen, apex.jQuery vs. $). Eine namens-/musterbasierte Suche
 * bricht daran. Die AST-Analyse liefert einen reproduzierbaren, strukturierten Testkontext;
 * deterministisch — eine KI urteilt nur über das ERGEBNIS, nicht über das Parsen.
 *
 * Resultat: src/extract/analyze.js
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

/** Wandelt eine MemberExpression-Kette in einen gepunkteten Pfad (z.B. apex.server.process). */
export function memberPath(node) {
  const parts = [];
  let cur = node;
  while (cur) {
    if (cur.type === 'MemberExpression') {
      if (cur.computed) {
        parts.unshift(cur.property.type === 'Literal' ? String(cur.property.value) : '[…]');
      } else {
        parts.unshift(cur.property.name);
      }
      cur = cur.object;
    } else if (cur.type === 'Identifier') {
      parts.unshift(cur.name);
      cur = null;
    } else if (cur.type === 'ThisExpression') {
      parts.unshift('this');
      cur = null;
    } else if (cur.type === 'CallExpression') {
      cur = cur.callee;
    } else {
      parts.unshift('?');
      cur = null;
    }
  }
  return parts.join('.');
}

const JQUERY_ROOTS = new Set(['$', 'jQuery']);
const AJAX_PATHS = [/^apex\.server\.(process|plugin|chunk|url)/, /^\$\.(ajax|get|post|getJSON)/, /^fetch$/, /^jQuery\.(ajax|get|post)/];
const DOM_GLOBALS = new Set(['document', 'window']);

/**
 * Analysiert kanonisches JS und liefert einen strukturierten Testkontext.
 * @param {string} code
 * @returns {{ok:true, entryPoints:string[], apexCalls:string[], jqueryCalls:string[], ajaxCalls:string[], domAccess:string[]} | {ok:false, error:string}}
 */
export function analyzeJs(code) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      sourceType: 'script',
    });
  } catch (err) {
    return { ok: false, error: `Parse error: ${err.message}` };
  }

  const entryPoints = new Set();
  const apexCalls = new Set();
  const jqueryCalls = new Set();
  const ajaxCalls = new Set();
  const domAccess = new Set();

  const noteCall = (path) => {
    if (/^apex\./.test(path)) apexCalls.add(path);
    const root = path.split('.')[0];
    if (JQUERY_ROOTS.has(root) || path.startsWith('apex.jQuery')) jqueryCalls.add(path);
    if (AJAX_PATHS.some((re) => re.test(path))) ajaxCalls.add(path);
  };

  walk.full(ast, (node) => {
    // Aufrufe
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'MemberExpression' || node.callee.type === 'Identifier') {
        const path = memberPath(node.callee);
        if (path) noteCall(path);
      }
    }
    // DOM-Zugriffe: document.* / window.* Member
    if (node.type === 'MemberExpression') {
      const root = rootIdentifier(node);
      if (DOM_GLOBALS.has(root)) {
        const p = memberPath(node);
        if (p !== root) domAccess.add(p);
      }
    }
  });

  // Einstiegspunkte — mehrere Stile abdecken
  walk.simple(ast, {
    FunctionDeclaration(n) {
      if (n.id?.name) entryPoints.add(n.id.name);
    },
    VariableDeclarator(n) {
      if (n.id?.name && n.init && /FunctionExpression|ArrowFunctionExpression/.test(n.init.type)) {
        entryPoints.add(n.id.name);
      }
    },
    AssignmentExpression(n) {
      if (
        n.left.type === 'MemberExpression' &&
        n.right &&
        /FunctionExpression|ArrowFunctionExpression/.test(n.right.type)
      ) {
        entryPoints.add(memberPath(n.left));
      }
    },
    // Modul-Pattern: `return { init: function(){}, refresh: ()=>{} }`
    ReturnStatement(n) {
      if (n.argument?.type === 'ObjectExpression') {
        for (const prop of n.argument.properties) {
          if (
            prop.type === 'Property' &&
            prop.value &&
            /FunctionExpression|ArrowFunctionExpression/.test(prop.value.type)
          ) {
            const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
            entryPoints.add(key);
          }
        }
      }
    },
  });

  return {
    ok: true,
    entryPoints: [...entryPoints].sort(),
    apexCalls: [...apexCalls].sort(),
    jqueryCalls: [...jqueryCalls].sort(),
    ajaxCalls: [...ajaxCalls].sort(),
    domAccess: [...domAccess].sort(),
  };
}

function rootIdentifier(memberNode) {
  let cur = memberNode;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  return cur?.type === 'Identifier' ? cur.name : null;
}

/** Analysiert alle JS-Assets eines kanonischen Bündels. */
export function analyzeBundle(bundle) {
  return bundle.js.map((asset) => ({ name: asset.name, analysis: analyzeJs(asset.code) }));
}
