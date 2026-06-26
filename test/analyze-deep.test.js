import { describe, it, expect } from 'vitest';
import { analyzeDeep } from '../src/test/analyze-deep.js';

describe('T-62 Tiefen-Analyzer', () => {
  it('erfasst Funktionen samt Parametern', () => {
    const r = analyzeDeep('function init(opts, cb){ return opts; }');
    const init = r.functions.find((f) => f.name === 'init');
    expect(init).toBeTruthy();
    expect(init.params).toEqual(['opts', 'cb']);
  });

  it('zählt Verzweigungen und Fehlerpfade', () => {
    const code = 'function f(x){ if(x){ for(var i=0;i<3;i++){} } else { throw new Error("no"); } }';
    const f = analyzeDeep(code).functions.find((x) => x.name === 'f');
    expect(f.branches).toBeGreaterThanOrEqual(2); // if + for
    expect(f.throws).toBe(1);
  });

  it('erkennt Events mit Selektor und DOM-Operationen', () => {
    const code = "function bind(){ $('#btn').on('click', function(){ document.getElementById('out').innerHTML='x'; }); }";
    const r = analyzeDeep(code);
    expect(r.events.some((e) => e.type === 'click' && e.selector === '#btn')).toBe(true);
    const bind = r.functions.find((f) => f.name === 'bind');
    expect(bind.domOps).toContain('innerHTML');
    expect(r.selectors).toContain('#btn');
  });

  it('erfasst apex.*-Aufrufe', () => {
    const f = analyzeDeep('function g(){ apex.item("P1").setValue(1); }').functions.find((x) => x.name === 'g');
    expect(f.apexCalls.some((p) => p.startsWith('apex.'))).toBe(true);
  });

  it('Parsefehler → ok:false ohne Absturz', () => {
    const r = analyzeDeep('function ( {');
    expect(r.ok).toBe(false);
    expect(r.functions).toEqual([]);
  });

  it('$("<span>") ist Element-Erzeugung, kein Selektor (B-16)', () => {
    const r = analyzeDeep("function make(){ var el = $('<span></span>'); $('#real').append(el); }");
    expect(r.selectors).not.toContain('<span></span>');   // HTML-Fragment NICHT als Selektor
    expect(r.selectors).toContain('#real');               // echter Selektor schon
  });
});
