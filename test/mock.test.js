import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMockPage, buildMockSpec, generateMock, writeMock, generateAiMock, aiMockPrompt, collectMock } from '../src/test/mock.js';

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

    it('aiMockPrompt enthält Analyse, Lib-/Datei-Pfade und window.__ok-Vertrag (T-101)', () => {
      const c = collectMock(dir);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/three\.js/);            // Lib-Pfad
      expect(p).toMatch(/plugin\//);             // Plugin-Dateipfad
      expect(p).toMatch(/window\.__ok/);          // Vertrag
      expect(p).toMatch(/apex/i);                 // Shim-Anforderung
    });

    it('generateAiMock: KI schreibt den Mock (mode=ai)', async () => {
      let asked = '';
      const ai = { kind: 'cli', complete: async (prompt) => { asked = prompt; return '```html\n<html><body><div id="mock-root"></div><script>window.__ok=true;</script></body></html>\n```'; } };
      const gen = await generateAiMock(dir, { ai, name: 'Widget' });
      expect(gen.mode).toBe('ai');
      expect(gen.html).toMatch(/<html>/);
      expect(gen.html).not.toMatch(/```/); // Markdown-Zaun entfernt
      expect(asked).toMatch(/senior test engineer/i);
    });

    it('generateAiMock: ohne KI → statischer Fallback mit Grund', async () => {
      const gen = await generateAiMock(dir, { ai: { kind: 'stub' }, name: 'Widget' });
      expect(gen.mode).toBe('static');
      expect(gen.fallbackReason).toMatch(/no AI backend/i);
    });

    it('generateAiMock: unbrauchbare KI-Antwort → Fallback mit klarem Grund', async () => {
      const gen = await generateAiMock(dir, { ai: { kind: 'cli', complete: async () => 'sorry, I cannot' }, name: 'Widget' });
      expect(gen.mode).toBe('static');
      expect(gen.fallbackReason).toMatch(/not an HTML|missing|empty/i);
    });

    it('generateAiMock: KI-Fehler → Fallback meldet den Fehler', async () => {
      const gen = await generateAiMock(dir, { ai: { kind: 'cli', complete: async () => { throw new Error('spawn claude ENOENT'); } }, name: 'Widget' });
      expect(gen.mode).toBe('static');
      expect(gen.fallbackReason).toMatch(/AI error.*ENOENT/);
    });
  });
});
