/**
 * T-17 — Test-Quarantäne & Flaky-Management (3× grün, Auto-Aussortierung) + Rollentrennung.
 *
 * Neue KI-generierte Tests laufen erst in Quarantäne: nur nach 3× grün hintereinander werden
 * sie ins verbindliche Gate aufgenommen. Wer innerhalb der ersten Läufe mindestens einmal rot
 * ist, wird verworfen und als „instabil" markiert (mit Stabilitäts-Streifen der letzten Läufe).
 * Rollentrennung (Wissen #506): die reparierende KI (T-15) darf Snapshot-/Akzeptanztests NICHT
 * ändern — solche Patches werden abgewiesen und protokolliert.
 *
 * Resultat: src/run/quarantine.js
 */

export const STATE = Object.freeze({
  QUARANTINE: 'quarantine',
  PROMOTED: 'promoted',
  DISCARDED: 'discarded',
});

export function createQuarantine() {
  return { history: {} }; // testName -> ['passed'|'failed', ...]
}

/** Hält das Ergebnis eines Quarantäne-Laufs fest. */
export function recordRun(q, testName, status) {
  (q.history[testName] ??= []).push(status);
  return q;
}

/**
 * Klassifiziert einen Test anhand seiner ersten Läufe.
 * @param {number} [requiredGreen=3]
 * @returns {'quarantine'|'promoted'|'discarded'}
 */
export function classify(q, testName, opts = {}) {
  const requiredGreen = opts.requiredGreen ?? 3;
  const h = q.history[testName] ?? [];
  const window = h.slice(0, requiredGreen);
  if (window.includes('failed')) return STATE.DISCARDED;
  if (window.length >= requiredGreen) return STATE.PROMOTED;
  return STATE.QUARANTINE;
}

/** Stabilitäts-Streifen der letzten n Läufe (für GUI-Badge). */
export function stabilityStrip(q, testName, n = 5) {
  const h = q.history[testName] ?? [];
  return h.slice(-n);
}

/** Tests, die aktuell ins verbindliche Gate zählen. */
export function gateTests(q, opts = {}) {
  return Object.keys(q.history).filter((t) => classify(q, t, opts) === STATE.PROMOTED);
}

/**
 * Rollentrennung: prüft einen Reparatur-Patch der KI (T-15).
 * @param {{target:'code'|'test', testName?:string}} patch
 * @param {object} opts
 * @param {Set<string>|string[]} opts.protectedTests Snapshot-/Akzeptanztests
 * @returns {{allowed:boolean, reason?:string, logged:boolean}}
 */
export function guardPatch(patch, opts = {}) {
  const protectedSet = opts.protectedTests instanceof Set ? opts.protectedTests : new Set(opts.protectedTests ?? []);
  if (patch?.target === 'test' && patch.testName && protectedSet.has(patch.testName)) {
    return {
      allowed: false,
      reason: `Snapshot-/Akzeptanztest "${patch.testName}" ist geschützt — Reparatur-KI darf ihn nicht ändern`,
      logged: true,
    };
  }
  return { allowed: true, logged: false };
}
