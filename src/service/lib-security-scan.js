/**
 * T-123 — Dedizierte Sicherheitsbewertung je Lib (insb. „veraltet").
 *
 * „outdated" allein heißt nicht „unsicher". Bevor das Tool eine veraltete Lib nur
 * mechanisch updatet (oder gar ersetzt), bekommt sie eine eigene Sicherheitsprüfung,
 * die entscheidet:
 *   - security-risk → bekanntes Advisory ODER EOL/nicht gepflegt (keine Fixes mehr)
 *   - code-only     → kein bekanntes Security-Advisory → nur veralteter Code (Qualitäts-Update genügt)
 *   - unknown       → keine Version/kein Name → nicht bewertbar
 *
 * Die Advisory-Quelle ist injizierbar (Default: lokale DB via vulnerabilityFor),
 * damit sie offline/deterministisch testbar bleibt und später durch eine echte
 * Online-Quelle (OSV/GHSA) ersetzt werden kann.
 *
 * Resultat: src/service/lib-security-scan.js
 */

import { vulnerabilityFor, unmaintainedReason } from '../test/static.js';

/**
 * @param {{name?,version?,latest?,status?,vulnerable?,unmaintained?,vuln?,severity?,fixedFrom?}} lib
 * @param {{vulnerabilityFor?:Function, unmaintainedReason?:Function, vulnDb?:object}} [deps]
 * @returns {{scanned:boolean, verdict:'security-risk'|'code-only'|'unknown',
 *            securityRisk:boolean, severity:'critical'|'high'|'medium'|'low'|'none',
 *            advisory:string|null, fixAvailable:boolean, fixedFrom:string|null, reason:string}}
 */
export function securityScanLib(lib = {}, deps = {}) {
  const name = lib.name;
  const version = lib.version;
  const lookup = deps.vulnerabilityFor ?? vulnerabilityFor;
  const eolFor = deps.unmaintainedReason ?? unmaintainedReason;

  if (!name || !version || version === 'unbekannt') {
    return { scanned: false, verdict: 'unknown', securityRisk: false, severity: 'none', advisory: null, fixAvailable: false, fixedFrom: null, reason: 'Name/Version unbekannt → nicht bewertbar' };
  }

  // 1) Bereits am Lib markierte Verwundbarkeit (aus dem retire-Scan) hat Vorrang.
  let adv = null;
  if (lib.vulnerable || lib.status === 'verwundbar') {
    adv = { vuln: lib.vuln ?? 'bekannte Schwachstelle', severity: lib.severity ?? 'high', fixedFrom: lib.fixedFrom ?? null };
  }
  // 2) Sonst gezielt die Advisory-DB für genau diese name@version befragen (auch bei „nur outdated").
  if (!adv) { try { adv = lookup(name, version, deps.vulnDb); } catch { adv = null; } }

  if (adv) {
    const fixAvailable = adv.fixedFrom != null;
    return {
      scanned: true,
      verdict: 'security-risk',
      securityRisk: true,
      severity: adv.severity ?? 'high',
      advisory: adv.vuln ?? 'bekannte Schwachstelle',
      fixAvailable,
      fixedFrom: adv.fixedFrom ?? null,
      reason: `bekanntes Security-Advisory ${adv.vuln ?? ''}`.trim() + (adv.fixedFrom ? ` (behoben ab ${adv.fixedFrom} → Update behebt es)` : ' (kein Fix bekannt → Ersatz nötig)'),
    };
  }

  // 3) EOL/nicht gepflegt = Sicherheitsrelevanz: es kommen keine Security-Fixes mehr.
  const eol = lib.unmaintained || lib.status === 'nicht gepflegt' ? (lib.reason ?? eolFor(name) ?? 'nicht gepflegt') : eolFor(name);
  if (eol) {
    return { scanned: true, verdict: 'security-risk', securityRisk: true, severity: 'high', advisory: null, fixAvailable: false, fixedFrom: null, reason: `nicht gepflegt/EOL — keine Security-Fixes mehr: ${eol}` };
  }

  // 4) Kein bekanntes Advisory, gepflegt → nur veralteter Code.
  return { scanned: true, verdict: 'code-only', securityRisk: false, severity: 'none', advisory: null, fixAvailable: true, fixedFrom: null, reason: 'kein bekanntes Security-Advisory für diese Version → nur veralteter Code (Qualitäts-Update genügt)' };
}
