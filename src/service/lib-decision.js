/**
 * T-114 — Security-gestützte Entscheidung: Update vs. Ersatz (vs. Neuentwicklung).
 *
 * Vor dem Lib-Eingriff entscheidet ein Sicherheits-Scan + Status, WAS zu tun ist:
 *   - aktuell            → ok (nichts)
 *   - veraltet (safe)    → update auf letzte stabile Version (works-as-before-Gate)
 *   - verwundbar + Fix   → update (priorisiert, Sicherheit)
 *   - verwundbar, KEIN Fix / nicht gepflegt / veraltet+CVE-ohne-Fix → ERSATZ erzwingen
 *         → permissiver Nachfolger, sonst Dead-Lib-Neuentwicklung (F-30)
 *   - unbekannt          → review (manuell)
 *
 * Rein/injizierbar (cve-Quelle + suggestReplacement) → testbar ohne Netz.
 *
 * Resultat: src/service/lib-decision.js
 */

import { suggestReplacement } from './lib-replace.js';
import { classifyLicense } from '../sbom/licenses.js';
import { securityScanLib } from './lib-security-scan.js';

function mk(action, reason, severity, replacement, security) {
  // Bei „replace": gibt es einen sauberen Nachfolger? sonst Dead-Lib-Neuentwicklung (F-30).
  let path = null;
  if (action === 'replace') path = (replacement && replacement.strategy === 'replace' && replacement.to) ? 'successor' : 'redevelop';
  return { action, reason, severity, mustReplace: action === 'replace', replacement: replacement || null, path, security: security ?? null };
}

/**
 * @param {{name?,version?,latest?,status?}} lib  status: aktuell|veraltet|verwundbar|nicht gepflegt|unbekannt
 * @param {{cve?:{vulnerable?:boolean, fixAvailable?:boolean}, replacement?:object, classify?:Function, suggest?:Function}} deps
 *   cve: Ergebnis des Sicherheits-Scans (vulnerable? gibt es eine fixende Version?).
 * @returns {{action:'ok'|'update'|'replace'|'review', reason, severity, mustReplace, replacement, path}}
 */
export function decideLibAction(lib = {}, deps = {}) {
  const status = lib.status || 'unbekannt';
  const cve = deps.cve || null;
  const suggest = deps.suggest ?? suggestReplacement;
  const replacement = deps.replacement ?? (() => { try { return suggest(lib.name, { classify: deps.classify ?? classifyLicense }); } catch { return null; } })();
  const vulnerable = status === 'verwundbar' || cve?.vulnerable === true;
  const fixAvailable = cve ? cve.fixAvailable !== false : true; // ohne Scan-Info: optimistisch (Update probierbar)
  const hasNewer = !!(lib.latest && lib.version && String(lib.latest) !== String(lib.version));
  // T-123: dedizierte Sicherheitsbewertung — entscheidet „Security-Risiko" vs. „nur veralteter Code".
  const securityScan = deps.securityScan ?? securityScanLib;
  const sec = (() => { try { return securityScan(lib, deps); } catch { return null; } })();

  if (status === 'nicht gepflegt') return mk('replace', 'nicht gepflegt — ersetzen/neu entwickeln statt nur updaten', 'high', replacement, sec);
  if (vulnerable) {
    if (!fixAvailable) return mk('replace', 'verwundbar und KEIN sicheres Update verfügbar → Ersatz erzwungen', 'critical', replacement, sec);
    return mk('update', 'verwundbar, aber sicheres Update verfügbar → priorisiert updaten (Sicherheit)', 'critical', replacement, sec);
  }
  if (status === 'veraltet') {
    if (cve && cve.vulnerable && !fixAvailable) return mk('replace', 'veraltet + Schwachstelle ohne Fix → Ersatz', 'high', replacement, sec);
    // T-123: ohne expliziten CVE entscheidet der Security-Scan, ob die veraltete Lib ein echtes Risiko ist.
    if (!cve && sec && sec.securityRisk) {
      if (!sec.fixAvailable) return mk('replace', `veraltet + Sicherheitsrisiko ohne Fix (${sec.reason}) → Ersatz`, 'high', replacement, sec);
      return mk('update', `veraltet + Sicherheitsrisiko mit Fix (${sec.reason}) → priorisiert updaten (Sicherheit)`, 'high', replacement, sec);
    }
    return mk('update', hasNewer ? 'veraltet (nur Code, kein bekanntes Security-Risiko) → auf letzte stabile Version updaten (works-as-before-Gate)' : 'veraltet → updaten sobald stabile Version vorliegt', 'medium', replacement, sec);
  }
  if (status === 'unbekannt') return mk('review', 'Version/Status unbekannt → manuell prüfen', 'low', replacement, sec);
  return mk('ok', 'aktuell — keine Aktion nötig', 'none', replacement, sec);
}

/** Entscheidung je Lib einer Komponente (für GUI/Report). */
export function decideForLibs(libs = [], deps = {}) {
  return (libs || []).map((l) => ({ name: l.name, version: l.version, ...decideLibAction(l, { ...deps, cve: deps.cveFor ? deps.cveFor(l) : deps.cve }) }));
}
