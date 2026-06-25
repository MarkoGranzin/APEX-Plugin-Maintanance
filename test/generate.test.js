import { describe, it, expect } from 'vitest';
import { stubBackend } from '../src/ai/backend.js';
import { generateInitialSuite, generateDeltaTests, extractTestTitles } from '../src/ai/generate.js';
import * as acorn from 'acorn';

const bundle = { artifact: 'slider', js: [{ name: 'slider.js', code: 'function init(){} function refresh(){}' }], css: [] };
const analysis = { entryPoints: ['init', 'refresh'], apexCalls: ['apex.item'] };

describe('T-4 Initiale KI-Testsuite', () => {
  it('generiert lauffähigen, parsebaren Test im definierten Ordner', async () => {
    const suite = await generateInitialSuite(bundle, analysis, { ai: stubBackend() });
    expect(suite.path).toBe('generated-tests/slider.spec.js');
    expect(() => acorn.parse(suite.code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(suite.titles).toEqual(['init funktioniert', 'refresh funktioniert']);
  });

  it('wirft bei nicht-parsebarem KI-Output (kein stiller Müll)', async () => {
    const broken = stubBackend({ respond: () => 'function ( {' });
    await expect(generateInitialSuite(bundle, analysis, { ai: broken })).rejects.toThrow(/nicht parsebar/);
  });
});

describe('T-5 Delta-Tests ohne Duplikate', () => {
  it('fügt nur Tests für neue Ziele hinzu, überspringt bestehende', async () => {
    const initial = await generateInitialSuite(bundle, analysis, { ai: stubBackend() });
    // Delta betrifft 'refresh' (existiert) und 'zoom' (neu)
    const delta = await generateDeltaTests(
      bundle,
      analysis,
      ['refresh', 'zoom'],
      initial,
      { ai: stubBackend() },
    );
    expect(delta.added).toEqual([{ title: 'zoom funktioniert' }]);
    expect(delta.skipped).toContain('refresh funktioniert');
  });

  it('kein neuer Test → code null', async () => {
    const initial = await generateInitialSuite(bundle, analysis, { ai: stubBackend() });
    const delta = await generateDeltaTests(bundle, analysis, ['init'], initial, { ai: stubBackend() });
    expect(delta.added).toHaveLength(0);
    expect(delta.code).toBeNull();
  });

  it('extractTestTitles liest it/test-Titel', () => {
    expect(extractTestTitles("it('a',()=>{}); test('b',()=>{})")).toEqual(['a', 'b']);
  });
});
