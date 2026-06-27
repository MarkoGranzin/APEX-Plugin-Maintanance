/**
 * F-30 (T-117) — Slice-weise Neuentwicklung gegen den Akzeptanz-Vertrag.
 *
 * Wenn eine Lib tot/nicht pflegbar ist, wird das Plugin NEU gebaut — Slice für Slice. Maßstab ist der
 * technologieunabhängige Akzeptanz-Vertrag (acceptance.js). Die TECHNOLOGIE ist frei wählbar; das EINZIGE
 * Tech-Gate ist die LIZENZ (kommerziell nutzbar, kein Copyleft/unbekannt). Je Slice: implementieren →
 * gegen die Slice-Kriterien prüfen → adopt bei grün, sonst rollback/rework (bis Limit). Am Ende muss der
 * KOMPLETTE Vertrag grün sein = „works as before" ohne den toten Lib.
 *
 * Orchestrierung mit injizierbarer KI/Selbsttest → deterministisch testbar.
 *
 * Resultat: src/service/redev-slices.js
 */

import { classifyLicense } from '../sbom/licenses.js';
import { compareAcceptance, readAcceptance } from './acceptance.js';
import { decideLibAction } from './lib-decision.js';

/**
 * Lizenz-Gate für eine frei gewählte Technologie: erlaubt nur kommerziell nutzbare, NICHT-copyleft Lizenzen
 * (pflichtenfrei oder mit Attribution). Copyleft/unbekannt → abgelehnt.
 * @returns {{allowed:boolean, license:string, level:string, obligations:string, reason:string}}
 */
export function licenseGate(license, deps = {}) {
  const classify = deps.classify ?? classifyLicense;
  const c = classify(license);
  const allowed = !!c.commercialOk && (c.obligations === 'none' || c.obligations === 'attribution');
  return {
    allowed, license: c.id, level: c.level, obligations: c.obligations,
    reason: allowed
      ? (c.obligations === 'attribution' ? 'erlaubt — Attribution beachten' : 'erlaubt — pflichtenfrei')
      : `abgelehnt — ${c.reason}`,
  };
}

/** Zerlegt den Akzeptanz-Vertrag in Slices (eine Sicht = ein Slice) — natürliche, prüfbare Einheiten. */
export function planSlices(contract) {
  const byView = new Map();
  for (const c of contract?.criteria || []) {
    const v = c.view || 'default';
    if (!byView.has(v)) byView.set(v, []);
    byView.get(v).push(c);
  }
  return [...byView.entries()].map(([view, criteria], index) => ({ index, view, criteria }));
}

/** Prompt für den Neubau EINES Slice — technologie-frei, lizenz-gegatet, nur beobachtbare Kriterien als Soll. */
export function buildSliceRebuildPrompt(slice, contract, ctx = {}) {
  const { name = 'the plugin', deadLib } = ctx;
  const crit = (slice.criteria || []).map((c, i) => `${i + 1}. ${c.feature}`).join('\n') || '(none)';
  return `You are rebuilding ONE slice of the Oracle APEX plugin "${name}" from scratch${deadLib ? `, because the library "${deadLib}" is dead/unmaintained and must go` : ''}.
Slice = view "${slice.view}". It MUST satisfy EXACTLY these observable acceptance criteria (works-as-before), no more, no less:
${crit}

Rules:
- You may use ANY technology (a maintained library, a framework, or your own code). The underlying technology does NOT matter.
- The ONLY hard constraint is the LICENSE: anything you use must be commercially usable and free of copyleft/unknown obligations (MIT/ISC/BSD/Apache-2.0 …; NEVER GPL/LGPL/AGPL/MPL/EPL/CDDL or unknown). Prefer a permissive successor or your own MIT code.
- Reproduce the OBSERVABLE behaviour/appearance the criteria describe; do NOT reproduce the dead library's internal API.
- Keep the apex.* integration and the plugin's public contract intact; the result must render real output.
Return ONLY the implementation for this slice (no prose, no markdown fences).`;
}

/**
 * Slice-weise Neuentwicklung. Alle Seiteneffekte injizierbar:
 * @param {object} contract Akzeptanz-Vertrag (acceptance.js)
 * @param {{license?, implementSlice:(slice,ctx)=>Promise, runSelfTests:()=>Promise, adopt?, rollback?, maxRounds?, log?, classify?, name?, deadLib?}} deps
 * @returns {Promise<{ok, reason?, license, slices:Array<{view,pass,rounds}>, full?}>}
 */
export async function rebuildSlices(contract, deps = {}) {
  const { implementSlice, runSelfTests, adopt, rollback, name, deadLib } = deps;
  const maxRounds = deps.maxRounds ?? 2;
  const log = deps.log || (() => {});
  if (!contract || !(contract.criteria || []).length) return { ok: false, reason: 'kein Akzeptanz-Vertrag', license: null, slices: [] };

  // 1) Lizenz-Gate für die gewählte Technologie — ist sie rechtlich nicht sauber, gar nicht erst bauen.
  const gate = licenseGate(deps.license, { classify: deps.classify });
  if (deps.license != null && !gate.allowed) { log(`Lizenz-Gate: ${gate.reason} → Abbruch`); return { ok: false, reason: 'license rejected: ' + gate.reason, license: gate, slices: [] }; }

  if (typeof implementSlice !== 'function' || typeof runSelfTests !== 'function') return { ok: false, reason: 'implementSlice/runSelfTests fehlen', license: gate, slices: [] };

  // 2) Je Slice: implementieren → gegen die Slice-Kriterien prüfen → adopt/rollback, bis grün oder Limit.
  const slices = planSlices(contract);
  const results = [];
  for (const slice of slices) {
    const sub = { criteria: slice.criteria, renderedRequired: contract.renderedRequired };
    let pass = false; let rounds = 0;
    for (let r = 1; r <= maxRounds; r++) {
      rounds = r;
      try { await implementSlice(slice, { round: r, name, deadLib }); }
      catch (e) { log(`Slice "${slice.view}" Runde ${r}: Fehler ${e?.message ?? e}`); break; }
      const st = await runSelfTests();
      const cmp = compareAcceptance(sub, st);
      if (cmp.pass) { pass = true; if (adopt) await adopt(slice); break; }
      if (rollback) await rollback(slice);
    }
    results.push({ view: slice.view, pass, rounds });
    log(`Slice "${slice.view}": ${pass ? 'grün' : 'rot'} nach ${rounds} Runde(n)`);
  }

  // 3) Abschluss: der KOMPLETTE Vertrag muss grün sein (Gesamtprüfung) = works as before.
  let full = null;
  try { full = compareAcceptance(contract, await runSelfTests()); } catch { /* best effort */ }
  const ok = results.length === slices.length && results.every((r) => r.pass) && (full ? full.pass : true);
  return { ok, license: gate, slices: results, full };
}

/**
 * T-118 — Tote-Lib-Neuentwicklung als Flow: Akzeptanz-Vertrag lesen, toten Lib bestimmen, slice-weise
 * neu bauen (rebuildSlices) und das Ergebnis in den Store schreiben. implementSlice/runSelfTests werden
 * vom Aufrufer (start.js) injiziert (echte KI + Mock-Selbsttest); hier liegt die testbare Orchestrierung.
 * @param {{ai?, contract?, deadLib?, license?, implementSlice:Function, runSelfTests:Function, adopt?, rollback?, rollbackAll?:Function, log?, now?, classify?}} deps
 */
export async function redevelopDeadLib(store, comp, deps = {}) {
  const dir = comp.path;
  const contract = deps.contract ?? readAcceptance(dir);
  if (!contract || !(contract.criteria || []).length) return { ok: false, error: 'Kein Akzeptanz-Vertrag — erst einen grünen Mock bauen.' };
  if (typeof deps.implementSlice !== 'function' || typeof deps.runSelfTests !== 'function') return { ok: false, error: 'implementSlice/runSelfTests müssen injiziert werden (KI + Mock-Selbsttest).' };

  // Toten Lib bestimmen: erste Lib, deren Entscheidung „replace" ist (kein sicheres Update / nicht gepflegt).
  const libs = (store?.get?.(comp.id)?.libs) ?? comp.libs ?? [];
  const dead = libs.find((l) => decideLibAction(l, { classify: deps.classify }).action === 'replace');
  const deadLib = deps.deadLib ?? dead?.name ?? null;
  // Technologiewahl ist frei; Default = Eigenbau unter MIT. Lizenz-Gate prüft (in rebuildSlices) erneut.
  const license = deps.license ?? 'MIT';

  const result = await rebuildSlices(contract, {
    license, name: comp.name, deadLib,
    implementSlice: deps.implementSlice, runSelfTests: deps.runSelfTests,
    adopt: deps.adopt, rollback: deps.rollback, log: deps.log, classify: deps.classify, maxRounds: deps.maxRounds,
  });

  if (!result.ok && typeof deps.rollbackAll === 'function') { try { await deps.rollbackAll(); } catch { /* ignore */ } }
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    store?.addReview?.(comp.id, { kind: 'redev-dead-lib', pass: result.ok, deadLib, slices: result.slices });
    if (result.ok) store?.update?.(comp.id, { rebuilt: true, rebuiltAt: now(), rebuiltTo: deadLib ? `${deadLib} ersetzt (slice-weise neu)` : 'slice-weise neu', verifiedAsBefore: true });
  } catch { /* store best effort */ }
  return { ...result, deadLib };
}
