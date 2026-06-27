import { describe, it, expect } from 'vitest';
import { licenseGate, planSlices, buildSliceRebuildPrompt, rebuildSlices, redevelopDeadLib } from '../src/service/redev-slices.js';
import { acceptanceFromSelfTest } from '../src/service/acceptance.js';

const contract = acceptanceFromSelfTest({
  ran: true, rendered: true, views: 2,
  features: [
    { view: 'default', feature: 'renders board', ok: true },
    { view: 'default', feature: 'drag moves card', ok: true },
    { view: 'compact', feature: 'renders compact', ok: true },
  ],
  problems: [],
});

describe('F-30 T-117 slice-weise Neuentwicklung', () => {
  it('licenseGate: permissiv erlaubt, copyleft/unbekannt abgelehnt', () => {
    expect(licenseGate('MIT').allowed).toBe(true);
    expect(licenseGate('Apache-2.0').allowed).toBe(true);      // attribution ok
    expect(licenseGate('GPL-3.0').allowed).toBe(false);        // copyleft
    expect(licenseGate('LGPL-2.1').allowed).toBe(false);
    expect(licenseGate('something-weird').allowed).toBe(false); // unbekannt
  });

  it('planSlices: eine Sicht = ein Slice mit ihren Kriterien', () => {
    const slices = planSlices(contract);
    expect(slices.map((s) => s.view).sort()).toEqual(['compact', 'default']);
    const def = slices.find((s) => s.view === 'default');
    expect(def.criteria.length).toBe(2);
  });

  it('buildSliceRebuildPrompt: technologie-frei + Lizenz-Gate + nur beobachtbare Kriterien', () => {
    const slice = planSlices(contract).find((s) => s.view === 'default');
    const p = buildSliceRebuildPrompt(slice, contract, { name: 'Kanban', deadLib: 'mxgraph' });
    expect(p).toMatch(/ANY technology/);
    expect(p).toMatch(/NEVER GPL\/LGPL\/AGPL/);
    expect(p).toMatch(/renders board/);
    expect(p).toMatch(/drag moves card/);
    expect(p).toMatch(/mxgraph/);
    expect(p).toMatch(/do NOT reproduce the dead library's internal API/);
  });

  it('rebuildSlices: copyleft-Technologie → Abbruch vor dem Bau', async () => {
    let built = 0;
    const r = await rebuildSlices(contract, { license: 'GPL-3.0', implementSlice: async () => { built++; }, runSelfTests: async () => ({ ran: true, rendered: true, features: [] }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/license rejected/);
    expect(built).toBe(0); // gar nicht erst gebaut
  });

  it('rebuildSlices: konvergiert — jede Sicht wird grün, Gesamtvertrag erfüllt', async () => {
    // Self-Test liefert nach dem Implementieren je Slice die passenden grünen Features (alle am Ende grün).
    const allGreen = {
      ran: true, rendered: true, views: 2,
      features: [
        { view: 'default', feature: 'renders board', ok: true },
        { view: 'default', feature: 'drag moves card', ok: true },
        { view: 'compact', feature: 'renders compact', ok: true },
      ],
    };
    const adopted = [];
    const r = await rebuildSlices(contract, {
      license: 'MIT',
      implementSlice: async () => {},
      runSelfTests: async () => allGreen,
      adopt: async (s) => adopted.push(s.view),
      log: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.license.allowed).toBe(true);
    expect(r.slices.every((s) => s.pass)).toBe(true);
    expect(adopted.sort()).toEqual(['compact', 'default']);
    expect(r.full.pass).toBe(true);
  });

  it('rebuildSlices: ein Slice wird nie grün → rollback + ok:false', async () => {
    // 'compact' bleibt rot (fehlt im Self-Test) → nicht erfüllt
    const partial = {
      ran: true, rendered: true, views: 2,
      features: [
        { view: 'default', feature: 'renders board', ok: true },
        { view: 'default', feature: 'drag moves card', ok: true },
        { view: 'compact', feature: 'renders compact', ok: false },
      ],
    };
    const rolledBack = [];
    const r = await rebuildSlices(contract, {
      license: 'MIT', maxRounds: 2,
      implementSlice: async () => {},
      runSelfTests: async () => partial,
      rollback: async (s) => rolledBack.push(s.view),
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.slices.find((s) => s.view === 'compact').pass).toBe(false);
    expect(rolledBack).toContain('compact'); // wurde zurückgerollt
  });

  it('rebuildSlices: ohne Vertrag → ok:false', async () => {
    const r = await rebuildSlices({ criteria: [] }, { license: 'MIT', implementSlice: async () => {}, runSelfTests: async () => ({}) });
    expect(r.ok).toBe(false);
  });

  describe('T-118 redevelopDeadLib (Flow-Orchestrierung)', () => {
    const green = { ran: true, rendered: true, views: 2, features: [
      { view: 'default', feature: 'renders board', ok: true },
      { view: 'default', feature: 'drag moves card', ok: true },
      { view: 'compact', feature: 'renders compact', ok: true },
    ] };
    const mkStore = () => { const calls = { update: [], review: [] }; return { calls, get: () => ({ libs: [{ name: 'mxgraph', status: 'nicht gepflegt' }] }), update: (id, p) => calls.update.push(p), addReview: (id, r) => calls.review.push(r) }; };

    it('grün → toten Lib erkannt, slice-weise neu, Store als rebuilt markiert', async () => {
      const store = mkStore();
      const r = await redevelopDeadLib(store, { id: '1', name: 'Kanban', path: 'x' }, {
        contract, implementSlice: async () => {}, runSelfTests: async () => green, log: () => {},
      });
      expect(r.ok).toBe(true);
      expect(r.deadLib).toBe('mxgraph');           // aus dem Lib-Status abgeleitet
      expect(store.calls.update.some((p) => p.rebuilt && p.verifiedAsBefore)).toBe(true);
      expect(store.calls.review.some((x) => x.kind === 'redev-dead-lib' && x.pass)).toBe(true);
    });

    it('ohne Akzeptanz-Vertrag → error', async () => {
      const r = await redevelopDeadLib(mkStore(), { id: '1', name: 'X', path: 'x' }, { contract: { criteria: [] }, implementSlice: async () => {}, runSelfTests: async () => green });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Akzeptanz-Vertrag/);
    });

    it('Fehlschlag → rollbackAll wird aufgerufen', async () => {
      let rolledBack = false;
      const partial = { ran: true, rendered: true, features: [{ view: 'default', feature: 'renders board', ok: false }] };
      const r = await redevelopDeadLib(mkStore(), { id: '1', name: 'X', path: 'x' }, {
        contract, implementSlice: async () => {}, runSelfTests: async () => partial, rollbackAll: async () => { rolledBack = true; }, maxRounds: 1, log: () => {},
      });
      expect(r.ok).toBe(false);
      expect(rolledBack).toBe(true);
    });
  });
});
