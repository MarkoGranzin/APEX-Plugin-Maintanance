/**
 * T-4 — Initiale KI-Testsuite je Artefakt generieren.
 * T-5 — Zusatztests für Änderungs-Delta erzeugen (keine Duplikate).
 *
 * Eingang ist der strukturierte Testkontext aus T-21 (Einstiegspunkte etc.) + das kanonische
 * Bündel (T-19). Die KI (über die Abstraktion src/ai/backend.js) liefert Testcode; dieser
 * wird deterministisch VALIDIERT (acorn-Parse) und im definierten Testordner abgelegt.
 * Delta-Tests werden gegen die bestehenden Test-Titel dedupliziert.
 *
 * Resultat: src/ai/generate.js
 */

import * as acorn from 'acorn';

/** Extrahiert it()/test()-Titel aus Testcode (für Dedup). */
export function extractTestTitles(code) {
  const titles = [];
  const re = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(code))) titles.push(m[2]);
  return titles;
}

function validate(code) {
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function buildPrompt(bundle, analysis, { kind, targets }) {
  return [
    `Erzeuge ${kind === 'delta' ? 'ZUSÄTZLICHE ' : ''}Vitest-Tests für das APEX-Artefakt "${bundle.artifact}".`,
    `Einstiegspunkte: ${targets.join(', ') || '(keine)'}.`,
    `apex.*-Aufrufe: ${(analysis?.apexCalls ?? []).join(', ') || '(keine)'}.`,
    `Nutze den apex.*-Shim für den jsdom-Pfad. Gib nur lauffähigen Testcode zurück.`,
  ].join('\n');
}

/**
 * T-4 — initiale Suite je Artefakt.
 * @returns {Promise<{artifact:string, path:string, code:string, titles:string[], kind:string}>}
 */
export async function generateInitialSuite(bundle, analysis, opts = {}) {
  const ai = opts.ai;
  if (!ai) throw new Error('KI-Backend (ai) erforderlich');
  const targets = analysis?.entryPoints ?? [];
  const prompt = buildPrompt(bundle, analysis, { kind: 'initial', targets });
  const code = await ai.complete(prompt, { targets, artifact: bundle.artifact });

  const v = validate(code);
  if (!v.ok) throw new Error(`Generierter Test nicht parsebar: ${v.error}`);

  return {
    artifact: bundle.artifact,
    path: `${opts.testDir ?? 'generated-tests'}/${bundle.artifact}.spec.js`,
    code,
    titles: extractTestTitles(code),
    kind: 'characterization',
  };
}

/**
 * T-5 — Zusatztests fürs Delta; dedupliziert gegen bestehende Titel.
 * @param {string[]} changedTargets  geänderte/neue Einstiegspunkte (aus Diff + T-21)
 * @param {{titles:string[]}} existing  bestehende Suite (T-4)
 * @returns {Promise<{added:{title:string}[], skipped:string[], code:string|null}>}
 */
export async function generateDeltaTests(bundle, analysis, changedTargets, existing, opts = {}) {
  const ai = opts.ai;
  if (!ai) throw new Error('KI-Backend (ai) erforderlich');
  const prompt = buildPrompt(bundle, analysis, { kind: 'delta', targets: changedTargets });
  const code = await ai.complete(prompt, { targets: changedTargets, artifact: bundle.artifact });

  const v = validate(code);
  if (!v.ok) throw new Error(`Generierter Delta-Test nicht parsebar: ${v.error}`);

  const existingTitles = new Set(existing?.titles ?? []);
  const newTitles = extractTestTitles(code);
  const added = newTitles.filter((t) => !existingTitles.has(t)).map((title) => ({ title }));
  const skipped = newTitles.filter((t) => existingTitles.has(t));

  return { added, skipped, code: added.length > 0 ? code : null };
}
