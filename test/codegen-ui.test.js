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

  it('keine doppelten test()-Titel bei doppelten Events/Selektoren (Playwright lehnt sonst die Datei ab)', () => {
    // Analyse kann denselben Selektor/dasselbe Event mehrfach liefern → früher: doppelte Titel →
    // Playwright „duplicate test title" → 0 Szenarien → rote Baseline → Migration übersprungen.
    const dup = {
      functions: [],
      selectors: ['#t_TreeNav', '#t_TreeNav', '.box'],
      events: [
        { type: 'theme42layoutchanged', selector: '#t_TreeNav' },
        { type: 'theme42layoutchanged', selector: '#t_TreeNav' },
        { type: 'click', selector: '.box' },
      ],
    };
    const spec = buildPlaywrightSpec('Dup', dup);
    expect(parses(spec)).toBe(true);
    const titles = [...spec.matchAll(/test\((["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    expect(titles.length).toBe(new Set(titles).size); // alle Titel eindeutig
  });

  it('HTML-Fragmente werden nicht zu Selektor-Tests, gültige Selektoren bleiben (B-16)', () => {
    const deep2 = {
      functions: [],
      selectors: ['<span></span>', '<i></i>', '<div></div>', '#t_TreeNav', '.box'],
      events: [{ type: 'click', selector: '<span>' }, { type: 'click', selector: '#btn' }],
    };
    const spec = buildPlaywrightSpec('Frag', deep2);
    expect(parses(spec)).toBe(true);
    expect(spec).not.toMatch(/<span>|<i>|<div>/);       // keine HTML-Fragmente als locator
    expect(spec).toContain('#t_TreeNav');               // gültige Selektoren bleiben
    expect(spec).toContain('.box');
    expect(spec).toContain('#btn');
  });
});
