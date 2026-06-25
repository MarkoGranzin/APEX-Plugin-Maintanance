import { describe, it, expect } from 'vitest';
import { selfHeal } from '../src/run/heal.js';
import { stubBackend } from '../src/ai/backend.js';

const fixAi = stubBackend({ respond: () => JSON.stringify({ target: 'code', description: 'fix' }) });

/** Suite, deren zweiter Test bis state.fixed rot ist; Fehlertext variiert mit state.round (= Fortschritt). */
function progressingSuite(state) {
  return {
    artifact: 'w',
    cases: [
      { name: 'ok', fn: () => {} },
      { name: 'flaky', fn: () => { if (!state.fixed) throw new Error('rot-' + state.round); } },
    ],
  };
}

describe('T-15 Selbstheilungs-Loop', () => {
  it('wird bei Rot grün vor dem Limit (Erfolg in Versuch 3)', async () => {
    const state = { round: 0, fixed: false };
    const apply = (_patch, attempt) => {
      state.round += 1;
      if (state.round >= 3) state.fixed = true;
      return true;
    };
    const res = await selfHeal({ suite: progressingSuite(state), ai: fixAi, apply, limit: 5 });
    expect(res.success).toBe(true);
    expect(res.green).toBe(true);
    expect(res.attempts).toBe(3);
    expect(res.protocol).toHaveLength(3);
    expect(res.pushed).toBe(false);
  });

  it('Limit erreicht ohne Grün → sauberer Fehlschlag, kein Push, Rollback', async () => {
    const state = { round: 0, fixed: false };
    let rolledBack = false;
    const apply = () => { state.round += 1; return true; }; // Fehler ändert sich (Fortschritt), wird aber nie grün
    const res = await selfHeal({
      suite: progressingSuite(state),
      ai: fixAi,
      apply,
      rollback: () => { rolledBack = true; },
      limit: 5,
    });
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(5);
    expect(res.reason).toBe('Limit erreicht');
    expect(res.pushed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it('Stagnation (identischer Fehler) bricht vorzeitig ab', async () => {
    // Fehlertext konstant → keine Verbesserung
    const suite = { artifact: 'w', cases: [{ name: 'c', fn: () => { throw new Error('konstant'); } }] };
    let rolledBack = false;
    const res = await selfHeal({
      suite,
      ai: fixAi,
      apply: () => true,
      rollback: () => { rolledBack = true; },
      limit: 5,
    });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('keine Verbesserung');
    expect(res.attempts).toBeLessThan(5);
    expect(rolledBack).toBe(true);
  });

  it('idempotent & begrenzt: KI nicht erreichbar überschreitet das Limit nicht und pusht nicht', async () => {
    const downAi = stubBackend({ respond: () => { throw new Error('KI down'); } });
    const suite = { artifact: 'w', cases: [{ name: 'c', fn: () => { throw new Error('x'); } }] };
    const res = await selfHeal({ suite, ai: downAi, apply: () => true, limit: 4 });
    expect(res.success).toBe(false);
    expect(res.attempts).toBeLessThanOrEqual(4);
    expect(res.protocol.every((p) => p.action === 'ki-fehler')).toBe(true);
    expect(res.pushed).toBe(false);
  });

  it('bereits grün → kein Reparaturversuch nötig', async () => {
    const res = await selfHeal({ suite: { cases: [{ name: 'ok', fn: () => {} }] }, ai: fixAi, apply: () => true });
    expect(res).toMatchObject({ success: true, attempts: 0 });
  });
});
