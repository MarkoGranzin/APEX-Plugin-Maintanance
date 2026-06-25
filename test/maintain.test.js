import { describe, it, expect } from 'vitest';
import { maintainComponent, maintainAll } from '../src/service/maintain.js';
import { createComponentStore } from '../src/gui/store.js';

const scanStub = () => ({
  log: [], testPlan: 'Funktionalität: x', coverage: { scenarios: 5, functions: 1, functionsCovered: 1, branches: 0, branchesCovered: 0, params: 0, paramsCovered: 0 },
  codedTests: [], libs: [{ name: 'jquery', version: '3.4.1', status: 'verwundbar' }],
  outdated: [], risks: [], failures: [], artifacts: [{ status: 'ok' }], type: 'plugin', format: 'export',
});
const fetchInfoStub = async () => ({ latest: '3.7.1', releasedAt: '2023-08-28T00:00:00Z', time: {}, links: { source: 'https://github.com/jquery/jquery', homepage: null, npm: 'https://www.npmjs.com/package/jquery' } });

describe('T-66 Vollautomatische Pflege = manuelle Pflege', () => {
  function setup() {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: '/repo', repo: 'P' });
    return store;
  }
  const baseDeps = (calls) => ({
    exists: () => true,
    scan: scanStub,
    fetchInfo: fetchInfoStub,
    now: () => 't',
    update: async (_s, c) => { calls.update = c.name; return { summary: 'jquery 3.4.1 → 3.7.1' }; },
    autoFix: async (_s, _c, _d) => { calls.autoFix = true; return { quickFixes: 2, libUpdate: { summary: 'x' }, aiResult: null }; },
  });

  it('führt den vollen Zyklus in Reihenfolge aus + setzt libsCheckedAt + Quelle-Link', async () => {
    const store = setup();
    const calls = {};
    const r = await maintainComponent(store, store.get('c1'), baseDeps(calls));
    expect(r.steps.map((s) => s.step)).toEqual(['prüfen', 'lib-check', 'autofix', 're-test']);
    expect(calls.autoFix).toBe(true);
    expect(store.get('c1').libsCheckedAt).toBe('t');
    expect(store.get('c1').libs[0].source).toBe('https://github.com/jquery/jquery');
    expect(store.get('c1').libs[0].outdated).toBe(true); // relevantes Update erkannt
  });

  it('ohne Repo → übersprungen, kein Abbruch', async () => {
    const store = setup();
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), exists: () => false });
    expect(r.skipped).toBe(true);
  });

  it('maintainAll nutzt dieselbe Orchestrierung je Komponente', async () => {
    const store = setup();
    store.add({ name: 'Q', path: '/repo2', repo: 'Q' });
    const results = await maintainAll(store, baseDeps({}));
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.steps?.length === 4)).toBe(true);
  });

  it('zeichnet einen Lauf auf (recordRun)', async () => {
    const store = setup();
    const runs = [];
    await maintainComponent(store, store.get('c1'), { ...baseDeps({}), recordRun: (e) => runs.push(e) });
    expect(runs).toHaveLength(1);
    expect(runs[0].repo).toBe('P');
  });
});
