import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraryFiles, checkLibrariesOnline } from '../src/service/lib-check.js';
import { npmPackageName, normalizeRepoUrl } from '../src/sbom/registry.js';

describe('T-59 Bibliotheks-Erkennung + Web-Lookup', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libchk-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'x');
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), 'function f(){}');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('erkennt Bibliotheks-Dateien, nicht den eigenen Code', () => {
    const files = libraryFiles(dir);
    expect(files).toContain('lib/jquery.min.js');
    expect(files).not.toContain('js/widget.js');
  });

  it('liefert neueste Version, Release-Datum und Alter aus dem Web', async () => {
    const now = () => Date.parse('2026-06-24T00:00:00Z');
    const fetchInfo = async () => ({
      name: 'jquery',
      latest: '3.7.1',
      releasedAt: '2023-08-28T00:00:00Z',
      time: { '3.4.1': '2019-05-01T00:00:00Z', '3.7.1': '2023-08-28T00:00:00Z' },
    });
    const [e] = await checkLibrariesOnline([{ name: 'jquery', version: '3.4.1' }], { fetchInfo, now });
    expect(e.latest).toBe('3.7.1');
    expect(e.releasedAt).toBe('2023-08-28T00:00:00Z');
    expect(e.ageDays).toBeGreaterThan(900);
    expect(e.installedAgeDays).toBeGreaterThan(2500); // 3.4.1 ist alt
  });

  it('markiert outdated, wenn installierte Version < neueste', async () => {
    const fetchInfo = async () => ({ name: 'jquery', latest: '3.7.1', releasedAt: '2023-08-28T00:00:00Z', time: {} });
    const [e] = await checkLibrariesOnline([{ name: 'jquery', version: '3.4.1' }], { fetchInfo });
    expect(e.outdated).toBe(true);
    expect(e.webStatus).toBe('veraltet');
  });

  it('Netzfehler bricht nicht ab → Status unbekannt', async () => {
    const fetchInfo = async () => { throw new Error('ENOTFOUND'); };
    const [e] = await checkLibrariesOnline([{ name: 'jquery', version: '3.4.1' }], { fetchInfo });
    expect(e.webStatus).toBe('unbekannt');
    expect(e.webError).toMatch(/ENOTFOUND/);
    expect(e.name).toBe('jquery'); // Lib bleibt erhalten
  });

  it('liefert Quelle-Link (GitHub) und npm-Seite', async () => {
    const fetchInfo = async () => ({ latest: '3.7.1', releasedAt: '2023-08-28T00:00:00Z', time: {}, links: { source: 'https://github.com/jquery/jquery', homepage: 'https://jquery.com', npm: 'https://www.npmjs.com/package/jquery' } });
    const [e] = await checkLibrariesOnline([{ name: 'jquery', version: '3.4.1' }], { fetchInfo });
    expect(e.source).toBe('https://github.com/jquery/jquery');
    expect(e.npm).toMatch(/npmjs\.com/);
  });

  it('normalisiert git-Repository-URLs auf HTTPS', () => {
    expect(normalizeRepoUrl({ type: 'git', url: 'git+https://github.com/jquery/jquery.git' })).toBe('https://github.com/jquery/jquery');
    expect(normalizeRepoUrl('git@github.com:foo/bar.git')).toBe('https://github.com/foo/bar');
    expect(normalizeRepoUrl(null)).toBe(null);
  });

  it('mappt Lib-Namen auf npm-Pakete', () => {
    expect(npmPackageName('chart')).toBe('chart.js');
    expect(npmPackageName('AngularJS')).toBe('angular');
    expect(npmPackageName('jquery')).toBe('jquery');
  });
});
