import { describe, it, expect } from 'vitest';
import { analyzeJs, memberPath } from '../src/extract/analyze.js';

describe('T-21 apex.*-Aufrufe mit vollem Pfad', () => {
  it('erkennt apex.server.process und apex.item unabhängig vom Stil', () => {
    const code = `
      (function () {
        apex.server.process('SAVE', { x: 1 }, { success: function(d){} });
        var v = apex.item('P1_NAME').getValue();
      })();
    `;
    const r = analyzeJs(code);
    expect(r.ok).toBe(true);
    expect(r.apexCalls).toContain('apex.server.process');
    expect(r.apexCalls).toContain('apex.item');
    expect(r.ajaxCalls).toContain('apex.server.process');
  });
});

describe('T-21 Einstiegspunkte trotz uneinheitlichem Stil', () => {
  it('findet Modul-Pattern-Methoden, globale Funktionen und window-Zuweisungen', () => {
    const code = `
      function legacyInit() {}
      var widget = (function () {
        return { init: function () {}, refresh: () => {} };
      })();
      window.myPlugin = function () {};
    `;
    const r = analyzeJs(code);
    expect(r.entryPoints).toEqual(expect.arrayContaining(['legacyInit', 'init', 'refresh', 'window.myPlugin']));
  });
});

describe('T-21 jQuery/$ und AJAX', () => {
  it('erkennt $.ajax, apex.jQuery und $-Selektor-Aufrufe', () => {
    const code = `
      $.ajax({ url: '/x' });
      apex.jQuery('#id').on('click', function(){});
      $('.foo').show();
    `;
    const r = analyzeJs(code);
    expect(r.jqueryCalls).toEqual(expect.arrayContaining(['$.ajax', 'apex.jQuery', '$']));
    expect(r.ajaxCalls).toContain('$.ajax');
  });
});

describe('T-21 DOM-Zugriffe', () => {
  it('erkennt document.* Zugriffe', () => {
    const code = `var el = document.getElementById('x'); document.querySelectorAll('.y');`;
    const r = analyzeJs(code);
    expect(r.domAccess).toEqual(expect.arrayContaining(['document.getElementById', 'document.querySelectorAll']));
  });
});

describe('T-21 Robustheit', () => {
  it('Syntaxfehler bricht nicht, sondern meldet Parse-Fehler', () => {
    const r = analyzeJs('function ( {');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Parse-Fehler/);
  });

  it('memberPath baut gepunkteten Pfad', () => {
    const r = analyzeJs('apex.server.process();');
    expect(r.apexCalls[0]).toBe('apex.server.process');
  });
});
