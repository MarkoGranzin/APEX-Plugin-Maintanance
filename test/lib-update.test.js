import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyUpdate, applyVendoredUpdates, rollbackUpdates } from '../src/service/lib-update.js';

describe('T-79 classifyUpdate', () => {
  it('safe = gleiche Major', () => { expect(classifyUpdate('1.2.3', '1.5.0')).toBe('safe'); });
  it('breaking = Major-Sprung', () => {
    expect(classifyUpdate('1.2.3', '2.0.0')).toBe('breaking');
    expect(classifyUpdate('0.8.0', '1.3.0')).toBe('breaking');
  });
  it('none = gleich/kleiner/unbekannt', () => {
    expect(classifyUpdate('1.5.0', '1.5.0')).toBe('none');
    expect(classifyUpdate('unbekannt', '1.0.0')).toBe('none');
  });
  it('0.x: Minor ist die Breaking-Stelle (T-90)', () => {
    expect(classifyUpdate('0.116.0', '0.185.0')).toBe('breaking'); // three: nicht blind tauschen → Re-Dev
    expect(classifyUpdate('0.116.0', '0.116.5')).toBe('safe');     // gleicher Minor → Patch ist safe
  });
});

describe('T-79 applyVendoredUpdates', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libupd-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), '/*! jQuery v1.2.3 */ var old=1;');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sicheres Update tauscht die Datei + Rollback stellt wieder her', async () => {
    const fetchFile = async (pkg, ver) => { expect(pkg).toBe('jquery'); return `/*! jQuery v${ver} */ var neu=2;`; };
    const r = await applyVendoredUpdates(dir, [{ name: 'jquery', version: '1.2.3', outdated: true, latest: '1.5.0' }], { fetchFile });
    expect(r.results[0].applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toMatch(/v1\.5\.0/);
    rollbackUpdates(r.backups);
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toMatch(/v1\.2\.3/);
  });

  it('breaking wird NICHT getauscht (ohne force), nur markiert', async () => {
    const fetchFile = async () => 'should-not-be-written';
    const r = await applyVendoredUpdates(dir, [{ name: 'jquery', version: '1.2.3', outdated: true, latest: '4.0.0' }], { fetchFile });
    expect(r.results[0]).toMatchObject({ applied: false, breaking: true });
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toMatch(/v1\.2\.3/); // unverändert
  });

  it('breaking MIT force (KI-Migration der Software) tauscht doch', async () => {
    const fetchFile = async (pkg, ver) => `/*! jQuery v${ver} */`;
    const r = await applyVendoredUpdates(dir, [{ name: 'jquery', version: '1.2.3', outdated: true, latest: '4.0.0' }], { fetchFile, force: true });
    expect(r.results[0]).toMatchObject({ applied: true, breaking: true });
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toMatch(/v4\.0\.0/);
  });

  it('Version im Dateinamen → Datei wird umbenannt + Referenzen mitgezogen (sonst „Dauer-veraltet")', async () => {
    // Lib mit Version im Namen + eine HTML, die sie literal referenziert.
    fs.writeFileSync(path.join(dir, 'lib', 'lz-string-1.0.2.js'), 'var LZString=1;');
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="lib/lz-string-1.0.2.js"></script>');
    const fetchFile = async () => 'var LZString=2;/*neu*/';
    const r = await applyVendoredUpdates(dir, [{ name: 'lz-string', version: '1.0.2', outdated: true, latest: '1.5.0' }], { fetchFile });
    expect(r.results[0]).toMatchObject({ applied: true, renamedTo: 'lz-string-1.5.0.js', refsUpdated: 1 });
    // alte Datei weg, neue da mit neuem Inhalt
    expect(fs.existsSync(path.join(dir, 'lib', 'lz-string-1.0.2.js'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib', 'lz-string-1.5.0.js'), 'utf8')).toMatch(/neu/);
    // Referenz umgezogen
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('lz-string-1.5.0.js');
    // Rollback: alte Datei zurück, neue weg, Referenz zurück
    rollbackUpdates(r.backups);
    expect(fs.existsSync(path.join(dir, 'lib', 'lz-string-1.5.0.js'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib', 'lz-string-1.0.2.js'), 'utf8')).toBe('var LZString=1;');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('lz-string-1.0.2.js');
  });
});

describe('B-24 Re-Dev: Lib-Tausch funktioniert auch OHNE durchgereichtes fetchFile (Fallback greift)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisp-b24-')); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } });

  it('breaking Lib (jquery 1.12.4 → 4.0.0) wird mit force=true getauscht, obwohl deps.fetchFile fehlt', async () => {
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), '/*! jQuery v1.12.4 */ var OLD=1;');
    const libs = [{ name: 'jquery', version: '1.12.4', latest: '4.0.0', outdated: true }];
    // Wie im Re-Dev-Pfad (redev.js:110): KEIN fetchFile — nur ein fake fetch (Fallback: defaultFetchFile nutzt deps.fetch).
    let fetched = null;
    const fetch = async (url) => { fetched = url; return { ok: true, status: 200, text: async () => '/*! jQuery v4.0.0 */ var NEW=1;' }; };
    const { results } = await applyVendoredUpdates(dir, libs, { force: true, fetch });
    expect(results[0]).toMatchObject({ name: 'jquery', applied: true });
    expect(fetched).toContain('jquery@4.0.0'); // wirklich geladen (Fallback → CDN-URL)
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toContain('v4.0.0'); // real getauscht
  });

  it('ohne force bleibt breaking ungetauscht (gemeldet) — Sicherheits-Gate unverändert', async () => {
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'var OLD=1;');
    const libs = [{ name: 'jquery', version: '1.12.4', latest: '4.0.0', outdated: true }];
    const { results } = await applyVendoredUpdates(dir, libs, { fetch: async () => ({ ok: true, text: async () => 'NEW' }) });
    expect(results[0]).toMatchObject({ applied: false, breaking: true });
  });
});
