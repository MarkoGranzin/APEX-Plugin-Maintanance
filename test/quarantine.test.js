import { describe, it, expect } from 'vitest';
import {
  createQuarantine,
  recordRun,
  classify,
  stabilityStrip,
  gateTests,
  guardPatch,
  STATE,
} from '../src/run/quarantine.js';

describe('T-17 Quarantäne: 3× grün → ins Gate', () => {
  it('neuer Test wird nach 3× grün ins Gate aufgenommen', () => {
    const q = createQuarantine();
    recordRun(q, 'neu', 'passed');
    expect(classify(q, 'neu')).toBe(STATE.QUARANTINE);
    recordRun(q, 'neu', 'passed');
    expect(classify(q, 'neu')).toBe(STATE.QUARANTINE);
    recordRun(q, 'neu', 'passed');
    expect(classify(q, 'neu')).toBe(STATE.PROMOTED);
    expect(gateTests(q)).toContain('neu');
  });
});

describe('T-17 Flaky-Test wird aussortiert', () => {
  it('rot innerhalb der ersten drei Läufe → verworfen + instabil-Streifen', () => {
    const q = createQuarantine();
    recordRun(q, 'wackel', 'passed');
    recordRun(q, 'wackel', 'failed');
    recordRun(q, 'wackel', 'passed');
    expect(classify(q, 'wackel')).toBe(STATE.DISCARDED);
    expect(gateTests(q)).not.toContain('wackel');
    expect(stabilityStrip(q, 'wackel')).toEqual(['passed', 'failed', 'passed']);
  });
});

describe('T-17 Rollentrennung: Reparatur-KI darf geschützte Tests nicht ändern', () => {
  const protectedTests = new Set(['snapshot:golden', 'akzeptanz:login']);

  it('Patch auf geschützten Snapshot-Test wird abgewiesen und protokolliert', () => {
    const g = guardPatch({ target: 'test', testName: 'snapshot:golden' }, { protectedTests });
    expect(g.allowed).toBe(false);
    expect(g.logged).toBe(true);
    expect(g.reason).toMatch(/geschützt/);
  });

  it('Patch auf Produktivcode ist erlaubt', () => {
    expect(guardPatch({ target: 'code' }, { protectedTests }).allowed).toBe(true);
  });

  it('Patch auf einen normalen (nicht geschützten) Test ist erlaubt', () => {
    expect(guardPatch({ target: 'test', testName: 'behavior:zoom' }, { protectedTests }).allowed).toBe(true);
  });
});
