/**
 * T-24 — Triage-Ansicht & Artefakt-Steckbrief: Format-Badge, Test-Pfad, Reife;
 *          „zu klären" bestätigen/korrigieren.
 *
 * Bei uneinheitlichem Code ist die GUI primär Sortier-/Entscheidungswerkzeug. (1) Steckbrief je
 * Artefakt (Format-Badge, Test-Pfad, Reife). (2) Triage-Liste „braucht Entscheidung" mit den
 * unklaren Artefakten oben — KI-Vorschlag mit EINEM Klick bestätigen/korrigieren. (3) Ruhige
 * Inkonsistenz-Kennzahl ohne Rot; Rot bleibt unmaintained/vulnerable (T-16) vorbehalten.
 *
 * Resultat: src/gui/triage.js
 */

import { FORMAT, TEST_PATH } from '../inventory/format.js';

const FORMAT_BADGE = {
  export: 'APEX-SQL-Export',
  source: 'JS+CSS roh',
  mixed: 'gemischt',
  unclear: 'unklar',
};

/** Steckbrief-Karte eines Artefakts. */
export function artifactCard(art) {
  return {
    name: art.name,
    formatBadge: FORMAT_BADGE[art.format] ?? 'unklar',
    testPath: art.testPath ?? '—',
    maturity: art.maturity ?? (art.format === FORMAT.UNCLEAR ? 'noch nicht testbar' : 'nur Snapshot'),
    needsDecision: needsDecision(art),
  };
}

/** Braucht das Artefakt eine Entscheidung? (Format unklar) */
export function needsDecision(art) {
  return art.format === FORMAT.UNCLEAR;
}

/** Bucket je Artefakt — partitioniert die Kennzahl. */
function bucket(art) {
  if (art.format === FORMAT.UNCLEAR) return 'toClarify';
  if (art.noConvention) return 'noConvention';
  return 'testable';
}

/**
 * Triage-View-Model: Triage-Liste (unklar oben), Steckbriefe, ruhige Kennzahl, Rot nur für Risiko.
 * @param {object[]} artifacts
 * @param {{name:string,label:string}[]} [activeRisks] aus T-16 (activeRisks)
 */
export function triageViewModel(artifacts, activeRisks = []) {
  const triage = artifacts.filter(needsDecision).map(artifactCard);
  // Sortierung: unklare nach oben (sie sind ohnehin die Triage-Liste)
  const cards = [...artifacts]
    .sort((a, b) => Number(needsDecision(b)) - Number(needsDecision(a)))
    .map(artifactCard);

  const counts = { total: artifacts.length, testable: 0, toClarify: 0, noConvention: 0 };
  for (const a of artifacts) counts[bucket(a)] += 1;

  return {
    triageList: triage,
    cards,
    // ruhige Kennzahl (kein Rot)
    inconsistency: { ...counts, tone: 'calm', text: `${counts.total} · ${counts.testable} testbar · ${counts.toClarify} zu klären · ${counts.noConvention} ohne Konvention` },
    // Rot ist ausschliesslich Risiko (unmaintained/vulnerable) vorbehalten
    red: activeRisks.map((r) => ({ name: r.name, label: r.label })),
  };
}

/**
 * Korrigiert/bestätigt das Format eines Artefakts → Test-Pfad neu setzen, verlässt die Triage-Liste.
 * @param {object} art
 * @param {'export'|'source'} format
 */
export function correctFormat(art, format) {
  const testPath = format === FORMAT.EXPORT ? TEST_PATH.INSTANCE : format === FORMAT.SOURCE ? TEST_PATH.INSTANCE_FREE : null;
  return { ...art, format, testPath, status: 'ok', maturity: 'nur Snapshot' };
}
