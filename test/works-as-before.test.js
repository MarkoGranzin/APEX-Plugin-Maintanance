import { describe, it, expect } from 'vitest';
import { worksAsBefore } from '../src/service/works-as-before.js';

describe('F-28 T-91 works-as-before-Gate', () => {
  it('kein Regress → pass, newlyGreen erkannt', () => {
    const baseline = [{ id: 'A', status: 'passed' }, { id: 'B', status: 'passed' }];
    const current = [{ id: 'A', status: 'passed' }, { id: 'B', status: 'passed' }, { id: 'C', status: 'passed' }];
    const r = worksAsBefore(baseline, current);
    expect(r.pass).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.newlyGreen).toEqual(['C']);
  });

  it('vorher grün jetzt rot → Regress blockiert', () => {
    const r = worksAsBefore([{ id: 'A', status: 'passed' }], [{ id: 'A', status: 'failed' }]);
    expect(r.pass).toBe(false);
    expect(r.regressions).toEqual([{ scenario: 'A', was: 'passed', now: 'failed' }]);
  });

  it('vorher grünes Szenario fehlt jetzt → Regress (nicht beweisbar)', () => {
    const r = worksAsBefore([{ id: 'A', status: 'passed' }], [{ id: 'B', status: 'passed' }]);
    expect(r.pass).toBe(false);
    expect(r.regressions[0]).toMatchObject({ scenario: 'A', now: 'missing' });
  });

  it('vorher rot bleibt rot → kein Regress (keine Verschlechterung)', () => {
    const r = worksAsBefore([{ id: 'A', status: 'failed' }], [{ id: 'A', status: 'failed' }]);
    expect(r.pass).toBe(true);
    expect(r.regressions).toEqual([]);
  });

  it('akzeptiert Map und passed-Boolean', () => {
    const baseline = new Map([['A', 'passed']]);
    const current = [{ title: 'A', passed: true }];
    expect(worksAsBefore(baseline, current).pass).toBe(true);
  });
});
