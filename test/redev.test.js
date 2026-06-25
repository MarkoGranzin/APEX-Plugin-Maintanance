import { describe, it, expect } from 'vitest';
import { redevelopComponent } from '../src/service/redev.js';
import { createComponentStore } from '../src/gui/store.js';

const mkStore = () => createComponentStore({ now: () => 't', idGen: () => 'c1' });
const withBaseline = (store, scenarios) => {
  const id = store.add({ name: 'P', path: '/repo', uiTestUrl: 'http://x', codedTests: [{ name: 'p.ui.spec.js', content: 'x' }] }).id;
  store.update(id, { baseline: { mode: 'ui', specHash: 'h', scenarios } });
  return id;
};

describe('F-28 T-93 redevelopComponent (Spec-gesicherte Migration)', () => {
  it('kein Regress → uebernommen + Upload angeboten', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let uploaded = false; let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, summary: 'migrated', backups: new Map(), rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }] }),
      upload: async () => { uploaded = true; return { ok: true, branch: 'b' }; },
    });
    expect(r.adopted).toBe(true);
    expect(r.gate.pass).toBe(true);
    expect(uploaded).toBe(true);
    expect(rolledBack).toBe(false);
    // T-94: Komponente ist als neu gebaut markiert
    const after = store.get(id);
    expect(after.rebuilt).toBe(true);
    expect(after.verifiedAsBefore).toBe(true);
    expect(after.rebuiltAt).toBeTruthy();
  });

  it('Regress (vorher gruen, jetzt rot) → verworfen + Rollback + Bericht', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let uploaded = false; let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, summary: 'migrated', backups: new Map(), rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: true, ok: false, scenarios: [{ scenario: 'A', status: 'failed' }] }),
      upload: async () => { uploaded = true; return { ok: true }; },
    });
    expect(r.adopted).toBe(false);
    expect(r.regressions[0]).toMatchObject({ scenario: 'A' });
    expect(rolledBack).toBe(true);
    expect(uploaded).toBe(false);
  });

  it('ohne Baseline → klarer Fehler', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo' }).id;
    const r = await redevelopComponent(store, store.get(id), { migrate: async () => ({ changed: true }) });
    expect(r.error).toMatch(/Baseline/);
  });

  it('Migration ohne Änderung → nicht uebernommen', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    const r = await redevelopComponent(store, store.get(id), { migrate: async () => ({ changed: false, summary: 'nichts' }) });
    expect(r.adopted).toBe(false);
    expect(r.reason).toMatch(/nichts|keine/i);
  });

  it('UI-Tests nicht lauffaehig → Rollback, nicht uebernommen', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, summary: 'm', rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: false, reason: 'Keine Test-URL' }),
    });
    expect(r.adopted).toBe(false);
    expect(rolledBack).toBe(true);
  });
});
