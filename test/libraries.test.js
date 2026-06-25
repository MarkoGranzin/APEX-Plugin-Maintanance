import { describe, it, expect } from 'vitest';
import { collectLibraries } from '../src/service/libraries.js';
import { unmaintainedReason } from '../src/test/static.js';
import { createComponentStore } from '../src/gui/store.js';
import { overviewViewModel } from '../src/gui/components.js';
import { metaApiHandler } from '../src/gui/api.js';

const scan = (p) => {
  if (p === '/a') return { artifacts: [{ components: [{ name: 'jquery', version: '3.4.1' }], static: { retire: { findings: [{ lib: 'jquery', version: '3.4.1', vuln: 'CVE-2020-11022', fixedFrom: '3.5.0' }] } }, updates: [] }] };
  return { artifacts: [{ components: [{ name: 'angular', version: '1.8.2' }, { name: 'jquery', version: '3.4.1' }], static: { retire: { findings: [{ lib: 'jquery', version: '3.4.1', vuln: 'CVE-2020-11022', fixedFrom: '3.5.0' }] } }, updates: [] }] };
};
const mkStore = () => createComponentStore({ now: () => 't', idGen: (() => { let n = 0; return () => `c${++n}`; })() });

describe('T-46 collectLibraries', () => {
  it('aggregiert Libs über Komponenten mit usedBy', () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a' });
    store.add({ name: 'B', path: '/b' });
    const { libraries } = collectLibraries(store, { scan });
    const jq = libraries.find((l) => l.name === 'jquery');
    expect(jq.usedBy.sort()).toEqual(['A', 'B']);
    expect(jq.vulnerable).toBe(true);
    expect(jq.status).toBe('verwundbar');
  });

  it('markiert nicht gepflegte (EOL) Libs', () => {
    const store = mkStore();
    store.add({ name: 'B', path: '/b' });
    const { libraries } = collectLibraries(store, { scan });
    const ng = libraries.find((l) => l.name === 'angular');
    expect(ng.unmaintained).toBe(true);
    expect(ng.status).toBe('nicht gepflegt');
    expect(ng.reason).toMatch(/EOL|gepflegt/);
  });

  it('setzt libWarning je Komponente', () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a' });
    store.add({ name: 'B', path: '/b' });
    collectLibraries(store, { scan });
    expect(store.get('c1').libWarning).toMatchObject({ vulnerable: 1 });
    expect(store.get('c2').libWarning).toMatchObject({ vulnerable: 1, unmaintained: 1 });
  });

  it('Komponente ohne Pfad → libWarning null', () => {
    const store = mkStore();
    store.add({ name: 'X' });
    collectLibraries(store, { scan });
    expect(store.get('c1').libWarning).toBeNull();
  });

  it('unmaintainedReason kennt EOL-Libs', () => {
    expect(unmaintainedReason('angular')).toBeTruthy();
    expect(unmaintainedReason('AngularJS')).toBeTruthy();
    expect(unmaintainedReason('jquery')).toBeNull();
  });
});

describe('T-47 Übersicht & API', () => {
  it('overviewViewModel reicht libWarning durch', () => {
    const store = mkStore();
    const id = store.add({ name: 'A', path: '/a' }).id;
    store.update(id, { libWarning: { vulnerable: 2, unmaintained: 0 } });
    expect(overviewViewModel(store)[0].libWarning).toEqual({ vulnerable: 2, unmaintained: 0 });
  });

  it('GET /api/libraries liefert die Aggregation', async () => {
    const store = mkStore();
    store.add({ name: 'A', path: '/a' });
    const res = await metaApiHandler('GET', '/api/libraries', null, { store, scan });
    expect(res.status).toBe(200);
    expect(res.body.libraries.length).toBeGreaterThan(0);
  });
});
