/**
 * T-115 — Doppel-Review + Rework-Schleife nach jedem Fix/Migration.
 *
 * Nach einem Lib-Fix oder einer Migration: (1) erneuter Security-Scan, (2) ZWEI unabhängige Review-Agenten
 * (Security-Review + Code-Qualitäts-Review). Sagt der Scan ODER mindestens ein Agent „nicht OK", startet eine
 * Rework-Schleife (KI-Fix → erneut Scan + beide Reviews), bis ALLE grün ODER das Rundenlimit erreicht ist
 * (→ kein Übernehmen; der Aufrufer rollt zurück). Alle Schritte injizierbar → deterministisch testbar.
 *
 * Resultat: src/service/review-loop.js
 */

/** Normalisiert ein Votum auf {ok:boolean, issues:string[]}. ok===false nur bei explizitem Fehlbefund. */
function vote(v) {
  if (!v) return { ok: true, issues: [] };
  const ok = v.ok !== false && v.pass !== false;
  const issues = Array.isArray(v.issues) ? v.issues : (Array.isArray(v.findings) ? v.findings : []);
  return { ok, issues };
}

/**
 * @param {object} target Komponente/Build, der bewertet wird (durchgereicht an die Agenten)
 * @param {{securityScan?:Function, securityReview:Function, codeReview:Function, fix?:Function, maxRounds?:number, log?:Function}} deps
 *   securityReview/codeReview: zwei UNABHÄNGIGE Agenten, je () => {ok, issues}. fix(target,{round,votes}) macht den Rework.
 * @returns {Promise<{pass:boolean, rounds:number, votes:object, history:Array}>}
 */
export async function dualReviewRework(target, deps = {}) {
  const { securityScan, securityReview, codeReview, fix } = deps;
  const maxRounds = deps.maxRounds ?? 2;
  const log = deps.log || (() => {});
  if (typeof securityReview !== 'function' || typeof codeReview !== 'function') {
    return { pass: false, rounds: 0, votes: {}, history: [], error: 'zwei Review-Agenten (securityReview, codeReview) nötig' };
  }
  const history = [];
  let lastVotes = {};
  for (let round = 1; round <= maxRounds; round++) {
    const scan = securityScan ? vote(await securityScan(target)) : { ok: true, issues: [] };
    // ZWEI unabhängige Voten — nacheinander, aber ohne Kenntnis voneinander.
    const security = vote(await securityReview(target));
    const code = vote(await codeReview(target));
    const votes = { scan, security, code };
    lastVotes = votes;
    const ok = scan.ok && security.ok && code.ok;
    history.push({ round, ok, scan: scan.ok, security: security.ok, code: code.ok });
    log(`Review Runde ${round}: scan=${scan.ok ? 'ok' : 'rot'} security=${security.ok ? 'ok' : 'rot'} code=${code.ok ? 'ok' : 'rot'}`);
    if (ok) return { pass: true, rounds: round, votes, history };
    if (round === maxRounds || typeof fix !== 'function') break; // Limit/ohne Fix → raus (Aufrufer rollt zurück)
    const findings = [...scan.issues, ...security.issues, ...code.issues];
    log(`Review Runde ${round}: nicht OK → Rework (${findings.length} Befund(e))`);
    try { await fix(target, { round, votes, findings }); }
    catch (e) { log(`Rework-Fehler: ${e?.message ?? e}`); break; }
  }
  return { pass: false, rounds: history.length, votes: lastVotes, history };
}
