/**
 * T-16 — Unmaintained-/Risiko-Erkennung & Quittierung (eigener Score, separat vom Update).
 *
 * Aus der wöchentlichen SBOM (T-7) wird je Lib ein Risiko-Score gebildet (Signale: GitHub
 * archived/letztes Release, deprecated, CVE ohne Fix …). Drei Stufen 🟡 stale / 🟠 unmaintained /
 * 🔴 vulnerable+unfixed; Schwellen konfigurierbar. Das blockiert das Update-Gate NICHT (Wissen #507),
 * sondern erzeugt einen eigenen „Handlungsbedarf"-Eintrag mit Pflicht-Begründung + Git-Link.
 * Warnungen sind quittierbar; quittierte erscheinen nicht erneut — außer das Risiko verschärft sich.
 *
 * Resultat: src/sbom/risk.js
 */

export const LEVEL = Object.freeze({ NONE: 'none', STALE: 'stale', UNMAINTAINED: 'unmaintained', VULNERABLE: 'vulnerable' });
const RANK = { none: 0, stale: 1, unmaintained: 2, vulnerable: 3 };
const LABEL = { stale: '🟡 stale', unmaintained: '🟠 unmaintained', vulnerable: '🔴 vulnerable+unfixed' };

/**
 * Bestimmt Stufe + Begründung für eine Lib.
 * @param {{name:string}} lib
 * @param {{archived?:boolean, deprecated?:boolean, cveUnfixed?:boolean, lastReleaseMonths?:number, gitLink?:string}} sig
 * @param {{staleMonths?:number}} [opts]
 */
export function riskFor(lib, sig = {}, opts = {}) {
  const staleMonths = opts.staleMonths ?? 18;
  let level = LEVEL.NONE;
  const reasons = [];

  if (sig.cveUnfixed) {
    level = LEVEL.VULNERABLE;
    reasons.push('CVE ohne Fix');
  } else if (sig.archived) {
    level = LEVEL.UNMAINTAINED;
    reasons.push('Repo archiviert');
  } else if (sig.deprecated) {
    level = LEVEL.UNMAINTAINED;
    reasons.push('npm deprecated');
  } else if (sig.lastReleaseMonths != null && sig.lastReleaseMonths >= staleMonths) {
    level = LEVEL.STALE;
    reasons.push(`seit ${sig.lastReleaseMonths} Monaten kein Release`);
  }

  return { name: lib.name, version: lib.version, level, label: LABEL[level] ?? null, reasons, gitLink: sig.gitLink ?? null, blocksGate: false };
}

/** Bewertet alle Komponenten; liefert nur Einträge mit Handlungsbedarf (level != none). */
export function assessRisks(components, signalsByLib = {}, opts = {}) {
  return components
    .map((c) => riskFor(c, signalsByLib[c.name] ?? {}, opts))
    .filter((r) => r.level !== LEVEL.NONE);
}

// ---- Quittierung ----

export function createAck() {
  return { acked: {} }; // name -> quittierte Stufe
}

/** Quittiert ein Risiko auf der aktuellen Stufe ("akzeptiertes Risiko"). */
export function acknowledge(ack, name, level) {
  ack.acked[name] = level;
  return ack;
}

/** Quittiert, solange sich das Risiko nicht über die quittierte Stufe hinaus verschärft. */
export function isSuppressed(ack, name, currentLevel) {
  const at = ack.acked[name];
  if (at == null) return false;
  return RANK[currentLevel] <= RANK[at];
}

/** Aktive (nicht quittierte bzw. verschärfte) Risiken — der „Handlungsbedarf"-Block. */
export function activeRisks(risks, ack) {
  return risks.filter((r) => !isSuppressed(ack, r.name, r.level));
}

/** Liste der quittierten Risiken (bleiben einsehbar). */
export function acknowledgedList(ack) {
  return Object.entries(ack.acked).map(([name, level]) => ({ name, level, label: LABEL[level] ?? null }));
}
