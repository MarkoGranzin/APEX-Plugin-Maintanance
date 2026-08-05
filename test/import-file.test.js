import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importFromFiles } from '../src/service/import-file.js';

// Minimaler, echter Store (list/add/update) — genug für Upsert-Verhalten.
function makeStore() {
  let items = []; let n = 0;
  return {
    list: () => items.map((x) => ({ ...x })),
    add: (d) => { const c = { id: `c${++n}`, notes: [], reviews: [], ...d }; items.push(c); return { ...c }; },
    update: (id, patch) => { const c = items.find((x) => x.id === id); if (!c) return null; Object.assign(c, patch); return { ...c }; },
    _items: () => items,
  };
}

const REGION_SQL = `wwv_flow_api.create_plugin(\n p_name=>'MY.PLUGIN'\n,p_plugin_type=>'REGION TYPE'\n,p_display_name=>'My Plugin'\n,p_api_version=>1\n);`;

describe('T-144 importFromFiles — Plugin aus Dateien (kein Git)', () => {
  let workDir;
  const realDeps = () => ({ workDir, mkdir: (p) => fs.mkdirSync(p, { recursive: true }), writeFile: (p, c) => fs.writeFileSync(p, c) });

  beforeEach(() => { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisp-imp-')); });
  afterEach(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* egal */ } });

  it('legt Plugin aus .sql (+ Asset) in verwaltetem Verzeichnis an', () => {
    const store = makeStore();
    const r = importFromFiles(store, {
      name: 'Color Picker',
      files: [{ name: 'region_type_plugin_x.sql', content: REGION_SQL }, { name: 'plugin.js', content: 'console.log(1)' }],
    }, realDeps());
    expect(r.ok).toBe(true);
    expect(r.component.source).toBe('Datei-Import');
    expect(r.component.repo).toBe(null);
    expect(r.component.path.startsWith(workDir)).toBe(true);
    // Dateien wurden real geschrieben
    expect(fs.existsSync(path.join(r.component.path, 'region_type_plugin_x.sql'))).toBe(true);
    expect(fs.existsSync(path.join(r.component.path, 'plugin.js'))).toBe(true);
    expect(r.files).toContain('plugin.js');
  });

  it('leitet den Namen aus der .sql ab, wenn keiner angegeben', () => {
    const store = makeStore();
    const r = importFromFiles(store, { files: [{ name: 'region_type_plugin_bargraphs.sql', content: REGION_SQL }] }, realDeps());
    expect(r.ok).toBe(true);
    expect(r.component.name).toBe('region_type_plugin_bargraphs');
  });

  it('Re-Import desselben Plugins aktualisiert statt zu duplizieren', () => {
    const store = makeStore();
    const p = { name: 'Dup', files: [{ name: 'region_type_plugin_x.sql', content: REGION_SQL }] };
    const a = importFromFiles(store, p, realDeps());
    const b = importFromFiles(store, p, realDeps());
    expect(store._items()).toHaveLength(1); // kein Duplikat
    expect(b.component.id).toBe(a.component.id);
  });

  it('ohne .sql → Fehler bei NEUEM Plugin (Plugin-Export nötig)', () => {
    const r = importFromFiles(makeStore(), { name: 'Neu', files: [{ name: 'plugin.js', content: 'x' }] }, realDeps());
    expect(r.error).toMatch(/\.sql/);
    // ohne .sql UND ohne Namen ist nichts ableitbar
    expect(importFromFiles(makeStore(), { files: [{ name: 'plugin.js', content: 'x' }] }, realDeps()).error).toMatch(/name/i);
  });

  it('B-76: Nachreichen OHNE .sql erlaubt, wenn der Import-Ordner schon einen Export enthält', () => {
    const store = makeStore();
    const deps = realDeps();
    importFromFiles(store, { name: 'Leaflet', files: [{ name: 'x.sql', content: REGION_SQL }] }, deps);
    const r = importFromFiles(store, { name: 'Leaflet', files: [{ name: 'leaflet.js', content: '/* Leaflet 1.7.1 */' }] }, deps);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(r.component.path, 'leaflet.js'))).toBe(true);   // nachgereicht
    expect(fs.existsSync(path.join(r.component.path, 'x.sql'))).toBe(true);        // Export bleibt
    expect(store._items()).toHaveLength(1);                                        // kein Duplikat
  });

  it('ohne Dateien → Fehler', () => {
    const r = importFromFiles(makeStore(), { files: [] }, realDeps());
    expect(r.error).toMatch(/No files/);
  });

  it('Pfad-Traversal / fremde Endung → abgelehnt', () => {
    expect(importFromFiles(makeStore(), { files: [{ name: '../evil.sql', content: 'x' }] }, realDeps()).error).toMatch(/file name/i);
    expect(importFromFiles(makeStore(), { files: [{ name: 'plugin.exe', content: 'x' }] }, realDeps()).error).toMatch(/file name|\.sql/i);
  });
});
