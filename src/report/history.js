/**
 * T-10 — Läufe persistieren & abfragbar machen (GUI-Anzeige folgt in Slice 25 / T-14).
 *
 * Jeder Lauf wird mit Schritten, Status, Diffs/PR-Links und Zeit gespeichert; abfragbar mit
 * Filter und Detailzugriff. Der Speicher ist als einfache, persistierbare Struktur (toJSON)
 * gehalten, damit ein Dienst-Neustart die History nicht verliert (vgl. Idempotenz T-26).
 *
 * Resultat: src/report/history.js
 */

export function createHistory(initial = []) {
  return { runs: [...initial] };
}

/**
 * Hängt einen Lauf an die History an.
 * @param {object} history
 * @param {{id:string, at?:string, status:'green'|'red'|'partial', steps?:object[], updated?:object[], failures?:object[], prRefs?:any[]}} run
 */
export function recordRun(history, run) {
  if (!run?.id) throw new Error('Run requires an id');
  if (history.runs.some((r) => r.id === run.id)) {
    // Idempotenz: derselbe Lauf wird nicht doppelt gespeichert (Crash/Neustart)
    return history;
  }
  history.runs.push({
    id: run.id,
    at: run.at ?? null,
    status: run.status,
    steps: run.steps ?? [],
    updated: run.updated ?? [],
    failures: run.failures ?? [],
    prRefs: run.prRefs ?? [],
  });
  return history;
}

/** Läufe abfragen, optional gefiltert nach Status/Artefakt. */
export function listRuns(history, filter = {}) {
  let runs = [...history.runs];
  if (filter.status) runs = runs.filter((r) => r.status === filter.status);
  if (filter.artifact) {
    runs = runs.filter(
      (r) => r.updated.some((u) => u.artifact === filter.artifact) || r.failures.some((f) => f.artifact === filter.artifact),
    );
  }
  return runs;
}

export function getRun(history, id) {
  return history.runs.find((r) => r.id === id) ?? null;
}
