/**
 * F-30 (T-116) — Akzeptanz-Vertrag aus der Mock-Charakterisierung.
 *
 * Die grüne Charakterisierung des Mocks (window.__views/__features + „rendert echt") ist das SOLL des
 * Plugins. Hier wird sie als formaler, eingefrorener, TECHNOLOGIE-UNABHÄNGIGER Akzeptanz-Vertrag
 * festgehalten: nur beobachtbares Verhalten (Sicht + Feature-Check + „muss rendern"), keine
 * Implementierungs-/Lib-Details. Dieser Vertrag ist das Soll für jede Neuentwicklung (T-117): egal mit
 * welcher Technologie neu gebaut wird — erfüllt der neue Stand den Vertrag, gilt „works as before".
 *
 * Reine Funktionen (testbar ohne Browser); runMockSelfTests liefert den Ist-Stand.
 *
 * Resultat: src/service/acceptance.js
 */

import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Stabiler Schlüssel je Kriterium (Sicht + Feature) — technologieunabhängig. */
export function criterionKey(view, feature) { return `${norm(view).toLowerCase()}|||${norm(feature).toLowerCase()}`; }

/**
 * T-126 — Plugin-Schnittstelle normalisieren (APEX-Parameter/Attribute, JSON-Konfig). Akzeptiert die
 * Roh-Attribute aus mock.pluginInterface ({prompt,type,values,def,help}) ODER eine bereits normalisierte
 * Liste. Defaults werden NICHT gekürzt (JSON-Konfig muss vollständig erhalten bleiben).
 * @returns {{attributes:Array<{name,type,allowedValues:string[],default:string,help:string}>, count:number}}
 */
export function normalizeInterface(iface) {
  const raw = Array.isArray(iface) ? iface : (iface?.attributes || []);
  const seen = new Set();
  const attributes = raw
    .map((a) => ({
      name: norm(a.name ?? a.prompt ?? ''),
      type: norm(a.type ?? ''),
      allowedValues: Array.isArray(a.allowedValues) ? a.allowedValues.slice() : (Array.isArray(a.values) ? a.values.slice() : []),
      default: String(a.default ?? a.def ?? '').trim(),   // vollständig, nicht kürzen (JSON!)
      help: norm(a.help ?? ''),
    }))
    .filter((a) => a.name)
    .filter((a) => { const k = `${a.name}|${a.type}|${a.default}|${a.allowedValues.join('|')}`; if (seen.has(k)) return false; seen.add(k); return true; }); // identische Deklarationen entdoppeln
  return { attributes, count: attributes.length };
}

/**
 * Leitet den Akzeptanz-Vertrag aus einem runMockSelfTests-Ergebnis ab: alle GRÜNEN Feature-Checks
 * (rote/falsch-grüne werden NICHT zum Soll — der Vertrag beschreibt nur verlässlich erfülltes Verhalten).
 * @param {{views?:number, rendered?:boolean, features?:Array<{view,feature,ok,detail}>, problems?:Array, total?:number}} st
 * @param {{name?:string, at?:string}} opts
 * @returns {{name, views, renderedRequired, criteria:Array<{view,feature}>, total, source, capturedAt}|{error}}
 */
export function acceptanceFromSelfTest(st, opts = {}) {
  if (!st || !st.ran || !Array.isArray(st.features)) return { error: 'no self-test result' };
  // Nur echte grüne Checks; falsch-grüne (Dependency/leeres Rendern) sind KEIN gültiges Soll.
  const badKeys = new Set((st.problems || []).map((p) => criterionKey(p.view, p.feature)));
  const seen = new Set();
  const criteria = [];
  for (const f of st.features) {
    if (!f || f.ok === false) continue;
    const k = criterionKey(f.view, f.feature);
    if (badKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    criteria.push({ view: norm(f.view), feature: norm(f.feature) });
  }
  return {
    name: opts.name || null,
    views: st.views || new Set(criteria.map((c) => c.view)).size,
    renderedRequired: st.rendered !== false, // das Plugin MUSS echt rendern (kein leerer/Fehler-Stand)
    criteria,
    total: criteria.length,
    // T-126: exakte Schnittstelle (APEX-Parameter/Attribute, JSON-Konfig) als Teil des Soll-Vertrags.
    interface: opts.interface ? normalizeInterface(opts.interface) : null,
    source: 'mock-characterization',
    capturedAt: opts.at || null,
  };
}

/**
 * Prüft einen neuen Self-Test-Stand gegen den Vertrag: jedes Soll-Kriterium muss vorhanden UND grün sein,
 * und (falls gefordert) das Plugin muss echt rendern. Technologieunabhängig — nur beobachtbares Verhalten zählt.
 * @returns {{pass:boolean, satisfied:number, total:number, missing:Array, broken:Array, renderOk:boolean}}
 */
export function compareAcceptance(contract, st) {
  const criteria = contract?.criteria || [];
  const byKey = new Map();
  for (const f of (st?.features || [])) byKey.set(criterionKey(f.view, f.feature), f);
  const missing = []; const broken = [];
  for (const c of criteria) {
    const f = byKey.get(criterionKey(c.view, c.feature));
    if (!f) { missing.push(c); continue; }      // Kriterium gar nicht mehr geprüft → nicht erfüllt
    if (f.ok === false) broken.push(c);          // vorhanden, aber rot → Regress
  }
  const renderOk = contract?.renderedRequired ? (st?.rendered !== false) : true;
  const satisfied = criteria.length - missing.length - broken.length;
  const pass = missing.length === 0 && broken.length === 0 && renderOk && (st?.ran === true);
  return { pass, satisfied, total: criteria.length, missing, broken, renderOk };
}

const acceptancePath = (dir) => path.join(dir, '.maintenance', 'acceptance.json');

/** Vertrag neben dem Mock ablegen (reist mit dem eingecheckten Stand). Schreibt JSON UND die
 *  menschenlesbare .feature (inkl. Schnittstelle) — damit der Vertrag als Datei auffindbar ist. */
export function writeAcceptance(dir, contract) {
  try {
    const p = acceptancePath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(contract, null, 2));
    // T-126/T-127: zusätzlich die lesbare .feature (Schnittstelle + native + Kriterien) ablegen.
    try { fs.writeFileSync(path.join(path.dirname(p), 'acceptance.feature'), acceptanceFeatureFile(contract, { name: contract?.name })); } catch { /* best effort */ }
    return p;
  } catch { return null; }
}

/** Vertrag lesen (oder null, wenn nicht vorhanden/unlesbar). */
export function readAcceptance(dir) {
  try { return JSON.parse(fs.readFileSync(acceptancePath(dir), 'utf8')); } catch { return null; }
}

// ── T-120: Anforderungen exportierbar + devhub-tauglich ───────────────────────────────────────────

/**
 * Wandelt den Akzeptanz-Vertrag in Gherkin-Szenarien [{title, gherkin}] um — exakt das Format, das
 * devhub set_tests erwartet (1:1 importierbar). Je Kriterium ein Szenario; technologie-unabhängig.
 */
export function acceptanceToScenarios(contract, opts = {}) {
  const name = opts.name || contract?.name || 'plugin';
  const out = [];
  // KOPF-Kriterium: das Plugin muss NATIV wie zuvor funktionieren — der Maßstab für Migration UND Selbst-Fix.
  out.push({ title: `${name}: works natively as before`, gherkin: `Given the plugin "${name}" is loaded in its real (native) environment\nWhen it is initialized\nThen it runs without JS errors and provides the same visible functionality as before maintenance (all views/features as in the original)` });
  if (contract?.renderedRequired) {
    out.push({ title: `${name}: renders real output`, gherkin: `Given the plugin "${name}" is loaded\nWhen it initializes\nThen it produces real visible output (no empty/error state)` });
  }
  // T-126: Schnittstelle exakt als eigenes Szenario — Migration/Neuentwicklung muss sie 1:1 erhalten.
  const iface = contract?.interface?.attributes || [];
  if (iface.length) {
    const lines = iface.map((a) => {
      let l = `And parameter "${a.name}"${a.type ? ` [${a.type}]` : ''}`;
      if (a.allowedValues?.length) l += ` allowed: ${a.allowedValues.join(' | ')}`;
      if (a.default) l += ` — default: ${a.default}`;
      return l;
    });
    out.push({
      title: `${name}: interface (parameters/configuration) is preserved exactly`,
      gherkin: [
        `Given the plugin "${name}" is called with the same APEX attributes/JSON parameters as before maintenance`,
        `When the migrated/newly developed version is loaded`,
        `Then it accepts exactly the same ${iface.length} parameters (name, type, allowed values, default)`,
        ...lines,
      ].join('\n'),
    });
  }
  for (const c of contract?.criteria || []) {
    const view = c.view || 'default';
    out.push({
      title: `${view}: ${c.feature}`.slice(0, 120),
      gherkin: `Given the plugin "${name}" is loaded in the view "${view}"\nWhen the view is rendered and operated\nThen ${c.feature}`,
    });
  }
  return out;
}

/** T-126: exakter, menschenlesbarer Schnittstellen-Block für die .feature (Kommentarzeilen, ungekürzt). */
function interfaceBlock(contract) {
  const iface = contract?.interface?.attributes || [];
  if (!iface.length) return '';
  const out = [
    `# ── Interface (APEX plugin parameters / configuration) — must be preserved EXACTLY ──`,
    `# ${iface.length} parameters:`,
  ];
  for (const a of iface) {
    out.push(`#   • ${a.name}${a.type ? ` [${a.type}]` : ''}`);
    if (a.allowedValues?.length) out.push(`#       allowed values: ${a.allowedValues.join(' | ')}`);
    if (a.default) out.push(`#       default: ${a.default}`);
    if (a.help) out.push(`#       help: ${a.help}`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

/** Exportierbare .feature-Datei (Gherkin) des Akzeptanz-Vertrags — technologie-unabhängiges Soll. */
export function acceptanceFeatureFile(contract, opts = {}) {
  const name = opts.name || contract?.name || 'plugin';
  const scen = acceptanceToScenarios(contract, { name });
  const head = [
    `# Acceptance contract for ${name} — "works as before"`,
    `# Automatically derived from the mock characterization (technology-independent).`,
    `# ${contract?.views ?? '?'} view(s), ${contract?.total ?? scen.length} criterion/criteria${contract?.interface?.count ? `, ${contract.interface.count} interface parameters` : ''}${contract?.capturedAt ? `, as of ${contract.capturedAt}` : ''}.`,
    '',
    interfaceBlock(contract),
    `Feature: ${name} — acceptance criteria (migration/redevelopment must satisfy all)`,
    '',
  ].join('\n');
  const body = scen.map((s) => `  Scenario: ${s.title}\n` + s.gherkin.split('\n').map((l) => '    ' + l).join('\n')).join('\n\n');
  return head + body + '\n';
}

/** devhub-tauglicher Block: vorgeschlagener Item-Titel + Szenarien (für create_item + set_tests). */
export function acceptanceToDevhub(contract, opts = {}) {
  const name = opts.name || contract?.name || 'plugin';
  return { itemTitle: `${name}: Akzeptanzkriterien (works as before)`, type: 'feature', scenarios: acceptanceToScenarios(contract, { name }) };
}
