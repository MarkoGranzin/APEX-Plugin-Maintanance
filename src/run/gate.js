/**
 * T-6 — Tests ausführen & Gate auswerten.
 *
 * Die Testsuite wird über einen injizierbaren Runner ausgeführt; Ergebnis (grün/rot + Logs)
 * wird erfasst und als Freigabe-Gate bereitgestellt: Kein Re-Upload/Push ohne grünes Gate
 * (Leitplanke Wissen #503). Der Default-Runner führt Testfälle in-process aus; die Anbindung
 * generierter Vitest-/jsdom-Suites erfolgt in der Lauf-Orchestrierung (T-27, Slice 25).
 *
 * Resultat: src/run/gate.js
 */

/** Führt Testfälle [{name, fn}] in-process aus und erfasst Status + Fehler. */
export async function inProcessRunner(suite) {
  const tests = [];
  for (const c of suite.cases ?? []) {
    try {
      await c.fn();
      tests.push({ name: c.name, status: 'passed' });
    } catch (err) {
      tests.push({ name: c.name, status: 'failed', error: String(err?.message ?? err) });
    }
  }
  return { tests, logs: tests.filter((t) => t.status === 'failed').map((t) => `${t.name}: ${t.error}`) };
}

/**
 * Wertet ein Testergebnis als Gate aus.
 * @param {{tests:{name:string,status:string}[], logs?:string[]}} results
 * @returns {{pass:boolean, total:number, passed:number, failed:{name:string,error?:string}[], logs:string[]}}
 */
export function evaluateGate(results) {
  const tests = results?.tests ?? [];
  const failed = tests.filter((t) => t.status === 'failed');
  return {
    pass: tests.length > 0 && failed.length === 0,
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed,
    logs: results?.logs ?? failed.map((f) => `${f.name}: ${f.error ?? ''}`),
  };
}

/**
 * Führt eine Suite aus und liefert Ergebnis + Gate.
 * @param {object} suite
 * @param {object} [opts]
 * @param {(suite:object)=>Promise<object>} [opts.runner]
 */
export async function runSuite(suite, opts = {}) {
  const runner = opts.runner ?? inProcessRunner;
  const results = await runner(suite);
  return { results, gate: evaluateGate(results) };
}

/** Kurzform: nur die Gate-Entscheidung (für Re-Upload-Freigabe). */
export async function gatePasses(suite, opts = {}) {
  return (await runSuite(suite, opts)).gate.pass;
}
