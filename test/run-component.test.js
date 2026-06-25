import { describe, it, expect } from 'vitest';
import { summarize, runComponentOnce, runManaged } from '../src/service/run-component.js';
import { createComponentStore } from '../src/gui/store.js';
import { apiHandler, metaApiHandler } from '../src/gui/api.js';

const scanVuln = () => ({ artifacts: [{ status: 'ok', static: { retire: { findings: [{ lib: 'jquery', version: '3.4.1' }] }, lint: { ok: true } } }], outdated: [], risks: [], failures: [] });
const scanClean = () => ({ artifacts: [{ status: 'ok', static: { retire: { findings: [] }, lint: { ok: true } } }], outdated: [], risks: [], failures: [] });
const scanLint = () => ({ artifacts: [{ status: 'ok', static: { retire: { findings: [] }, lint: { ok: false, findings: [{ message: 'parse' }] } } }], outdated: [], risks: [], failures: [] });

const mkStore = () => createComponentStore({ now: () => '2026-06-24T00:00:00Z', idGen: (() => { let n = 0; return () => `c${++n}`; })() });

describe('T-38 summarize & runComponentOnce', () => {
  it('Schwachstelle → Zusammenfassung + Status handlungsbedarf', () => {
    const s = summarize(scanVuln());
    expect(s.summary).toMatch(/vulnerab/i);
    expect(s.status).toBe('handlungsbedarf');
  });
  it('sauber → keine Auffälligkeiten + ok', () => {
    expect(summarize(scanClean())).toMatchObject({ summary: 'up to date, no issues', status: 'ok' });
  });
  it('unbekannte Lib-Version → handlungsbedarf + Summary nennt sie (B-4)', () => {
    const s = summarize({ artifacts: [{ status: 'ok' }], outdated: [], risks: [], failures: [], libWarning: { vulnerable: 0, unmaintained: 0, unknown: 1 } });
    expect(s.status).toBe('handlungsbedarf');
    expect(s.summary).toMatch(/unknown version/i);
  });
  it('Lint-Fehler → zu klären', () => {
    expect(summarize(scanLint()).status).toBe('zu klären');
  });
  it('schreibt lastChange + Status in den Store', () => {
    const store = mkStore();
    const c = store.add({ name: 'X', path: '/x' });
    const r = runComponentOnce(store, c, { scan: scanVuln });
    expect(r.status).toBe('handlungsbedarf');
    const after = store.get(c.id);
    expect(after.lastChange).toMatchObject({ at: '2026-06-24T00:00:00Z' });
    expect(after.lastChange.summary).toMatch(/vulnerab/i);
    expect(after.status).toBe('handlungsbedarf');
  });
});

describe('T-38 runManaged', () => {
  it('aktualisiert alle und schreibt genau EINEN History-Eintrag', () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a' });
    store.add({ name: 'B', path: '/b' });
    const runs = [];
    const res = runManaged({ store, scan: scanClean, recordRun: (e) => runs.push(e), idGen: () => 'run-1' });
    expect(res.count).toBe(2);
    expect(runs).toHaveLength(1);
    expect(store.list().every((c) => c.lastChange)).toBe(true);
  });
  it('Repo-Filter aktualisiert nur das betroffene Repo (Scheduler-Pfad)', () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a', repo: 'r1' });
    store.add({ name: 'B', path: '/b', repo: 'r2' });
    runManaged({ store, scan: scanVuln, recordRun: () => {}, repo: 'r1' });
    expect(store.list().find((c) => c.repo === 'r1').lastChange).toBeTruthy();
    expect(store.list().find((c) => c.repo === 'r2').lastChange).toBeNull();
  });
});

describe('T-39 API', () => {
  it('POST /api/components/:id/run prüft eine Komponente', () => {
    const store = mkStore();
    const id = store.add({ name: 'X', path: '/x' }).id;
    const res = apiHandler('POST', `/api/components/${id}/run`, null, { store, scan: scanVuln });
    expect(res.status).toBe(200);
    expect(store.get(id).lastChange.summary).toMatch(/vulnerab/i);
  });
  it('POST /api/run aktualisiert alle Komponenten', async () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a' });
    store.add({ name: 'B', path: '/b' });
    let runs = 0;
    const res = await metaApiHandler('POST', '/api/run', {}, { settings: { repos: [] }, store, scan: scanClean, recordRun: () => runs++ });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(runs).toBe(1);
    expect(store.list().every((c) => c.lastChange)).toBe(true);
  });
});
