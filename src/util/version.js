/**
 * Gemeinsamer semver-Vergleich (vorher bitgenau dupliziert in sbom/sbom.js und service/lib-update.js).
 *
 * cmpSemver(a, b) → <0 wenn a<b, 0 wenn gleich, >0 wenn a>b. Vergleicht punktgetrennte
 * Zahlenfelder; fehlende Felder zaehlen als 0 (z.B. "1.2" == "1.2.0").
 *
 * Hinweis: Die Versions-EXTRAKTION (versionFromUrl in extract.js, fromFilename in sbom.js,
 * versionFromName in vendored.js) ist bewusst NICHT hier zusammengefasst — es sind
 * unterschiedliche Muster fuer unterschiedliche Eingaben (URL vs. Dateiname, 2- vs. 3-stellig).
 *
 * Resultat: src/util/version.js
 */

export const cmpSemver = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};
