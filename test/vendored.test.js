import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVendoredLibraries } from '../src/sbom/vendored.js';
import { scanRepo } from '../src/service/run-repo.js';
import { summarize } from '../src/service/run-component.js';
import { buildSbom } from '../src/sbom/sbom.js';

describe('T-68/T-69 Vendored-Lib-Erkennung, Unmaintained, SBOM', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vend-lib-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), '/*! jQuery v3.4.1 | (c) JS Foundation */\n!function(){return 1;}();');
    fs.writeFileSync(path.join(dir, 'lib', 'mxClient.js'), "var mx={}; mxClient.VERSION = '4.2.0'; function draw(){ return 1; }");
    fs.writeFileSync(path.join(dir, 'lib', 'jsonpath-0.8.0.min.js'), 'var j=1;');
    fs.writeFileSync(path.join(dir, 'js', 'script.min.js'), 'function own(){ return 2; }'); // eigener Code
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('erkennt jquery (Header), mxgraph (mxClient), jsonpath (Dateiname); eigener Code nicht', () => {
    const libs = detectVendoredLibraries(dir);
    const byName = Object.fromEntries(libs.map((l) => [l.name, l.version]));
    expect(byName.jquery).toBe('3.4.1');
    expect(byName.mxgraph).toBe('4.2.0');
    expect(byName.jsonpath).toBe('0.8.0');
    expect(libs.some((l) => /script/.test(l.name))).toBe(false);
  });

  it('three: REVISION-Anchor erkennt Version trotz dev-/Buchstaben-Suffix (T-90)', () => {
    const rf = { 'js/lib/three.js': "var x=1; const REVISION = '116dev'; function f(){return REVISION;}" };
    const libs = detectVendoredLibraries('/x', { files: ['js/lib/three.js'], readFile: (f) => rf[f] || '' });
    expect(libs.find((l) => l.name === 'three').version).toBe('0.116.0');
    // klassische Schreibweisen weiterhin
    expect(detectVendoredLibraries('/x', { files: ['three.min.js'], readFile: () => 'REVISION="160"' }).find((l) => l.name === 'three').version).toBe('0.160.0');
    expect(detectVendoredLibraries('/x', { files: ['three.js'], readFile: () => 'REVISION = r152,' }).find((l) => l.name === 'three').version).toBe('0.152.0');
    // kein Marker → unbekannt (kein Falschtreffer)
    expect(detectVendoredLibraries('/x', { files: ['three.js'], readFile: () => 'var REVISION = REVISION;' }).find((l) => l.name === 'three').version).toBe('unbekannt');
  });

  it('scanRepo: mxgraph nicht gepflegt, jquery verwundbar, libWarning gesetzt', () => {
    const r = scanRepo(dir);
    const byName = Object.fromEntries(r.libs.map((l) => [l.name, l]));
    expect(byName.mxgraph.status).toBe('nicht gepflegt');
    expect(byName.mxgraph.reason).toMatch(/mxGraph/);
    expect(byName.jquery.status).toBe('verwundbar');
    expect(r.libWarning.vulnerable).toBeGreaterThanOrEqual(1);
    expect(r.libWarning.unmaintained).toBeGreaterThanOrEqual(1);
  });

  it('SBOM nutzt der Review: Security-Findings im Protokoll + Status handlungsbedarf', () => {
    const r = scanRepo(dir);
    expect(r.log.some((e) => e.agent === 'Security' && /verwundbar/.test(e.result))).toBe(true);
    expect(r.log.some((e) => e.agent === 'Security' && /nicht gepflegt/.test(e.result))).toBe(true);
    expect(summarize(r).status).toBe('handlungsbedarf');
  });

  it('buildSbom liefert CycloneDX mit allen Komponenten', () => {
    const r = scanRepo(dir);
    const sbom = buildSbom('Plugin', r.libs);
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.components.length).toBe(r.libs.length);
  });
});
