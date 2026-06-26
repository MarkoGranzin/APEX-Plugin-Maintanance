import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMockPage, buildMockSpec, generateMock, writeMock } from '../src/test/mock.js';

describe('F-28 T-97 Auto-Mock', () => {
  it('buildMockPage: self-contained HTML mit Shim, Libs (src), Plugin-Dateien (src), DOM, Entry-Calls', () => {
    const html = buildMockPage({ name: 'P', libFiles: ['three.js'], pluginFiles: ['plugin/widget.js'], selectors: ['#bg', '.box'], entryPoints: ['initPlugin'] });
    expect(html).toMatch(/<script src="three\.js">/);
    expect(html).toMatch(/<script src="plugin\/widget\.js">/); // Plugin-Code extern, nicht inline
    expect(html).toMatch(/window\.apex/);
    expect(html).toMatch(/id="bg"/);
    expect(html).toMatch(/class="box"/);
    expect(html).toMatch(/initPlugin\(\)/);
    expect(html).toMatch(/window\.__ok/);
  });

  it('buildMockSpec prüft window.__ok + Mount sichtbar', () => {
    const s = buildMockSpec('P');
    expect(s).toMatch(/#mock-root/);
    expect(s).toMatch(/__ok === true/);
    expect(s).toMatch(/@playwright\/test/);
  });

  describe('generateMock + writeMock am Fixture-Repo', () => {
    let dir, mockDir;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
      fs.mkdirSync(path.join(dir, 'js', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'js', 'lib', 'three.js'), "var THREE={REVISION:'160'};");
      fs.writeFileSync(path.join(dir, 'js', 'widget.js'), "function initWidget(){ document.querySelector('#vanta'); }");
      mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockout-'));
    });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(mockDir, { recursive: true, force: true }); });

    it('generateMock sammelt Libs + Plugin-Dateien + erzeugt Spec', () => {
      const gen = generateMock(dir, { name: 'Widget' });
      expect(gen.libFiles.some((f) => /three\.js$/.test(f))).toBe(true);
      expect(gen.pluginFiles.some((p) => /widget\.js$/.test(p.name) && /initWidget/.test(p.code))).toBe(true); // Plugin-Code als Datei
      expect(gen.pluginFiles.some((p) => /three/.test(p.name))).toBe(false); // Lib NICHT als Plugin-Datei
      expect(gen.spec.content).toMatch(/__ok/);
    });

    it('writeMock legt index.html + Lib- + Plugin-Dateien ab', () => {
      const gen = generateMock(dir, { name: 'Widget' });
      const idx = writeMock(mockDir, dir, gen);
      expect(fs.existsSync(idx)).toBe(true);
      expect(fs.existsSync(path.join(mockDir, gen.libFiles[0]))).toBe(true);
      expect(fs.existsSync(path.join(mockDir, gen.pluginFiles[0].name))).toBe(true);
      expect(fs.readFileSync(idx, 'utf8')).toMatch(/<script src=/);
    });
  });
});
