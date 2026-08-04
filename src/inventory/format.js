/**
 * T-18 — Speicherformat erkennen & Test-Pfad wählen (Export-Komponente vs. roher Quellcode).
 *
 * Zwei getrennte Achsen (Wissen #509, #512): das Speicherformat entscheidet die Extraktion
 * und den groben Test-Pfad. Mischform pro Repo erlaubt → Entscheidung JE Artefakt.
 * Unklarer Fall → Status "clarify", KEIN still angenommener Test-Pfad.
 *
 * Resultat: src/inventory/format.js
 */

export const FORMAT = Object.freeze({
  EXPORT: 'export',
  SOURCE: 'source',
  UNCLEAR: 'unclear',
});

export const TEST_PATH = Object.freeze({
  INSTANCE: 'APEX-Instanz (utPLSQL + Playwright)',
  INSTANCE_FREE: 'utPLSQL (Wegwerf-Schema) + JS-Unit ohne APEX-Instanz',
});

/**
 * Bestimmt Format + Test-Pfad für EIN Artefakt.
 * @param {import('./inventory.js').Artifact} artifact
 * @returns {{format:string, testPath:(string|null), status:('ok'|'clarify'), reason:string}}
 */
export function detectFormat(artifact) {
  const sig = artifact.signals ?? {};
  const hasExport = !!sig.isApexExport;
  const hasRawSource =
    (artifact.jsFiles?.length ?? 0) > 0 ||
    (artifact.cssFiles?.length ?? 0) > 0 ||
    !!sig.isPlSqlPackage;

  // A — export-fertige Komponente
  if (hasExport && !hasRawSource) {
    return {
      format: FORMAT.EXPORT,
      testPath: TEST_PATH.INSTANCE,
      status: 'ok',
      reason: 'APEX export detected (wwv_flow_api/create_plugin/f4000).',
    };
  }

  // B — roher Quellcode
  if (hasRawSource && !hasExport) {
    return {
      format: FORMAT.SOURCE,
      testPath: TEST_PATH.INSTANCE_FREE,
      status: 'ok',
      reason: 'Separate .sql/.js/.css source files without export wrapper.',
    };
  }

  // Unklar / gemischt im selben Artefakt → nicht raten
  return {
    format: FORMAT.UNCLEAR,
    testPath: null,
    status: 'clarify',
    reason: hasExport && hasRawSource
      ? 'Export- UND Rohquell-Signale im selben Artefakt — nicht eindeutig.'
      : 'Keine eindeutigen Format-Signale gefunden.',
  };
}

/**
 * Reichert eine Artefakt-Liste (aus T-2) um Format + Test-Pfad an.
 * @param {import('./inventory.js').Artifact[]} artifacts
 * @returns {Array<import('./inventory.js').Artifact & {format:string,testPath:(string|null),status:string,reason:string}>}
 */
export function enrichWithFormat(artifacts) {
  return artifacts.map((a) => ({ ...a, ...detectFormat(a) }));
}

/** Ist diese DATEI eine Fremd-Bibliothek (lib/vendor-Ordner, *.min.js, bekannter Lib-Name)? */
export function isLibraryFile(f) {
  return /(^|\/)(lib|libs|vendor|vendors|node_modules|dist|build|min)\//i.test(f) || /\.min\.(js|css)$/i.test(f) || /(^|\/)(jquery|chart|moment|lodash|d3|bootstrap)[.-]/i.test(f);
}

/** Vendored Fremd-Bibliothek (lib/, vendor/, *.min.js …) — kein eigenes Plugin-Artefakt. */
function isVendored(a) {
  const files = a.files ?? [];
  if (files.length === 0) return false;
  return files.every(isLibraryFile);
}

/**
 * Leitet Typ + Format der GESAMTEN Komponente (= ein Repo = ein Plugin) ab.
 * Wählt das eigentliche Plugin-Artefakt (bevorzugt den APEX-Export), ignoriert vendored Libs und
 * reine Asset-Ordner (css/data/fonts). So wird das Format korrekt erkannt statt „unklar/mixed".
 * @param {Array<import('./inventory.js').Artifact & {format?:string}>} artifacts  (idealerweise via enrichWithFormat)
 * @returns {{type:'plugin'|'template_component', format:string, primaryName:(string|null)}}
 */
export function componentMeta(artifacts) {
  const enriched = artifacts.length && artifacts[0].format ? artifacts : enrichWithFormat(artifacts);
  const own = enriched.filter((a) => !isVendored(a));
  const exportArt = own.find((a) => a.format === FORMAT.EXPORT) ?? enriched.find((a) => a.format === FORMAT.EXPORT);
  const sourceArt = own.find((a) => a.format === FORMAT.SOURCE);
  const primary = exportArt ?? sourceArt ?? own[0] ?? enriched[0] ?? null;
  const type = own.some((a) => a.type === 'template_component') ? 'template_component' : (primary?.type ?? 'plugin');
  const format = exportArt ? FORMAT.EXPORT : sourceArt ? FORMAT.SOURCE : (primary?.format ?? FORMAT.UNCLEAR);
  return { type, format, primaryName: primary?.name ?? null };
}
