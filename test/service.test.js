import { describe, it, expect } from 'vitest';
import { createScheduler, isDue } from '../src/service/scheduler.js';

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
