import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createComponentStore } from '../src/gui/store.js';
import { overviewViewModel, detailViewModel, openDirectory, manualReview } from '../src/gui/components.js';
import { apiHandler } from '../src/gui/api.js';

let n;
const fixedNow = () => '2026-06-24T00:00:00Z';
const seqId = () => `c${++n}`;
const newStore = (file) => createComponentStore({ now: fixedNow, idGen: seqId, file });

beforeEach(() => { n = 0; });

describe('T-32 Komponenten-Registry', () => {
  it('anlegen, bearbeiten, löschen', () => {
    const s = newStore();
    const c = s.add({ name: 'ColorPicker', type: 'plugin', path: '/x' });
    expect(c.id).toBe('c1');
    expect(s.list()).toHaveLength(1);
    s.update('c1', { status: 'getestet' });
    expect(s.get('c1').status).toBe('getestet');
    expect(s.remove('c1')).toBe(true);
    expect(s.list()).toHaveLength(0);
  });

  it('Notiz/Protokoll anhängen', () => {
    const s = newStore();
    s.add({ name: 'A' });
    const note = s.addNote('c1', { kind: 'protokoll', text: 'manuell geprüft' });
    expect(note).toMatchObject({ at: '2026-06-24T00:00:00Z', kind: 'protokoll', text: 'manuell geprüft' });
    expect(s.get('c1').notes).toHaveLength(1);
  });

  it('Persistenz übersteht Neustart', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-store-'));
    const file = path.join(tmp, 'components.json');
    const s1 = newStore(file);
    s1.add({ name: 'Persistent' });
    s1.addNote('c1', { text: 'bleibt' });

    n = 0;
    const s2 = createComponentStore({ file, now: fixedNow, idGen: seqId });
    expect(s2.list()).toHaveLength(1);
    expect(s2.get('c1').notes[0].text).toBe('bleibt');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('T-33 View-Model & Aktionen', () => {
  it('Übersicht zeigt Kernfelder + letzte Änderung', () => {
    const s = newStore();
    s.add({ name: 'Slider', type: 'template_component', format: 'export', status: 'ok' });
    s.setLastChange('c1', 'jquery 3.4.1 → 3.7.1');
    const vm = overviewViewModel(s);
    expect(vm[0]).toMatchObject({ name: 'Slider', type: 'template_component', formatBadge: 'APEX-SQL-Export', status: 'ok', changeSummary: 'jquery 3.4.1 → 3.7.1' });
  });

  it('Übersicht liefert source (Repo-Zuordnung) — sonst hält listengetriebene Logik jedes Plugin für „kein Repo"', () => {
    const s = newStore();
    s.add({ name: 'Flow', type: 'plugin', format: 'export', status: 'handlungsbedarf', source: 'https://github.com/org/flow', visibility: 'öffentlich' });
    const vm = overviewViewModel(s);
    expect(vm[0]).toMatchObject({ source: 'https://github.com/org/flow', visibility: 'öffentlich' });
    // ohne Repo: source falsy (Banner/Filter dürfen dann ehrlich „kein Repo" annehmen)
    s.add({ name: 'NoRepo', type: 'plugin' });
    expect(overviewViewModel(s).find((c) => c.name === 'NoRepo').source).toBeFalsy();
  });

  it('Übersicht liefert mockUrl/mockMode für den „Open mock"-Button (F-29)', () => {
    const s = newStore();
    s.add({ name: 'Flow', type: 'plugin', format: 'export', status: 'ok' });
    s.update('c1', { mockUrl: 'http://x/mock/flow/index.html', mockMode: 'ai' });
    const vm = overviewViewModel(s);
    expect(vm[0]).toMatchObject({ mockUrl: 'http://x/mock/flow/index.html', mockMode: 'ai' });
    // ohne Mock: null (Button wird dann nicht gerendert)
    s.add({ name: 'NoMock', type: 'plugin' });
    expect(overviewViewModel(s).find((c) => c.name === 'NoMock')).toMatchObject({ mockUrl: null, mockMode: null });
  });

  it('Verzeichnis öffnen ruft den OS-Opener mit dem Pfad', () => {
    const calls = [];
    const res = openDirectory('D:/plugins/x', { platform: 'win32', spawn: (cmd, args) => calls.push([cmd, args]) });
    expect(res.ok).toBe(true);
    expect(calls[0][0]).toBe('explorer');
    expect(calls[0][1]).toEqual(['D:/plugins/x']);
    // macOS-Variante
    const mac = openDirectory('/p', { platform: 'darwin', spawn: () => {} });
    expect(mac.command).toMatch(/^open /);
  });

  it('Manuelles Review liefert Findings und sichert eine Review-Notiz', () => {
    const s = newStore();
    s.add({ name: 'X', path: '/x' });
    const gather = () => ({ assets: [{ name: 'x.js', code: 'el.innerHTML = a + b;' }], cve: [] });
    const r = manualReview(s, 'c1', { gather, save: true });
    expect(r.gate.pass).toBe(false);
    expect(r.gate.stage).toBe('security');
    expect(r.saved.findingsCount).toBeGreaterThan(0);
    expect(s.get('c1').reviews).toHaveLength(1);
  });
});

describe('T-34 REST-API-Handler', () => {
  const ctx = () => ({ store: newStore(), gather: () => ({ assets: [{ name: 'ok.js', code: 'function f(){ return apex.item("X").getValue(); }' }] }) });

  it('GET /api/components liefert die Liste', () => {
    const c = ctx();
    c.store.add({ name: 'A' });
    const res = apiHandler('GET', '/api/components', null, c);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST legt an, DELETE entfernt', () => {
    const c = ctx();
    const created = apiHandler('POST', '/api/components', { name: 'Neu' }, c);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(apiHandler('GET', `/api/components/${id}`, null, c).status).toBe(200);
    expect(apiHandler('DELETE', `/api/components/${id}`, null, c).status).toBe(200);
    expect(apiHandler('GET', `/api/components/${id}`, null, c).status).toBe(404);
  });

  it('Notiz und Review über die API', () => {
    const c = ctx();
    const id = apiHandler('POST', '/api/components', { name: 'A', path: '/x' }, c).body.id;
    const note = apiHandler('POST', `/api/components/${id}/notes`, { text: 'hi' }, c);
    expect(note.status).toBe(200);
    const review = apiHandler('POST', `/api/components/${id}/review`, { save: true }, c);
    expect(review.status).toBe(200);
    expect(review.body.gate.pass).toBe(true); // sauberer Code
  });

  it('unbekannte Route → 404', () => {
    expect(apiHandler('GET', '/api/unbekannt', null, ctx()).status).toBe(404);
  });
});
