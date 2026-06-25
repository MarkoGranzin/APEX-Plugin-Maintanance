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

  it('Job-Auto-Upload nur bei grün: grün → Upload ausgeführt, reviewUrl gesetzt', async () => {
    const store = setup();
    let uploaded = null;
    const upload = async (c) => { uploaded = c.name; return { ok: true, branch: 'aisp/x', pushed: true, prUrl: 'https://github.com/o/r/compare/aisp%2Fx?expand=1' }; };
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), autoUpload: true, upload });
    expect(r.status).toBe('green');
    expect(uploaded).toBe('P');
    expect(store.get('c1').reviewUrl).toMatch(/compare/);
    expect(r.steps.some((s) => s.step === 'upload' && s.pushed)).toBe(true);
  });

  it('Job-Auto-Upload bei rot NICHT', async () => {
    const store = setup();
    let uploaded = false;
    const scanRed = () => ({ ...scanStub(), libWarning: { vulnerable: 1, unmaintained: 0 } });
    const upload = async () => { uploaded = true; return { ok: true }; };
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), scan: scanRed, autoUpload: true, upload });
    expect(r.status).not.toBe('green');
    expect(uploaded).toBe(false);
  });

  it('Breaking-Lib-Update: ohne KI meldet die Software „KI-Backend erforderlich" (kein manuell)', async () => {
    const store = setup();
    const applyVendoredUpdates = async () => ({ results: [{ name: 'jquery', from: '1.12.4', to: '4.0.0', applied: false, breaking: true, reason: 'breaking (Major) — Migration durch KI-Agent der Software' }], backups: new Map() });
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), applyVendoredUpdates, ai: { kind: 'stub' } });
    const mig = r.steps.find((s) => s.step === 'migrate' && s.skipped);
    expect(mig).toBeTruthy();
    expect(mig.reason).toMatch(/KI-Backend erforderlich/);
  });

  it('Regression nach sicherem Update → Rollback', async () => {
    const store = setup();
    const applyVendoredUpdates = async () => ({ results: [{ name: 'jsonpath', from: '0.8.0', to: '0.9.0', applied: true, file: 'lib/jsonpath.js' }], backups: new Map([['/x/lib/jsonpath.js', 'old']]) });
    let calls = 0;
    const scan = () => { calls++; const clarify = calls >= 2; return { log: [], testPlan: 'X', coverage: null, codedTests: [], libs: [{ name: 'jsonpath', version: '0.8.0', status: 'aktuell' }], artifacts: [{ status: clarify ? 'clarify' : 'ok' }], outdated: [], risks: [], failures: [] }; };
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), scan, applyVendoredUpdates });
    expect(r.steps.some((s) => s.step === 'lib-update' && s.rolledBack)).toBe(true);
  });

  it('Sicheres Lib-Update wird von der Software eingespielt (applied)', async () => {
    const store = setup();
    const applyVendoredUpdates = async () => ({ results: [{ name: 'jsonpath', from: '0.8.0', to: '0.9.0', applied: true, file: 'lib/jsonpath.js' }], backups: new Map() });
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), applyVendoredUpdates });
    expect(r.steps.some((s) => s.step === 'lib-update' && s.applied)).toBe(true);
  });

  it('zeichnet einen Lauf auf (recordRun)', async () => {
    const store = setup();
    const runs = [];
    await maintainComponent(store, store.get('c1'), { ...baseDeps({}), recordRun: (e) => runs.push(e) });
    expect(runs).toHaveLength(1);
    expect(runs[0].repo).toBe('P');
  });
});
