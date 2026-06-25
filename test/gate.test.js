import { describe, it, expect } from 'vitest';
import { inProcessRunner, evaluateGate, runSuite, gatePasses } from '../src/run/gate.js';

describe('T-6 Tests ausführen & Gate', () => {
  it('grüner Lauf → Gate offen (Freigabe für Re-Upload)', async () => {
    const suite = { artifact: 'w', cases: [
      { name: 'a', fn: () => {} },
      { name: 'b', fn: async () => {} },
    ] };
    const { gate } = await runSuite(suite);
    expect(gate.pass).toBe(true);
    expect(gate.total).toBe(2);
    expect(gate.passed).toBe(2);
  });

  it('roter Lauf → Gate blockiert mit Fehler-Logs', async () => {
    const suite = { artifact: 'w', cases: [
      { name: 'a', fn: () => {} },
      { name: 'b', fn: () => { throw new Error('kaputt'); } },
    ] };
    const { gate } = await runSuite(suite);
    expect(gate.pass).toBe(false);
    expect(gate.failed.map((f) => f.name)).toEqual(['b']);
    expect(gate.logs.join()).toMatch(/kaputt/);
  });

  it('leere Suite ist kein grünes Gate', () => {
    expect(evaluateGate({ tests: [] }).pass).toBe(false);
  });

  it('gatePasses ist die Freigabe-Kurzform', async () => {
    expect(await gatePasses({ cases: [{ name: 'x', fn: () => {} }] })).toBe(true);
    expect(await gatePasses({ cases: [{ name: 'x', fn: () => { throw new Error('x'); } }] })).toBe(false);
  });

  it('inProcessRunner erfasst Status je Fall', async () => {
    const r = await inProcessRunner({ cases: [
      { name: 'ok', fn: () => {} },
      { name: 'bad', fn: () => { throw new Error('e'); } },
    ] });
    expect(r.tests).toEqual([
      { name: 'ok', status: 'passed' },
      { name: 'bad', status: 'failed', error: 'e' },
    ]);
  });
});
