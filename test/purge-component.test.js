import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isUnder, managedPaths, purgeComponent } from '../src/service/purge-component.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
const workDir = path.resolve('/work');
const dataDir = path.resolve('/data');

function fakeStore(comp) {
  let items = comp ? [comp] : [];
  return {
    get: (id) => items.find((x) => x.id === id) || null,
    remove: (id) => { const b = items.length; items = items.filter((x) => x.id !== id); return items.length < b; },
    _items: () => items,
  };
}

describe('T-143 purgeComponent — Plugin überall löschen', () => {
  it('isUnder: verwaltete Pfade erkennen, fremde ablehnen', () => {
    expect(isUnder(path.join(workDir, 'plugin-x'), workDir)).toBe(true);
    expect(isUnder('/home/user/mein-repo', workDir)).toBe(false);
    expect(isUnder(workDir, workDir)).toBe(false); // der Ordner selbst ist nicht „unterhalb"
  });

  it('managedPaths: gemanagten Klon löschen, EXTERNES Repo verschonen', () => {
    const managed = managedPaths({ name: 'My.Plugin', path: path.join(workDir, 'my-plugin') }, { dataDir, workDir, slugify });
    expect(managed.list).toContain(path.join(workDir, 'my-plugin'));
    expect(managed.list).toContain(path.join(dataDir, 'logs', 'my.plugin'));
    expect(managed.list).toContain(path.join(dataDir, 'ui-tests', 'my.plugin'));
    expect(managed.skipped).toHaveLength(0);

    const external = managedPaths({ name: 'My.Plugin', path: '/home/user/eigenes-repo' }, { dataDir, workDir, slugify });
    expect(external.list).not.toContain('/home/user/eigenes-repo'); // NICHT löschen
    expect(external.skipped[0].path).toBe('/home/user/eigenes-repo');
  });

  it('purge: APEX-Cleanup + verwaltete Pfade entfernt + aus Registry raus', async () => {
    const comp = { id: 'c1', name: 'My.Plugin', path: path.join(workDir, 'my-plugin'), apexPageId: 20050 };
    const store = fakeStore(comp);
    const removed = [];
    let apexArg = null;
    const r = await purgeComponent(store, 'c1', {
      apexCleanup: async (c) => { apexArg = c; return { ok: true, page: { deleted: true }, plugin: { deleted: true } }; },
      dataDir, workDir, slugify,
      exists: () => true, // alle Pfade existieren
      rm: (p) => removed.push(p),
    });
    expect(r.ok).toBe(true);
    expect(r.apex.ok).toBe(true);
    expect(apexArg.apexPageId).toBe(20050);
    expect(removed).toContain(path.join(workDir, 'my-plugin'));
    expect(removed).toContain(path.join(dataDir, 'logs', 'my.plugin'));
    expect(r.registry).toBe(true);
    expect(store.get('c1')).toBe(null); // wirklich aus der Registry entfernt
  });

  it('purge: externes Repo bleibt auf der Platte, wird nur aus Tool/APEX entfernt', async () => {
    const comp = { id: 'c2', name: 'Ext', path: '/home/user/eigenes-repo', apexPageId: 20051 };
    const store = fakeStore(comp);
    const removed = [];
    const r = await purgeComponent(store, 'c2', {
      apexCleanup: async () => ({ ok: true }), dataDir, workDir, slugify,
      exists: (p) => p === '/home/user/eigenes-repo', rm: (p) => removed.push(p),
    });
    expect(removed).not.toContain('/home/user/eigenes-repo'); // fremde Dateien unangetastet
    expect(r.skipped[0].path).toBe('/home/user/eigenes-repo');
    expect(r.registry).toBe(true);
  });

  it('purge: APEX-Cleanup schlägt fehl → Platte + Registry trotzdem gelöscht, ehrlich gemeldet', async () => {
    const comp = { id: 'c3', name: 'P', path: path.join(workDir, 'p') };
    const store = fakeStore(comp);
    const r = await purgeComponent(store, 'c3', {
      apexCleanup: async () => { throw new Error('APEX down'); },
      dataDir, workDir, slugify, exists: () => true, rm: () => {},
    });
    expect(r.apex.ok).toBe(false);
    expect(r.apex.error).toMatch(/APEX down/);
    expect(r.registry).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('purge: unbekannte id → not found, nichts passiert', async () => {
    const store = fakeStore(null);
    const r = await purgeComponent(store, 'nope', { dataDir, workDir, slugify, exists: () => true, rm: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});
