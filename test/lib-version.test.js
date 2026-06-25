import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectVendoredLibraries } from '../src/sbom/vendored.js';

describe('T-74 Versionserkennung für vendored Libs', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libver-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'font-awesome.min.css'), '/*! Font Awesome 4.7.0 by @davegandy - http://fontawesome.io */ .fa{}');
    fs.writeFileSync(path.join(dir, 'lib', 'three.min.js'), "var THREE={};THREE.REVISION='150';function f(){}");
    fs.writeFileSync(path.join(dir, 'lib', 'mystery.min.js'), 'function noop(){ return 1; }');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('Font Awesome aus Header', () => {
    const libs = detectVendoredLibraries(dir);
    expect(libs.find((l) => l.name === 'font-awesome').version).toBe('4.7.0');
  });
  it('three REVISION → 0.<rev>.0', () => {
    const libs = detectVendoredLibraries(dir);
    expect(libs.find((l) => l.name === 'three').version).toBe('0.150.0');
  });
  it('ohne Versionsangabe bleibt unbekannt', () => {
    const libs = detectVendoredLibraries(dir);
    const m = libs.find((l) => l.name === 'mystery');
    expect(m.version).toBe('unbekannt');
  });
});
