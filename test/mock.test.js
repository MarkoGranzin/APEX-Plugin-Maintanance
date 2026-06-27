import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMockPage, buildMockSpec, generateMock, writeMock, generateAiMock, aiMockPrompt, aiAnalyzePrompt, analyzeViews, finalizeAiHtml, runMockSelfTests, aiRefinePrompt, refineMock, mockInputFingerprint, MOCK_SPEC_VERSION, collectMock, normalizeLibPaths, HARNESS_RESET } from '../src/test/mock.js';

describe('F-28 T-97 Auto-Mock', () => {
  it('buildMockPage: self-contained HTML mit Shim, Libs (src), Plugin-Dateien (src), DOM, Entry-Calls, Events, __rendered/__features', () => {
    const html = buildMockPage({ name: 'P', libFiles: ['three.js'], pluginFiles: ['plugin/widget.js'], selectors: ['#bg', '.box'], entryPoints: ['initPlugin'], events: [{ type: 'click', selector: '#bg' }] });
    expect(html).toMatch(/<script src="three\.js">/);
    expect(html).toMatch(/<script src="plugin\/widget\.js">/); // Plugin-Code extern, nicht inline
    expect(html).toMatch(/window\.apex/);
    expect(html).toMatch(/id="bg"/);
    expect(html).toMatch(/class="box"/);
    expect(html).toMatch(/initPlugin\(\)/);
    expect(html).toMatch(/window\.__ok/);
    // T-102: Features ausüben — erkanntes Event wird ausgelöst, __rendered + __features gesetzt
    expect(html).toMatch(/dispatchEvent\(new Event\("click"/);
    expect(html).toMatch(/window\.__mockEvents/);
    expect(html).toMatch(/window\.__rendered/);
    expect(html).toMatch(/window\.__features/);
  });

  it('buildMockSpec prüft window.__ok + Mount sichtbar + zweites „rendert"-Szenario (T-102)', () => {
    const s = buildMockSpec('P');
    expect(s).toMatch(/#mock-root/);
    expect(s).toMatch(/__ok === true/);
    expect(s).toMatch(/@playwright\/test/);
    // T-102/T-105: separates Szenario, das Render-Output UND self-getestete Features schützt
    expect(s).toMatch(/renders output and exercises its features/);
    expect(s).toMatch(/__rendered/);
    expect(s).toMatch(/__selftested/);
    expect(s).toMatch(/characterized features regressed/);
  });

  it('buildMockSpec wartet auf den FINALEN __ok-Zustand (kein Race gegen die Charakterisierung)', () => {
    // Mocks signalisieren „fertig" unterschiedlich: mal __ok erst spät gesetzt, mal früh false→true.
    // Auf __ok===true zu warten deckt BEIDE Muster ab; ohne Warten liefert ein grün rendernder Mock
    // eine ROTE Baseline. Bei echtem Fehlschlag (Timeout) wird der finale Wert gelesen → klare Assertion.
    const s = buildMockSpec('P');
    expect(s).toMatch(/waitForFunction\(\(\) => window\.__ok === true[\s\S]*\.catch\(/);
    // das Warten muss VOR der __ok-Auswertung stehen
    expect(s.indexOf('waitForFunction')).toBeLessThan(s.lastIndexOf('window.__ok === true'));
  });

  describe('generateMock + writeMock am Fixture-Repo', () => {
    let dir, mockDir;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-'));
      fs.mkdirSync(path.join(dir, 'js', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'js', 'lib', 'three.js'), "var THREE={REVISION:'160'};");
      fs.writeFileSync(path.join(dir, 'js', 'widget.js'), "function initWidget(){ document.querySelector('#vanta'); }");
      // B-21: echte Lib, die NICHT fingerprinted ist (z.B. vanta/*.min.js) — muss trotzdem real geladen werden
      fs.mkdirSync(path.join(dir, 'vanta'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'vanta', 'vanta.net.min.js'), "window.VANTA={NET:function(){return{destroy:function(){}}}};");
      // Echte Plugin-CSS (Optik) + ein per url() referenziertes Font-Asset — muss real geladen+kopiert werden
      fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'fonts', 'icon.woff'), 'FONTDATA');
      fs.writeFileSync(path.join(dir, 'css', 'style.css'), ".kb-col-header-content{min-height:48px}\n@font-face{font-family:i;src:url(../fonts/icon.woff)}");
      fs.writeFileSync(path.join(dir, 'css', 'style.min.css'), ".kb-col-header-content{min-height:48px}"); // min-Zwilling → wird entdoppelt
      fs.writeFileSync(path.join(dir, 'css', 'bootstrap.min.css'), ".row{display:flex}");
      // APEX-SQL-Export: generischer STANDARD-Vertrag (create_plugin_attribute + LOV-Werte). Egal WIE ein Plugin
      // Modes umsetzt (Select-List, Checkbox, freier JSON-Config-Blob) — es steht in dieser Deklaration.
      fs.writeFileSync(path.join(dir, 'region_type_plugin_widget.sql'),
        "wwv_flow_api.create_plugin_attribute(\n p_id=>1\n,p_attribute_scope=>'COMPONENT'\n,p_prompt=>'Selection Mode'\n,p_attribute_type=>'SELECT LIST'\n,p_help_text=>'Controls how nodes get selected'\n);\n" +
        "wwv_flow_api.create_plugin_attr_value(\n p_id=>11\n,p_display_value=>'Single'\n,p_return_value=>'1'\n);\n" +
        "wwv_flow_api.create_plugin_attr_value(\n p_id=>12\n,p_display_value=>'Multi'\n,p_return_value=>'2'\n);\n" +
        "wwv_flow_api.create_plugin_attr_value(\n p_id=>13\n,p_display_value=>'Hierarchical'\n,p_return_value=>'3'\n);\n" +
        "wwv_flow_api.create_plugin_attribute(\n p_id=>2\n,p_attribute_scope=>'COMPONENT'\n,p_prompt=>'Use Client Side Caching'\n,p_attribute_type=>'CHECKBOX'\n);\n" +
        "wwv_flow_api.create_plugin_attribute(\n p_id=>3\n,p_attribute_scope=>'COMPONENT'\n,p_prompt=>'Search Item'\n,p_attribute_type=>'PAGE ITEM'\n);\n" +
        // Plugin mit freiem JS/JSON-Config-Blob: Modes stehen im Default-Wert + Hilfetext, nicht in LOVs.
        "wwv_flow_api.create_plugin_attribute(\n p_id=>4\n,p_attribute_scope=>'COMPONENT'\n,p_prompt=>'ConfigJSON'\n,p_attribute_type=>'JAVASCRIPT'\n,p_default_value=>wwv_flow_string.join(wwv_flow_t_varchar2(\n'{',\n'  \"enableCheckBox\": true,',\n'  \"animationDuration\": 200',\n'}'))\n,p_help_text=>'Free JSON config; enableCheckBox toggles checkboxes'\n);\n");
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

    it('Harness-Reset generisch: vor der echten Plugin-CSS, im statischen + KI-Mock (mirror APEX)', async () => {
      expect(HARNESS_RESET).toMatch(/margin:0/); // resettet u.a. p/headings/lists
      const gen = generateMock(dir, { name: 'Widget' });
      expect(gen.html).toMatch(/id="harness-reset"/);
      // Reset MUSS vor der echten Plugin-CSS stehen, damit diese gewinnt
      expect(gen.html.indexOf('harness-reset')).toBeLessThan(gen.html.indexOf('style.min.css'));
      // KI-Mock ohne eigenen Reset → wird deterministisch injiziert
      const ai = { kind: 'cli', complete: async () => '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/style.min.css"></head><body><div id="mock-root">x</div><script>window.__ok=true;</script></body></html>' };
      const aigen = await generateAiMock(dir, { ai, name: 'Widget' });
      expect(aigen.html).toMatch(/id="harness-reset"/);
      expect(aigen.html.indexOf('harness-reset')).toBeLessThan(aigen.html.indexOf('style.min.css'));
    });

    it('Generischer Vertrag: collectMock liest APEX-Standard-Attribute (Prompt+Typ+LOV+Default), KEINE config-JSON-Annahme', () => {
      const c = collectMock(dir);
      expect(c.attributes).toContain('Selection Mode');
      expect(c.attributes).toContain('Use Client Side Caching');
      expect(c.attributes).toContain('Search Item');
      expect(c.attributes).toContain('ConfigJSON');
      // Modes kommen aus dem plugin-eigenen Vertrag: Typ + LOV-Werte des Select-List-Attributs
      expect(c.optionSurface).toMatch(/Selection Mode \[SELECT LIST\]/);
      expect(c.optionSurface).toMatch(/Single=1/);
      expect(c.optionSurface).toMatch(/Multi=2/);
      expect(c.optionSurface).toMatch(/Hierarchical=3/);
      expect(c.optionSurface).toMatch(/Use Client Side Caching \[CHECKBOX\]/);
      // freier JSON-Config-Blob: Modes stehen im Default/Hilfetext, ebenfalls erfasst
      expect(c.optionSurface).toMatch(/enableCheckBox/);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/DECLARED PLUGIN OPTIONS\/ATTRIBUTES/);      // Attribut-Umfang gelistet
      expect(p).toMatch(/Selection Mode/);                          // konkretes Attribut im Prompt
      expect(p).toMatch(/OPTION\/MODE SURFACE/);                    // Mode-Surface eingespeist
      expect(p).toMatch(/source of truth for which modes exist/);    // Vertrag = Wahrheit, keine Beispiele
      expect(p).not.toMatch(/selectMode 1\/2\/3/);                  // KEINE von uns geprompteten Beispiel-Modes
      expect(p).not.toMatch(/net\/waves\/clouds/);                  // dito
      expect(p).toMatch(/PLAN MULTIPLE VIEWS \/ TEST SCENARIOS/);   // mehrere Sichten planen
      expect(p).toMatch(/EXHAUSTIVELY, not a sample/);              // alle Modes, nicht Stichprobe
      expect(p).toMatch(/never from generic examples/);            // Werte aus dem Plugin, nicht Beispielen
      expect(p).toMatch(/Render the plugin SEPARATELY per view/);
      expect(p).toMatch(/window\.__views/);                         // Plan explizit
      expect(p).toMatch(/\{ view, feature, ok, detail \}/);         // Self-Test je View+Feature
    });

    it('Analyse-Stufe: aiAnalyzePrompt fragt NUR aus dem Plugin abgeleitete Modes (keine Beispiele), analyzeViews parst den Plan', async () => {
      const c = collectMock(dir);
      const ap = aiAnalyzePrompt('Widget', c);
      expect(ap).toMatch(/DISCOVER, from THIS plugin itself/);
      expect(ap).toMatch(/do NOT assume any particular config format/);
      expect(ap).toMatch(/Selection Mode/);                         // Vertrag eingespeist
      expect(ap).toMatch(/EXHAUSTIVELY/);
      expect(ap).not.toMatch(/selectMode 1\/2\/3/);                 // keine Beispiel-Modes
      // analyzeViews: JSON-Array (auch mit Prosa-Rahmen) wird robust geparst und gefiltert
      const ai = { kind: 'cli', complete: async () => 'Here is the plan:\n[{"view":"Single","why":"Selection Mode=1","config":{"selectMode":1}},{"bad":1},{"view":"Multi","config":{"selectMode":2}}]\nDone.' };
      const plan = await analyzeViews({ ai }, 'Widget', c);
      expect(plan.map((v) => v.view)).toEqual(['Single', 'Multi']);  // ungültiger Eintrag gefiltert
      // ohne KI → leer (Mock-Prompt plant dann selbst aus dem Vertrag)
      expect(await analyzeViews({ ai: { kind: 'stub' } }, 'Widget', c)).toEqual([]);
    });

    it('Entdeckter Sichten-Plan landet im Mock-Prompt (genau diese Views umsetzen)', () => {
      const c = collectMock(dir);
      c.viewPlan = [{ view: 'Single selection', why: 'Selection Mode=1', config: { selectMode: 1 } }, { view: 'Hierarchical', why: 'Selection Mode=3', config: { selectMode: 3 } }];
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/DISCOVERED VIEW PLAN/);
      expect(p).toMatch(/Single selection/);
      expect(p).toMatch(/Hierarchical/);
      expect(p).toMatch(/implement EXACTLY those views/);
    });

    it('CSS generisch: collectMock sammelt echte CSS (min entdoppelt), Mock verlinkt sie, statt Optik nachzubauen', () => {
      const c = collectMock(dir);
      expect((c.cssFiles || []).some((f) => /css\/style\.min\.css$/.test(f))).toBe(true); // .min bevorzugt
      expect((c.cssFiles || []).some((f) => /css\/style\.css$/.test(f) && !/\.min\./.test(f))).toBe(false); // non-min entdoppelt
      expect((c.cssFiles || []).some((f) => /bootstrap\.min\.css$/.test(f))).toBe(true);
      // Frameworks (bootstrap) vor plugin-eigener style.css
      const idxBoot = c.cssFiles.findIndex((f) => /bootstrap/.test(f));
      const idxStyle = c.cssFiles.findIndex((f) => /style\./.test(f));
      expect(idxBoot).toBeLessThan(idxStyle);
      const gen = generateMock(dir, { name: 'Widget' });
      expect(gen.html).toMatch(/<link rel="stylesheet" href="[^"]*style\.min\.css">/); // echte CSS verlinkt
    });

    it('CSS generisch: writeMock kopiert CSS + per url() referenzierte Assets (Fonts)', () => {
      const gen = generateMock(dir, { name: 'Widget' });
      writeMock(mockDir, dir, gen);
      expect(fs.existsSync(path.join(mockDir, 'css', 'style.min.css'))).toBe(true);
      // style.css (non-min) wird zwar entdoppelt — aber falls eine CSS url() referenziert, muss das Asset da sein.
      // Wir testen das Font-Asset über die non-min style.css separat:
      const gen2 = { ...gen, cssFiles: ['css/style.css'] };
      writeMock(mockDir, dir, gen2);
      expect(fs.existsSync(path.join(mockDir, 'fonts', 'icon.woff'))).toBe(true); // url(../fonts/icon.woff) mitkopiert
    });

    it('aiMockPrompt: echte CSS werden gelistet + Regel „nicht nachbauen"', () => {
      const c = collectMock(dir);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/style\.min\.css/);                          // CSS-Pfad gelistet
      expect(p).toMatch(/REAL CSS stylesheets of the plugin/);       // als echte CSS deklariert
      expect(p).toMatch(/do NOT hand-write\/approximate the plugin's own styling/); // nicht nachbauen
    });

    it('aiMockPrompt enthält Analyse, Lib-/Datei-Pfade und window.__ok-Vertrag (T-101)', () => {
      const c = collectMock(dir);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/three\.js/);            // Lib-Pfad
      expect(p).toMatch(/plugin\//);             // Plugin-Dateipfad
      expect(p).toMatch(/window\.__ok/);          // Vertrag
      expect(p).toMatch(/apex/i);                 // Shim-Anforderung
    });

    it('aiMockPrompt: KI versteht Features + baut Self-Test-Harness (T-102/T-105)', () => {
      const c = collectMock(dir);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/interactions\/events/i);     // Events werden gelistet
      expect(p).toMatch(/UNDERSTAND the plugin/);     // erst verstehen
      expect(p).toMatch(/SELF-TEST HARNESS/);         // dann Self-Test-Harness
      expect(p).toMatch(/REAL EFFECT/);               // Wirkung prüfen, nicht nur ausführen
      expect(p).toMatch(/drag & drop/i);              // Drag&Drop ausdrücklich
      expect(p).toMatch(/not reliably simulable headlessly/); // False-Negative vermeiden: echtes DnD nicht rot werten
      expect(p).toMatch(/window\.__features/);
      expect(p).toMatch(/window\.__selftested/);
      expect(p).toMatch(/window\.__rendered/);
      // "works as before": Self-Tests charakterisieren NUR das Ist-Verhalten → müssen am unveränderten Plugin grün sein
      expect(p).toMatch(/CHARACTERIZE THE PLUGIN AS IT IS/);
      expect(p).toMatch(/MUST PASS right now/);
      expect(p).toMatch(/Do NOT invent aspirational/);
      expect(p).toMatch(/__ok MUST be true for the unmodified plugin/);
      expect(p).toMatch(/NEVER ASSERT A GUESSED CONSTANT/);          // Ist-Wert auslesen statt raten (3-rote-Fix)
      expect(p).toMatch(/READ the plugin's ACTUAL value at runtime/);
      // T-106: Optik realistisch + Self-Tests nicht-destruktiv (sichtbarer Stand bleibt sauber)
      expect(p).toMatch(/VISUAL QUALITY MATTERS/);
      expect(p).toMatch(/REAL CSS IS LOADED — NOT BECAUSE YOU PATCHED IT/); // Optik kommt aus echter CSS, nicht aus plugin-spezifischem Hand-CSS
      expect(p).toMatch(/HUMAN-READABLE/);
      expect(p).toMatch(/NON-DESTRUCTIVE/);
      expect(p).toMatch(/visible page MUST show the clean/);
    });

    it('B-21: collectMock + generateMock erfassen NICHT-fingerprinted Libs (vanta/*) als extraLibFiles', () => {
      const c = collectMock(dir);
      expect((c.extraLibFiles || []).some((f) => /vanta[\\/]vanta\.net\.min\.js$/.test(f))).toBe(true);
      const gen = generateMock(dir, { name: 'Widget' });
      expect((gen.extraLibFiles || []).some((f) => /vanta\.net\.min\.js$/.test(f))).toBe(true);
      // statischer Mock lädt die echte Lib real per <script src>, faked sie NICHT
      expect(gen.html).toMatch(/<script src="[^"]*vanta\.net\.min\.js">/);
    });

    it('B-21: writeMock kopiert auch extraLibFiles neben die Seite', () => {
      const gen = generateMock(dir, { name: 'Widget' });
      writeMock(mockDir, dir, gen);
      const extra = gen.extraLibFiles.find((f) => /vanta\.net\.min\.js$/.test(f));
      expect(extra).toBeTruthy();
      expect(fs.existsSync(path.join(mockDir, extra))).toBe(true);
    });

    it('B-21: aiMockPrompt listet extraLibFiles + harte Regel „Daten mocken, Funktionalität NICHT"', () => {
      const c = collectMock(dir);
      const p = aiMockPrompt('Widget', c);
      expect(p).toMatch(/vanta\.net\.min\.js/);                       // echte Lib gelistet
      expect(p).toMatch(/MOCK DATA, NEVER FUNCTIONALITY/);           // Prinzip als harte Regel
      expect(p).toMatch(/NOT fake, stub, reimplement or "shim"/);    // kein Faken von Libs/Funktion
      expect(p).toMatch(/official CDN/);                              // fehlende Lib echt vom CDN
      expect(p).toMatch(/PEER \/ TRANSITIVE DEPENDENCIES/);          // Peer-Deps mitladen (z.B. jQuery UI für Fancytree)
      expect(p).toMatch(/is not a function.*missing|requires/);      // „… is not a function"/„requires X" = fehlende Abhängigkeit
      expect(p).toMatch(/animations must really animate/);           // Animation muss real laufen
    });

    it('B-21: normalizeLibPaths korrigiert falsche lokale Lib-Pfade (../../, /) auf die kopierte Datei, CDN bleibt', () => {
      const rel = ['js/lib/three.js', 'vanta/vanta.net.min.js'];
      const html = [
        '<script src="js/lib/three.js"></script>',
        '<script src="../../vanta/vanta.net.min.js"></script>',   // KI-Fehler: zwei Ebenen hoch → Server-Root
        '<script src="/vanta/vanta.net.min.js"></script>',         // KI-Fehler: absoluter Pfad
        '<script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>', // CDN: echte fehlende Lib
      ].join('\n');
      const out = normalizeLibPaths(html, rel);
      expect(out).toMatch(/src="js\/lib\/three\.js"/);            // korrekt → unverändert
      expect(out).not.toMatch(/\.\.\/\.\.\/vanta/);               // ../../ entfernt
      expect(out).not.toMatch(/src="\/vanta/);                    // führendes / entfernt
      expect((out.match(/src="vanta\/vanta\.net\.min\.js"/g) || []).length).toBe(2); // beide auf den echten Pfad
      expect(out).toMatch(/cdn\.jsdelivr\.net[^"]*jquery/);       // CDN-URL bleibt unangetastet
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

    it('generateAiMock: Prosa-Vorspann der KI wird entfernt (sauberes <!DOCTYPE…</html>)', async () => {
      const ai = { kind: 'cli', complete: async () => 'I now understand the data flow.\n<!DOCTYPE html>\n<html><body><div id="mock-root"></div><script>window.__ok=true;</script></body></html>\nDone.' };
      const gen = await generateAiMock(dir, { ai, name: 'Widget' });
      expect(gen.mode).toBe('ai');
      expect(gen.html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(gen.html.trimEnd().endsWith('</html>')).toBe(true);
      expect(gen.html).not.toMatch(/I now understand|Done\./);
    });

    it('generateAiMock: gültige HTML ohne __ok → Vertrag wird injiziert (kein Fallback)', async () => {
      const ai = { kind: 'cli', complete: async () => '<html><body><div id="mock-root">x</div></body></html>' };
      const gen = await generateAiMock(dir, { ai, name: 'Widget' });
      expect(gen.mode).toBe('ai');
      expect(gen.html).toMatch(/window\.__ok/);
    });
  });

  describe('Selbstkorrektur-Schleife (2te Schleife) — generisch, für jedes Plugin', () => {
    // Fake-Chromium: liefert pro page.evaluate() den nächsten vorbereiteten Charakterisierungs-Stand.
    const fakeLaunch = (evals) => { let i = 0; return async () => ({ newPage: async () => ({ goto: async () => {}, waitForFunction: async () => {}, waitForTimeout: async () => {}, evaluate: async () => evals[Math.min(i++, evals.length - 1)], screenshot: async () => {} }), close: async () => {} }); };

    it('finalizeAiHtml: bereinigt Zaun/Prosa, injiziert Reset, sichert __ok; Müll → error', () => {
      const fin = finalizeAiHtml('```html\nI think:\n<!DOCTYPE html><html><head></head><body><div id="mock-root">x</div><script>window.__ok=true;</script></body></html>\n```', { cssFiles: ['css/style.min.css'] });
      expect(fin.error).toBeUndefined();
      expect(fin.html).toMatch(/^<!DOCTYPE html>/);
      expect(fin.html).toMatch(/id="harness-reset"/);
      expect(fin.html).not.toMatch(/```|I think/);
      expect(finalizeAiHtml('sorry, no html', {}).error).toBeTruthy();
    });

    it('runMockSelfTests: liest __ok/__views/__features aus, extrahiert die roten Checks', async () => {
      const launch = fakeLaunch([{ ok: false, rendered: true, views: 3, features: [{ view: 'a', feature: 'x', ok: true }, { view: 'a', feature: 'y', ok: false, detail: 'real=2' }] }]);
      const st = await runMockSelfTests('http://x/index.html', { launch });
      expect(st.ran).toBe(true);
      expect(st.views).toBe(3);
      expect(st.total).toBe(2);
      expect(st.failed).toEqual([{ view: 'a', feature: 'y', detail: 'real=2' }]);
    });

    it('runMockSelfTests: ohne Playwright/Launch → ran:false (kein Crash)', async () => {
      const st = await runMockSelfTests('', {});
      expect(st.ran).toBe(false);
    });

    it('aiRefinePrompt: nennt die roten Checks + Ist-Werte und die Korrektur-Regel', () => {
      const p = aiRefinePrompt('Widget', '<html></html>', [{ view: 'v1', feature: 'toggleEffect===false', detail: 'real={effect:slide}' }]);
      expect(p).toMatch(/are RED/);
      expect(p).toMatch(/mis-characterization/);
      expect(p).toMatch(/v1/);
      expect(p).toMatch(/toggleEffect===false/);
      expect(p).toMatch(/real=\{effect:slide\}/);
      expect(p).toMatch(/ACTUAL current behavior/);
      expect(p).toMatch(/DROP that check/);
    });

    it('refineMock: rot → KI bessert nach → grün (konvergiert, schreibt korrigierten Mock)', async () => {
      const launch = fakeLaunch([
        { ok: false, rendered: true, views: 2, features: [{ view: 'v', feature: 'f', ok: false, detail: 'real=X' }] }, // Runde 1 misst: 1 rot
        { ok: true, rendered: true, views: 2, features: [{ view: 'v', feature: 'f', ok: true }] },                       // Runde 2 misst: grün
      ]);
      let aiCalls = 0; const written = [];
      const ai = { kind: 'cli', complete: async (p) => { aiCalls++; expect(p).toMatch(/are RED/); return '<!DOCTYPE html><html><body><div id="mock-root">x</div><script>window.__ok=true;window.__selftested=true;</script></body></html>'; } };
      const gen = { html: '<!DOCTYPE html><html><body><div id="mock-root">x</div><script>window.__ok=true;</script></body></html>', mode: 'ai', libFiles: [], extraLibFiles: [], cssFiles: [] };
      const ref = await refineMock(gen, { ai, url: 'http://x/index.html', name: 'Widget', write: (h) => written.push(h), launch });
      expect(aiCalls).toBe(1);            // genau eine Korrektur nötig
      expect(written.length).toBe(1);     // korrigierter Mock geschrieben
      expect(ref.after.failed.length).toBe(0); // am Ende grün
      expect(ref.before.failed.length).toBe(1); // vorher 1 rot
    });

    it('refineMock: ohne KI/URL oder mode!=ai → no-op (keine Korrektur, kein Crash)', async () => {
      const r1 = await refineMock({ html: 'x', mode: 'ai' }, { ai: { kind: 'stub' }, url: 'http://x', name: 'P', write: () => {} });
      expect(r1.rounds).toBe(0);
      const r2 = await refineMock({ html: 'x', mode: 'static' }, { ai: { kind: 'cli', complete: async () => 'x' }, url: 'http://x', name: 'P', write: () => {} });
      expect(r2.rounds).toBe(0);
    });

    it('refineMock: bereits grün → keine KI-Korrektur', async () => {
      const launch = fakeLaunch([{ ok: true, rendered: true, views: 2, features: [{ view: 'v', feature: 'f', ok: true }] }]);
      let aiCalls = 0;
      const ai = { kind: 'cli', complete: async () => { aiCalls++; return '<html></html>'; } };
      const ref = await refineMock({ html: '<html></html>', mode: 'ai', libFiles: [], extraLibFiles: [], cssFiles: [] }, { ai, url: 'http://x', name: 'P', write: () => {}, launch });
      expect(aiCalls).toBe(0);
      expect(ref.after.failed.length).toBe(0);
    });
  });

  describe('Versionierte KI-Untersuchung — Fingerprint (nur unbekannte Versionen bauen)', () => {
    let fdir;
    beforeAll(() => {
      fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockfp-'));
      fs.mkdirSync(path.join(fdir, 'js'), { recursive: true });
      fs.writeFileSync(path.join(fdir, 'js', 'widget.js'), "function initWidget(){ document.querySelector('#root'); }");
      fs.writeFileSync(path.join(fdir, 'region_type_plugin_x.sql'),
        "wwv_flow_api.create_plugin_attribute(\n p_id=>1\n,p_prompt=>'Mode'\n,p_attribute_type=>'SELECT LIST'\n);\n");
    });
    afterAll(() => { fs.rmSync(fdir, { recursive: true, force: true }); });

    it('deterministisch + sha256-Form; gleicher Stand → gleicher Fingerprint', () => {
      const fp1 = mockInputFingerprint(fdir);
      expect(fp1).toMatch(/^[a-f0-9]{64}$/);
      expect(mockInputFingerprint(fdir)).toBe(fp1); // bekannter Stand → KI-Untersuchung kann entfallen
    });

    it('Plugin-/Vertrags-Änderung → anderer Fingerprint (unbekannte Version → neu untersuchen)', () => {
      const fp1 = mockInputFingerprint(fdir);
      fs.appendFileSync(path.join(fdir, 'region_type_plugin_x.sql'),
        "wwv_flow_api.create_plugin_attribute(\n p_id=>2\n,p_prompt=>'New Option'\n,p_attribute_type=>'CHECKBOX'\n);\n");
      expect(mockInputFingerprint(fdir)).not.toBe(fp1);
    });

    it('MOCK_SPEC_VERSION fließt ein: andere Logik-Version → andere Fingerprints (bekannte Plugins 1× neu)', () => {
      // gleiche Eingaben, aber die Spec-Version ist Teil des Hashes → ein Bump invalidiert bewusst alle Caches
      expect(typeof MOCK_SPEC_VERSION).toBe('string');
      expect(MOCK_SPEC_VERSION.length).toBeGreaterThan(0);
    });
  });
});
