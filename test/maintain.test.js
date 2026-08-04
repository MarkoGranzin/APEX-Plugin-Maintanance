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
    expect(r.steps.map((s) => s.step)).toEqual(['check', 'lib-check', 'autofix', 're-test']);
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

  it('unmaintained Lib → migrate-Schritt mit pflichtenfreiem Adapter-Ersatz (für AI-Migration/Gate)', async () => {
    const store = setup();
    const scanUnmaint = () => ({ ...scanStub(), libs: [{ name: 'moment', version: '2.29.0', status: 'nicht gepflegt', unmaintained: true }] });
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), scan: scanUnmaint, ai: { kind: 'cli' } });
    const mig = r.steps.find((s) => s.step === 'migrate' && s.replace);
    expect(mig).toBeTruthy();
    expect(mig.name).toBe('moment');
    expect(mig.to).toBe('dayjs'); // MIT, pflichtenfrei, gleichwertig → Adapter-Pfad
    expect(mig.strategy).toBe('replace');
    expect(store.get('c1').libs[0].replacement?.to).toBe('dayjs'); // Ersatz an Lib angehängt (GUI)
  });

  it('T-164: unmaintained Lib mit Pflichten-Nachfolger (Apache) → migrate-Schritt als Interface-Neubau (self-build)', async () => {
    const store = setup();
    const scanUnmaint = () => ({ ...scanStub(), libs: [{ name: 'mxgraph', version: '3.9.12', status: 'nicht gepflegt', unmaintained: true }] });
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), scan: scanUnmaint, ai: { kind: 'cli' } });
    const mig = r.steps.find((s) => s.step === 'migrate' && s.replace);
    expect(mig).toBeTruthy();
    expect(mig.name).toBe('mxgraph');
    expect(mig.to).toBeNull(); // @maxgraph/core ist Apache-2.0 (Attributionspflicht) → kein Adapter-Pfad
    expect(mig.strategy).toBe('self-build');
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
    // grün = keine problematische Lib (sonst korrekt handlungsbedarf)
    const scanGreen = () => ({ ...scanStub(), libs: [] });
    const r = await maintainComponent(store, store.get('c1'), { ...baseDeps({}), scan: scanGreen, autoUpload: true, upload });
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
    expect(mig.reason).toMatch(/AI backend is required/);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('T-153 Vorher/Nachher-Gate im regulären Pflegelauf', () => {
  const mkStore = () => { const s = createComponentStore({ now: () => 't', idGen: () => 'c1' }); s.add({ name: 'P', path: '/repo', repo: 'P', uiTestUrl: 'http://x/mock' }); return s; };
  // Basis-Deps mit angewandtem Lib-Update (backups nicht leer) + Gate aktiv.
  const gateDeps = (over = {}, calls = {}) => ({
    exists: () => true, scan: scanStub, fetchInfo: fetchInfoStub, now: () => 't',
    update: async () => ({ summary: 'x' }),
    autoFix: async () => ({ quickFixes: 0, aiResult: null }),
    applyVendoredUpdates: async () => ({ results: [{ name: 'jquery', from: '3.4.1', to: '3.7.1', applied: true }], backups: over.backups ?? new Map() }),
    worksAsBefore: true,
    captureBaseline: async (s, c) => { calls.captured = true; s.update(c.id, { baseline: { scenarios: [{ scenario: 'a', status: 'passed' }], mode: 'ui' } }); },
    rebuildMock: async () => { calls.rebuilt = (calls.rebuilt || 0) + 1; },
    runDetailed: async () => ({ ran: true, scenarios: over.afterScenarios ?? [{ scenario: 'a', status: 'passed' }] }),
    compareToBaseline: (_c, cur) => ({ pass: cur.every((s) => s.status === 'passed'), regressions: cur.filter((s) => s.status !== 'passed'), summary: 'x' }),
    ...over.deps,
  });

  it('friert die Baseline VOR der ersten Änderung ein (wenn keine da ist)', async () => {
    const store = mkStore(); const calls = {};
    const r = await maintainComponent(store, store.get('c1'), gateDeps({}, calls));
    expect(calls.captured).toBe(true);
    expect(r.steps.find((s) => s.step === 'baseline')?.captured).toBe(true);
    // baseline-Schritt kommt VOR lib-update
    const iB = r.steps.findIndex((s) => s.step === 'baseline'); const iU = r.steps.findIndex((s) => s.step === 'lib-update');
    expect(iB).toBeLessThan(iU);
  });

  it('wie zuvor → Änderung bleibt (kein Rollback)', async () => {
    const store = mkStore();
    const r = await maintainComponent(store, store.get('c1'), gateDeps({ afterScenarios: [{ scenario: 'a', status: 'passed' }] }));
    expect(r.worksAsBefore.pass).toBe(true);
    expect(r.worksAsBefore.rolledBack).toBeFalsy();
  });

  it('Regression → Rollback der Lib-Änderungen', async () => {
    const tmp = path.join(os.tmpdir(), 'aisp-wab-' + Date.now() + '.txt'); fs.writeFileSync(tmp, 'NEW');
    const backups = new Map([[tmp, 'OLD']]); const calls = {};
    const store = mkStore();
    const r = await maintainComponent(store, store.get('c1'), gateDeps({ backups, afterScenarios: [{ scenario: 'a', status: 'failed' }] }, calls));
    expect(r.worksAsBefore.pass).toBe(false);
    expect(r.worksAsBefore.rolledBack).toBe(true);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('OLD'); // Rollback hat die Datei zurückgesetzt
    expect(calls.rebuilt).toBe(2); // Mock nachher + nach Rollback erneut
    fs.rmSync(tmp, { force: true });
  });

  it('Gate aus → kein Baseline/kein Vergleich', async () => {
    const store = mkStore(); const calls = {};
    const d = gateDeps({}, calls); d.worksAsBefore = false;
    const r = await maintainComponent(store, store.get('c1'), d);
    expect(calls.captured).toBeFalsy();
    expect(r.worksAsBefore).toBeNull();
  });

  it('B-70: „Nachher"-Mock nutzt refreshMockLibs (kein KI-Neubau) statt rebuildMock', async () => {
    const store = mkStore(); const calls = {};
    const d = gateDeps({ afterScenarios: [{ scenario: 'a', status: 'passed' }] }, calls);
    d.refreshMockLibs = async () => { calls.refreshed = (calls.refreshed || 0) + 1; };
    const r = await maintainComponent(store, store.get('c1'), d);
    expect(r.worksAsBefore.pass).toBe(true);
    expect(calls.refreshed).toBe(1);   // Libs re-synchronisiert (gleiche Szenarien)
    expect(calls.rebuilt).toBeFalsy();  // KEIN nicht-deterministischer KI-Neubau für den Vergleich
  });

  it('B-70: Regression → Rollback re-synchronisiert die Libs erneut (refreshMockLibs 2×), kein rebuildMock', async () => {
    const tmp = path.join(os.tmpdir(), 'aisp-wab70-' + Date.now() + '.txt'); fs.writeFileSync(tmp, 'NEW');
    const backups = new Map([[tmp, 'OLD']]); const calls = {};
    const store = mkStore();
    const d = gateDeps({ backups, afterScenarios: [{ scenario: 'a', status: 'failed' }] }, calls);
    d.refreshMockLibs = async () => { calls.refreshed = (calls.refreshed || 0) + 1; };
    const r = await maintainComponent(store, store.get('c1'), d);
    expect(r.worksAsBefore.rolledBack).toBe(true);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('OLD');
    expect(calls.refreshed).toBe(2); // nachher + nach Rollback
    expect(calls.rebuilt).toBeFalsy();
    fs.rmSync(tmp, { force: true });
  });
});
