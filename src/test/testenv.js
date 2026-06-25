/**
 * T-22 — Wahl der JS-Testumgebung anhand der LAUFZEIT-Abhängigkeit (Wissen #512).
 *
 * Zwei getrennte Achsen: Speicherformat (T-18/F-15) entscheidet die Extraktion; die
 * Laufzeit-Abhängigkeit entscheidet die Testebene. Default ist jsdom + apex.*-Shim
 * (billig, keine Instanz). Playwright gegen eine ephemere Instanz nur dort, wo echtes
 * apex.*-Runtime nötig ist — mit fixierter Zeit/Seed gegen Flakiness. Deckt der Shim
 * eine genutzte apex.*-Funktion nicht ab, wird das gemeldet (kein stiller Fehlschlag).
 *
 * Resultat: src/test/testenv.js
 */

import { RUNTIME_PATHS, shimCovers } from './apexShim.js';

export const ENV = Object.freeze({ JSDOM: 'jsdom', PLAYWRIGHT: 'playwright' });

/** Fixierte Determinismus-Parameter für den Playwright-Pfad (gegen Flakiness, Wissen #506). */
export const FIXED = Object.freeze({ time: '2020-01-01T00:00:00.000Z', seed: 1 });

/**
 * Wählt die Testumgebung für ein analysiertes JS-Asset.
 * @param {{apexCalls?:string[]}} analysis  Ergebnis aus T-21 analyzeJs
 * @returns {{env:string, usesInstance:boolean, reason:string, fixed?:object, shimIncomplete?:string[]}}
 */
export function chooseTestEnv(analysis) {
  const apexCalls = analysis?.apexCalls ?? [];

  const runtime = apexCalls.filter((p) => RUNTIME_PATHS.has(p.replace(/^apex\./, '')));
  if (runtime.length > 0) {
    return {
      env: ENV.PLAYWRIGHT,
      usesInstance: true,
      reason: `echte apex.*-Runtime nötig (${runtime.join(', ')})`,
      fixed: FIXED,
    };
  }

  const uncovered = apexCalls.filter((p) => !shimCovers(p));
  if (uncovered.length > 0) {
    return {
      env: ENV.PLAYWRIGHT,
      usesInstance: true,
      reason: 'apex.*-Shim unvollständig → Playwright nötig',
      fixed: FIXED,
      shimIncomplete: uncovered,
    };
  }

  return {
    env: ENV.JSDOM,
    usesInstance: false,
    reason: 'nur DOM/Shim-abgedeckte apex.*-Aufrufe',
  };
}
