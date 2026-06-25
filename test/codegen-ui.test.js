import { describe, it, expect } from 'vitest';
import * as acorn from 'acorn';
import { analyzeDeep } from '../src/test/analyze-deep.js';
import { buildPlaywrightSpec, buildJsdomUnit, generateCodedTests } from '../src/test/codegen-ui.js';

const parses = (code) => { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); return true; };

describe('T-64 Coded-UI- & Unit-Generierung', () => {
  const deep = analyzeDeep("function init(opts){ if(opts){} $('#btn').on('click', function(){}); }");

  it('Playwright-Spec klickt #btn und prüft auf Fehler', () => {
    const spec = buildPlaywrightSpec('Widget', deep);
    expect(spec).toMatch(/@playwright\/test/);
    expect(spec).toContain('#btn');
    expect(spec).toMatch(/\.click\(\)/);
    expect(spec).toMatch(/pageerror/);
  });

  it('jsdom-Unit-Skeleton ruft Funktion mit apex-Shim', () => {
    const unit = buildJsdomUnit('Widget', deep);
    expect(unit).toMatch(/installApexShim/);
    expect(unit).toMatch(/init\(opts\)/);
    expect(unit).toMatch(/Negativ/);
  });

  it('generierte Dateien sind syntaktisch gültiges JavaScript', () => {
    const { files } = generateCodedTests('Widget', deep);
    expect(files).toHaveLength(2);
    for (const f of files) expect(parses(f.content)).toBe(true);
  });

  it('robust ohne Funktionen/Events', () => {
    const { files } = generateCodedTests('Leer', { functions: [], events: [], selectors: [] });
    for (const f of files) expect(parses(f.content)).toBe(true);
  });
});
