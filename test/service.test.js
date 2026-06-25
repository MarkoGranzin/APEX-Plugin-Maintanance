import { describe, it, expect } from 'vitest';
import { createScheduler, isDue } from '../src/service/scheduler.js';
import { runArtifact, orchestrateRun } from '../src/run/orchestrate.js';

// kleiner Deferred-Helper
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe('T-13 Scheduler', () => {
  it('wöchentlicher Lauf ist fällig wenn die Woche um ist', () => {
    const now = new Date('2026-06-24T00:00:00Z').getTime();
    expect(isDue(null, now)).toBe(true);
    expect(isDue('2026-06-16T00:00:00Z', now)).toBe(true); // > 7 Tage
    expect(isDue('2026-06-20T00:00:00Z', now)).toBe(false); // < 7 Tage
  });

  it('geplanter Tick startet fällige Repos', async () => {
    const started = [];
    const s = createScheduler({ runJob: async (repo) => { started.push(repo); } });
    const run = s.tick(['repoA'], Date.now());
    expect(run).toContain('repoA');
  });

  it('kein Doppellauf: zweiter Trigger wird eingereiht statt parallel', async () => {
    const d = deferred();
    let active = 0;
    let maxActive = 0;
    const s = createScheduler({
      runJob: async () => {
        active += 1; maxActive = Math.max(maxActive, active);
        await d.promise;
        active -= 1;
      },
    });
    const r1 = s.submit('repoX');
    const r2 = s.submit('repoX'); // während r1 noch läuft
    expect(r2.queued).toBe(true);
    expect(s.queueLength('repoX')).toBe(1);
    d.resolve();
    await r1.done;
    // nach dem ersten Lauf wird der eingereihte abgearbeitet — nie parallel
    expect(maxActive).toBe(1);
  });
});

describe('T-27 Orchestrierung', () => {
  const okSteps = () => ({
    extract: () => {}, test: () => {}, update: () => {}, reinject: () => {}, pr: () => {},
  });

  it('Teil-Fehler isoliert ein Artefakt (A scheitert, B/C laufen durch)', async () => {
    const deps = {
      runId: 'r1',
      steps: {
        extract: (a) => { if (a.name === 'A') throw new Error('extraktion-unsicher'); },
        test: () => {}, update: () => {}, reinject: () => {}, pr: () => {},
      },
      renderReport: (x) => x,
      sendReport: () => {},
      recordRun: () => {},
    };
    const { results } = await orchestrateRun([{ name: 'A' }, { name: 'B' }, { name: 'C' }], deps);
    const byName = Object.fromEntries(results.map((r) => [r.artifact, r]));
    expect(byName.A.status).toBe('clarify'); // zu klären, nicht der ganze Lauf kippt
    expect(byName.B.status).toBe('done');
    expect(byName.C.status).toBe('done');
  });

  it('Resume: B startet bei Update statt erneut bei Scan/Extract', async () => {
    const calls = [];
    const deps = {
      runId: 'r2',
      steps: {
        extract: () => calls.push('extract'),
        test: () => calls.push('test'),
        update: () => calls.push('update'),
        reinject: () => calls.push('reinject'),
        pr: () => calls.push('pr'),
      },
    };
    const res = await runArtifact({ name: 'B' }, deps, 'tested'); // persistiert: getestet(grün)
    expect(res.status).toBe('done');
    expect(calls).toEqual(['update', 'reinject', 'pr']); // kein extract/test erneut
  });

  it('genau EINE gebündelte Report-Mail je Lauf', async () => {
    let mails = 0;
    const deps = {
      runId: 'r3',
      steps: okSteps(),
      renderReport: (x) => x,
      sendReport: () => { mails += 1; },
      recordRun: () => {},
      changeOf: () => 'jquery 3.4.1→3.7.1',
    };
    const { report } = await orchestrateRun([{ name: 'A' }, { name: 'B' }, { name: 'C' }], deps);
    expect(mails).toBe(1);
    expect(report.updated).toHaveLength(3);
  });

  it('ein History-Eintrag je Lauf mit aggregiertem Status', async () => {
    const runs = [];
    const deps = {
      runId: 'r4',
      steps: { ...okSteps(), test: (a) => { if (a.name === 'B') throw new Error('rot'); } },
      renderReport: (x) => x,
      sendReport: () => {},
      recordRun: (r) => runs.push(r),
    };
    await orchestrateRun([{ name: 'A' }, { name: 'B' }], deps);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('partial'); // A done, B failed
  });
});
