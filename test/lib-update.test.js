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
});
