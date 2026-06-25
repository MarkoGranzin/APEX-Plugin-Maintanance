import { describe, it, expect } from 'vitest';
import { chooseTestEnv, ENV, FIXED } from '../src/test/testenv.js';
import { createApexShim, shimCovers, RuntimeRequiredError } from '../src/test/apexShim.js';

describe('T-22 Umgebungswahl', () => {
  it('jsdom-Pfad ohne Instanz für DOM-Widget (apex.item + DOM)', () => {
    const r = chooseTestEnv({ apexCalls: ['apex.item'], domAccess: ['document.getElementById'] });
    expect(r.env).toBe(ENV.JSDOM);
    expect(r.usesInstance).toBe(false);
  });

  it('Playwright-Pfad nur bei echter Runtime-Abhängigkeit (apex.server.process), Zeit/Seed fixiert', () => {
    const r = chooseTestEnv({ apexCalls: ['apex.server.process'] });
    expect(r.env).toBe(ENV.PLAYWRIGHT);
    expect(r.usesInstance).toBe(true);
    expect(r.fixed).toEqual(FIXED);
  });

  it('apex.*-Shim deckt Aufruf nicht ab → meldet Shim unvollständig, markiert B-Pfad', () => {
    const r = chooseTestEnv({ apexCalls: ['apex.theme.experimentalThing'] });
    expect(r.env).toBe(ENV.PLAYWRIGHT);
    expect(r.reason).toMatch(/Shim unvollständig/);
    expect(r.shimIncomplete).toContain('apex.theme.experimentalThing');
  });
});

describe('T-22 apex-Shim Verhalten', () => {
  it('item.getValue/setValue funktionieren ohne Instanz', () => {
    const apex = createApexShim({ items: { P1_X: 'a' } });
    expect(apex.item('P1_X').getValue()).toBe('a');
    apex.item('P1_X').setValue('b');
    expect(apex.item('P1_X').getValue()).toBe('b');
  });

  it('server.process wirft RuntimeRequiredError statt still zu mocken', () => {
    const apex = createApexShim();
    expect(() => apex.server.process('SAVE')).toThrow(RuntimeRequiredError);
  });

  it('shimCovers: gedeckte vs. ungedeckte vs. runtime Pfade', () => {
    expect(shimCovers('apex.item')).toBe(true);
    expect(shimCovers('apex.util.escapeHTML')).toBe(true);
    expect(shimCovers('apex.server.process')).toBe(false); // runtime
    expect(shimCovers('apex.nope.nada')).toBe(false); // nicht abgedeckt
  });
});
