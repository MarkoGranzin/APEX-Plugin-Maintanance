import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRepo, cloneOrFetch } from '../src/repo/repository.js';

// T-166 — Ordner-Import: lokaler Ordner OHNE .git wird ins Workspace KOPIERT (nie geklont),
// das Original bleibt unangetastet; Re-Assign synct; .maintenance des Ziels überlebt.

let src, dst;
beforeEach(() => {
  src = fs.mkdtempSync(path.join(os.tmpdir(), 't166-src-'));
  dst = fs.mkdtempSync(path.join(os.tmpdir(), 't166-dst-'));
  fs.mkdirSync(path.join(src, 'js', 'lib', 'leaflet'), { recursive: true });
  fs.mkdirSync(path.join(src, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.sql'), 'wwv_flow_api.create_plugin(...);');
  fs.writeFileSync(path.join(src, 'js', 'lib', 'leaflet', 'leaflet.js'), '/* Leaflet 1.7.1 */');
  fs.writeFileSync(path.join(src, 'node_modules', 'x', 'index.js'), 'skip me');
});
afterEach(() => { for (const d of [src, dst]) fs.rmSync(d, { recursive: true, force: true }); });

const repoFor = (source) => addRepo({ name: 'p', source });

describe('T-166 Ordner-Import (kopieren statt klonen)', () => {
  it('kopiert die komplette Struktur (ohne node_modules/.git) und lässt das Original unangetastet', async () => {
    const before = fs.readdirSync(src).sort();
    const r = await cloneOrFetch(repoFor(src), dst, { gitFactory: () => { throw new Error('git darf hier NICHT laufen'); } });
    expect(r.action).toBe('copy');
    expect(fs.existsSync(path.join(dst, 'plugin.sql'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'js', 'lib', 'leaflet', 'leaflet.js'))).toBe(true); // Struktur erhalten
    expect(fs.existsSync(path.join(dst, 'node_modules'))).toBe(false);
    expect(fs.readdirSync(src).sort()).toEqual(before);            // Quelle: kein .maintenance, nichts verändert
    expect(fs.existsSync(path.join(src, '.maintenance'))).toBe(false);
  });

  it('Re-Assign synct: verwaiste Ziel-Dateien verschwinden, .maintenance des Ziels überlebt', async () => {
    await cloneOrFetch(repoFor(src), dst);
    fs.mkdirSync(path.join(dst, '.maintenance', 'mock'), { recursive: true });
    fs.writeFileSync(path.join(dst, '.maintenance', 'mock', 'index.html'), '<html>mock</html>');
    fs.writeFileSync(path.join(dst, 'stale.js'), 'orphan');       // existiert in der Quelle nicht
    await cloneOrFetch(repoFor(src), dst);                          // Sync
    expect(fs.existsSync(path.join(dst, 'stale.js'))).toBe(false);  // verwaist → weg
    expect(fs.readFileSync(path.join(dst, '.maintenance', 'mock', 'index.html'), 'utf8')).toContain('mock'); // bewahrt
  });

  it('Guards: Ziel in der Quelle / identische Pfade → Fehler statt Endlos-Kopie', async () => {
    await expect(cloneOrFetch(repoFor(src), path.join(src, 'copy'))).rejects.toThrow(/inside the source/);
    await expect(cloneOrFetch(repoFor(src), src)).rejects.toThrow(/same directory/);
  });

  it('lokaler GIT-Ordner (mit .git) geht weiter über den Klon-Pfad, URLs sowieso', async () => {
    fs.mkdirSync(path.join(src, '.git'));
    let cloned = 0;
    const gitFactory = () => ({ clone: async () => { cloned++; }, fetch: async () => {} });
    const r = await cloneOrFetch(repoFor(src), dst, { gitFactory });
    expect(r.action).toBe('clone');
    expect(cloned).toBe(1);
  });
});
