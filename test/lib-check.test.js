import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraryFiles, checkLibrariesOnline } from '../src/service/lib-check.js';
import { npmPackageName, normalizeRepoUrl, versionAtDate, npmNameCandidates } from '../src/sbom/registry.js';

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

  it('T-146 versionAtDate: waehlt die zuletzt vor/am Referenzdatum stabile Version', () => {
    const time = { '1.0.0': '2020-01-01T00:00:00Z', '2.0.0': '2022-06-01T00:00:00Z', '2.1.0': '2023-09-01T00:00:00Z', '3.0.0-beta': '2024-01-01T00:00:00Z', '3.0.0': '2025-01-01T00:00:00Z', created: '2019-01-01', modified: '2025-02-01' };
    expect(versionAtDate(time, '2023-03-01')).toBe('2.0.0'); // 2.1.0 noch nicht erschienen
    expect(versionAtDate(time, '2024-06-01')).toBe('2.1.0'); // 3.0.0-beta (Pre-Release) ignoriert
    expect(versionAtDate(time, '2025-06-01')).toBe('3.0.0');
    expect(versionAtDate(time, '2019-01-01')).toBe(null);    // nichts vor dem Datum
  });

  it('T-146 checkLibrariesOnline: unbekannte Version wird aus dem Bau-Zeitpunkt der Geschwister-Libs abgeleitet', async () => {
    const infos = {
      d3: { name: 'd3', latest: '7.9.0', releasedAt: '2024-01-01T00:00:00Z', time: { '7.8.5': '2023-06-01T00:00:00Z', '7.9.0': '2024-01-01T00:00:00Z' }, links: {} },
      pell: { name: 'pell', latest: '1.0.6', releasedAt: '2019-01-01T00:00:00Z', time: { '1.0.0': '2018-01-01T00:00:00Z', '1.0.4': '2023-05-01T00:00:00Z', '1.0.6': '2024-08-01T00:00:00Z' }, links: {} },
    };
    const libs = [ { name: 'd3', version: '7.8.5' }, { name: 'pell', version: 'unbekannt' } ];
    const out = await checkLibrariesOnline(libs, { fetchInfo: async (n) => infos[n], now: () => Date.parse('2025-01-01') });
    const pell = out.find((l) => l.name === 'pell');
    // Referenzdatum = juengstes bekanntes Release (d3 7.8.5 = 2023-06-01) -> pell-Version zu diesem Zeitpunkt = 1.0.4
    expect(pell.version).toBe('1.0.4');
    expect(pell.versionInferred).toBe(true);
    expect(pell.detectedBy).toBe('inferred-by-date');
  });

  it('T-146 npm-Namens-Zuordnung: Buendel-Dateinamen -> echtes Paket (generisch + Alias)', () => {
    expect(npmPackageName('masonry.pkgd')).toBe('masonry-layout'); // .pkgd-Suffix generisch weg + Alias
    expect(npmPackageName('nbillboard')).toBe('billboard.js');
    expect(npmPackageName('maptopojson')).toBe('topojson');
    expect(npmPackageName('purify')).toBe('dompurify');
    expect(npmPackageName('foo.bundle.min')).toBe('foo'); // rein generische Normalisierung
    expect(npmNameCandidates('nbillboard')).toContain('billboard'); // Praefix-Fallback als Kandidat
  });
});
