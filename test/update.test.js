import { describe, it, expect } from 'vitest';
import { autoUpdateArtifact } from '../src/run/update.js';
import { stubBackend } from '../src/ai/backend.js';

const fixAi = stubBackend({ respond: () => JSON.stringify({ target: 'code', description: 'fix' }) });

describe('T-8 Update → Test → Push', () => {
  it('Update grün → Push + im Report als aktualisiert', async () => {
    const world = { broken: false };
    const suite = { artifact: 'w', cases: [{ name: 't', fn: () => { if (world.broken) throw new Error('rot'); } }] };
    let pushed = null;
    const res = await autoUpdateArtifact({
      artifact: { name: 'w' },
      suite,
      applyUpdate: () => { world.broken = false; }, // kompatibles Update → grün
      ai: fixAi,
      healApply: () => true,
      push: (a) => { pushed = a.name; return { prRef: 'PR-1', branch: 'aisp/update/w' }; },
    });
    expect(res.pushed).toBe(true);
    expect(res.prRef).toEqual({ prRef: 'PR-1', branch: 'aisp/update/w' });
    expect(pushed).toBe('w');
  });

  it('Update rot und Heilung scheitert → KEIN Push + Rollback', async () => {
    const world = { broken: true };
    const suite = { artifact: 'w', cases: [{ name: 't', fn: () => { if (world.broken) throw new Error('rot-konstant'); } }] };
    let pushed = false;
    let rolledBack = false;
    const res = await autoUpdateArtifact({
      artifact: { name: 'w' },
      suite,
      applyUpdate: () => { world.broken = true; },
      ai: fixAi,
      healApply: () => true, // verändert nichts am Ergebnis → Stagnation/Limit
      push: () => { pushed = true; return {}; },
      rollback: () => { rolledBack = true; },
      limit: 5,
    });
    expect(res.pushed).toBe(false);
    expect(res.success).toBe(false);
    expect(pushed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it('Update rot → Selbstheilung wird grün → erst dann Push', async () => {
    const world = { round: 0, broken: true };
    const suite = { artifact: 'w', cases: [{ name: 't', fn: () => { if (world.broken) throw new Error('rot-' + world.round); } }] };
    let pushed = false;
    const res = await autoUpdateArtifact({
      artifact: { name: 'w' },
      suite,
      applyUpdate: () => { world.broken = true; },
      ai: fixAi,
      healApply: () => { world.round += 1; if (world.round >= 2) world.broken = false; return true; },
      push: () => { pushed = true; return { prRef: 'PR-2' }; },
      limit: 5,
    });
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(true);
    expect(res.attempts).toBe(2);
    expect(pushed).toBe(true);
  });
});
