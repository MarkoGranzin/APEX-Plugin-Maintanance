/**
 * T-27 — Lauf-Orchestrierung als Zustandsautomat je Artefakt
 *          (Scan→Extrakt→Test→Update→Re-Injektion→PR→Mail) mit Teil-Fehler & Resume.
 *
 * Das verbindende Rückgrat über alle Bausteine. Eigenschaften (Wissen #514):
 *  - isolierter Teil-Fehler: kippt ein Artefakt, laufen die anderen weiter; das gescheiterte
 *    landet als 'failed'/'clarify' im Lauf-Ergebnis;
 *  - Resume: nach Crash je Artefakt am letzten persistierten Zustand fortsetzen;
 *  - Aggregation: GENAU EIN gebündelter Report (T-9) + EIN History-Eintrag (T-10) je Lauf.
 * Übergänge sind deterministisch; KI sitzt nur an den Urteils-Knoten (in den Step-Impls).
 *
 * Resultat: src/run/orchestrate.js
 */

/** Geordnete Zustände je Artefakt. */
export const STATES = ['detected', 'extracted', 'tested', 'updated', 'reinjected', 'reviewed', 'pr_open'];

const STEPS = [
  { name: 'extract', achieves: 'extracted', onError: 'clarify' }, // unsicher/​uneindeutig → zu klären
  { name: 'test', achieves: 'tested', onError: 'failed' },
  { name: 'update', achieves: 'updated', onError: 'failed' },
  { name: 'reinject', achieves: 'reinjected', onError: 'failed' },
  { name: 'review', achieves: 'reviewed', onError: 'failed' }, // T-31: Security- + Code-Review-Gate
  { name: 'pr', achieves: 'pr_open', onError: 'failed' },
];

function startIndex(fromState) {
  if (!fromState || fromState === 'detected') return 0;
  const idx = STEPS.findIndex((s) => s.achieves === fromState);
  return idx < 0 ? 0 : idx + 1; // nach dem erreichten Zustand fortsetzen (Resume)
}

/**
 * Verarbeitet EIN Artefakt durch den Automaten, ab dem (ggf. persistierten) Zustand.
 * @param {object} artifact
 * @param {object} deps  deps.steps[name](artifact,ctx) — wirft bei Fehler; deps.persist(artifact,state)
 * @param {string} [fromState] persistierter Zustand (Resume)
 * @returns {Promise<{artifact:string, status:'done'|'failed'|'clarify', state:string, stepsRun:string[], error?:string}>}
 */
export async function runArtifact(artifact, deps, fromState) {
  const stepsRun = [];
  let state = fromState ?? 'detected';
  for (let i = startIndex(fromState); i < STEPS.length; i++) {
    const step = STEPS[i];
    try {
      await deps.steps[step.name]?.(artifact, { state });
      state = step.achieves;
      stepsRun.push(step.name);
      deps.persist?.(artifact, state);
    } catch (err) {
      return { artifact: artifact.name, status: step.onError, state, stepsRun, error: String(err?.message ?? err) };
    }
  }
  return { artifact: artifact.name, status: 'done', state: 'pr_open', stepsRun };
}

/**
 * Führt den ganzen Lauf über alle Artefakte aus — isoliert, mit EINEM Report + EINEM History-Eintrag.
 * @param {object[]} artifacts
 * @param {object} deps
 * @param {Record<string,string>} [persistedStates]  artefaktName → letzter Zustand (Resume)
 * @returns {Promise<{runId:string, results:object[], report:object}>}
 */
export async function orchestrateRun(artifacts, deps, persistedStates = {}) {
  const results = [];
  for (const a of artifacts) {
    // Teil-Fehler-Isolation: ein scheiterndes Artefakt kippt nicht den Lauf
    try {
      results.push(await runArtifact(a, deps, persistedStates[a.name]));
    } catch (err) {
      results.push({ artifact: a.name, status: 'failed', state: 'detected', stepsRun: [], error: String(err?.message ?? err) });
    }
  }

  const updated = results.filter((r) => r.status === 'done').map((r) => ({
    artifact: r.artifact,
    change: deps.changeOf?.(r.artifact) ?? 'aktualisiert',
    testResult: 'grün',
    gitLink: deps.gitLinkOf?.(r.artifact) ?? '',
  }));
  const failures = results
    .filter((r) => r.status === 'failed' || r.status === 'clarify')
    .map((r) => ({ artifact: r.artifact, reason: `${r.status} @ ${r.state}: ${r.error ?? ''}` }));

  // Aggregation: GENAU EIN Report + EIN History-Eintrag je Lauf
  const report = deps.renderReport ? deps.renderReport({ updated, failures, risks: deps.risks ?? [] }) : { updated, failures };
  if (deps.sendReport) await deps.sendReport(report);
  if (deps.recordRun) {
    deps.recordRun({
      id: deps.runId,
      status: failures.length === 0 ? 'green' : updated.length ? 'partial' : 'red',
      updated,
      failures,
      steps: results,
    });
  }

  return { runId: deps.runId, results, report };
}
