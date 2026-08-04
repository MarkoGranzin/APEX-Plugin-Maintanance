import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVendoredLibraries } from '../src/sbom/vendored.js';
import { detectArtifacts, libRootDir } from '../src/inventory/inventory.js';
import { analyzeJs } from '../src/extract/analyze.js';

// B-71/B-72/B-73 — Leaflet-Fall: vendorter KOMPLETT-Checkout unter js/lib/<name>/ (Datei-Import ohne Git).

const LEAFLET_MIN = '/* @preserve\n * Leaflet 1.7.1, a JS library for interactive maps. http://leafletjs.com\n */\n!function(t){var sub={version:"1.1.1"};}();';
const LEAFLET_SRC = '/* @preserve\n * Leaflet 1.6.0, a JS library for interactive maps.\n */\nvar version = "1.6.0";';

const FILES = [
  'js/script.js', 'js/script.min.js', 'css/style.css', 'data/data.js',
  'js/lib/leaflet/leaflet.js', 'js/lib/leaflet/leaflet-src.js', 'js/lib/leaflet/leaflet-src.esm.js', 'js/lib/leaflet/leaflet.css',
  'js/lib/Leaflet.markercluster-master/dist/leaflet.markercluster.js',
  'js/lib/Leaflet.markercluster-master/src/MarkerCluster.js',
  'js/lib/Leaflet.markercluster-master/spec/suites/AddLayerSpec.js',
  'js/lib/Leaflet.markercluster-master/build/rollup-config.js',
  'js/lib/Leaflet.markercluster-master/Jakefile.js',
];
const READ = {
  'js/lib/leaflet/leaflet.js': LEAFLET_MIN,
  'js/lib/leaflet/leaflet-src.js': LEAFLET_SRC,
  'js/lib/leaflet/leaflet-src.esm.js': LEAFLET_SRC,
  'js/lib/Leaflet.markercluster-master/package.json': '{ "name": "leaflet.markercluster", "version": "1.4.1" }',
  'js/lib/Leaflet.markercluster-master/dist/leaflet.markercluster.js': '/* Leaflet.markercluster */ var x=1;',
};
const deps = { files: FILES, readFile: (f) => READ[f] ?? '' };

describe('B-71: Lib-Checkout-Ordner → EINE Lib, kein Fake-Müll', () => {
  it('Leaflet-Fall: genau leaflet@1.7.1 + leaflet.markercluster@1.4.1', () => {
    const libs = detectVendoredLibraries('/repo', deps);
    const byName = Object.fromEntries(libs.map((l) => [l.name, l.version]));
    expect(byName).toEqual({ leaflet: '1.7.1', 'leaflet.markercluster': '1.4.1' });
    // kanonische Auslieferungsdatei gewinnt gegen -src (1.6.0) und gegen das Sub-Objekt version:"1.1.1"
    expect(libs.find((l) => l.name === 'leaflet').evidence).toBe('js/lib/leaflet/leaflet.js');
  });

  it('Spec/Test/Build/Doku/Konfig-Dateien erzeugen NIE Lib-Einträge', () => {
    const libs = detectVendoredLibraries('/repo', deps);
    for (const bad of ['addlayerspec', 'rollup', 'jakefile', 'markercluster-master', 'src']) {
      expect(libs.some((l) => l.name.includes(bad)), `kein Eintrag für ${bad}`).toBe(false);
    }
    expect(libs).toHaveLength(2);
  });

  it('dist/ ist für die Lib-Erkennung sichtbar (echtes FS), obwohl Artefakt-Erkennung es ignoriert', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b71-dist-'));
    fs.mkdirSync(path.join(dir, 'lib', 'mylib', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'mylib', 'dist', 'mylib.js'), '/*! mylib v2.3.4 */ var m=1;');
    const libs = detectVendoredLibraries(dir);
    expect(libs.find((l) => l.name === 'mylib')?.version).toBe('2.3.4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Einzeldateien in flachem lib/ behalten das bisherige Verhalten (inkl. KI-Fallback bei unbekannt)', () => {
    const libs = detectVendoredLibraries('/repo', { files: ['lib/obscure.js'], readFile: () => 'var x=1; // no version anywhere' });
    const o = libs.find((l) => l.name === 'obscure');
    expect(o?.version).toBe('unbekannt');
    expect(o?.evidenceHead).toBeTruthy(); // T-146-KI-Fallback bleibt erhalten
  });
});

describe('B-71 Review-Befunde: Gruppierung darf keine Libs verschlucken', () => {
  it('F1: Organisations-Ordner (lib/js/) sind KEINE Checkouts — beide Libs bleiben sichtbar', () => {
    const rf = {
      'lib/js/lodash.min.js': '/*! lodash 4.17.21 */ var _=1;',
      'lib/js/moment.min.js': '/*! moment 2.29.1 */ var m=1;',
    };
    const libs = detectVendoredLibraries('/r', { files: Object.keys(rf), readFile: (f) => rf[f] || '' });
    const byName = Object.fromEntries(libs.map((l) => [l.name, l.version]));
    expect(byName.lodash).toBe('4.17.21');
    expect(byName.moment).toBe('2.29.1'); // vorher vom Gruppen-Bug verschluckt
  });

  it('F2: KNOWN-Datei mit fremdem Namen im Checkout → BEIDE Libs, kein Versions-Hijack', () => {
    const rf = {
      'lib/vanta-master/dist/vanta.waves.min.js': '/* vanta */ var v=1;',
      'lib/vanta-master/deps/jquery.min.js': '/*! jQuery v3.6.0 | (c) */ var $=1;',
      'lib/vanta-master/package.json': '{ "version": "0.5.24" }',
    };
    const libs = detectVendoredLibraries('/r', { files: Object.keys(rf).filter((f) => f.endsWith('.js')), readFile: (f) => rf[f] || '' });
    const byName = Object.fromEntries(libs.map((l) => [l.name, l.version]));
    expect(byName.vanta).toBe('0.5.24');  // Checkout behält Ordnernamen + eigene package.json
    expect(byName.jquery).toBe('3.6.0');  // KNOWN-Datei bleibt eigene Lib mit EIGENER Version
  });

  it('F3: build/-Auslieferung (three-Checkout) bleibt sichtbar → Version via REVISION-Anker', () => {
    const rf = {
      'lib/three.js-master/build/three.min.js': 'var REVISION="150"; var t=1;',
      'lib/three.js-master/src/Three.js': 'export const x=1;',
    };
    const libs = detectVendoredLibraries('/r', { files: Object.keys(rf), readFile: (f) => rf[f] || '' });
    expect(libs.find((l) => l.name === 'three')?.version).toBe('0.150.0');
  });

  it('F4: Top-Level dist/ (eigener Plugin-Build) erzeugt KEINE Fake-Libs', () => {
    const rf = { 'dist/color-palette.bundle.js': 'var b=1;', 'dist/helper.js': 'var h=1;' };
    const libs = detectVendoredLibraries('/r', { files: Object.keys(rf), readFile: (f) => rf[f] || '' });
    expect(libs).toHaveLength(0);
  });

  it('F5: Checkout-Pfad wird index-robust bestimmt (package.json am richtigen Ort gelesen)', () => {
    const reads = [];
    const rf = { 'libs/mylib/mylib.js': 'var m=1;', 'libs/mylib/package.json': '{ "version": "2.0.0" }' };
    const libs = detectVendoredLibraries('/r', { files: ['libs/mylib/mylib.js'], readFile: (f) => { reads.push(f); return rf[f] || ''; } });
    expect(libs.find((l) => l.name === 'mylib')?.version).toBe('2.0.0');
    expect(reads).toContain('libs/mylib/package.json'); // nicht ein falsch geschnittener Pfad
  });
});

describe('B-72: Artefakt-Erkennung bündelt Lib-Checkouts', () => {
  it('lib-Unterordner werden EIN Artefakt am Lib-Wurzelverzeichnis, Eigen-Code bleibt je Ordner', () => {
    const arts = detectArtifacts('/repo', { files: FILES, readFile: () => '' });
    const names = arts.map((a) => a.name).sort();
    expect(names).toContain('lib');           // js/lib/** gebündelt
    expect(names).not.toContain('leaflet');   // kein Unterordner-Artefakt
    expect(names).not.toContain('Leaflet.markercluster-master');
    expect(names).not.toContain('src');
    expect(names).toContain('js');            // eigener Code weiterhin eigenes Artefakt
    expect(names).toContain('css');
    const lib = arts.find((a) => a.name === 'lib');
    expect(lib.files).toContain('js/lib/leaflet/leaflet.js');
    expect(lib.files).toContain('js/lib/Leaflet.markercluster-master/src/MarkerCluster.js');
  });

  it('flaches lib/ bleibt unverändert „lib" (keine Bestands-Regression)', () => {
    const arts = detectArtifacts('/repo', { files: ['lib/jquery.min.js', 'lib/mxClient.js', 'js/script.js'], readFile: () => '' });
    const lib = arts.find((a) => a.name === 'lib');
    expect(lib).toBeTruthy();
    expect(lib.files.sort()).toEqual(['lib/jquery.min.js', 'lib/mxClient.js']);
  });

  it('libRootDir: greift nur auf echte lib-Segmente, nicht auf „library/"', () => {
    expect(libRootDir('js/lib/leaflet/leaflet.js')).toBe('js/lib');
    expect(libRootDir('lib/jquery.min.js')).toBe('lib');
    expect(libRootDir('library/foo.js')).toBeNull();
    expect(libRootDir('js/app.js')).toBeNull();
  });
});

describe('B-73: ESM-Dateien parsen statt Fehlbefund', () => {
  it('import/export → sourceType-Retry liefert ok + Analyse', () => {
    const r = analyzeJs('import {x} from "./m.js";\nexport function initMap(){ return x; }');
    expect(r.ok).toBe(true);
    expect(r.entryPoints).toContain('initMap');
  });

  it('echte Syntaxfehler bleiben Parse-Fehler', () => {
    const r = analyzeJs('import {x from "./m.js"; function (');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Parse error/);
  });

  it('F6: import.meta (ohne import/export) wird ebenfalls als Modul nachgeparst', () => {
    const r = analyzeJs('const u = import.meta.url; function boot(){ return u; }');
    expect(r.ok).toBe(true);
  });
});
