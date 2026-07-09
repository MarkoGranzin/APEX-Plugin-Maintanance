/**
 * F-28 (T-97) — Auto-Mock je Komponente.
 *
 * Baut nach dem Git-Download eine self-contained Test-/Harness-Seite, mit der das Plugin OHNE echte
 * APEX-Instanz lädt: minimaler apex-Shim + vendored Libs (als <script src>) + extrahierter Plugin-Code
 * (inline) + DOM für erkannte Selektoren + Aufruf der Einstiegspunkte. window.__ok signalisiert
 * fehlerfreies Laden (Charakterisierung „läuft wie zuvor"). Der Mock ist per Link manuell aufrufbar
 * und dient als Default-UI-Test-URL für Baseline/Migration.
 *
 * buildMockPage/buildMockSpec sind rein (testbar); generateMock sammelt aus dem Repo.
 *
 * Resultat: src/test/mock.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectVendoredLibraries } from '../sbom/vendored.js';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { isLibraryFile } from '../inventory/format.js';
import { analyzeDeep } from './analyze-deep.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Minimaler CSS-Reset, den JEDE Mock-Seite bekommt. Plugins werden für die APEX-Umgebung geschrieben,
 * die (wie jedes Framework) Browser-Defaults normalisiert — v.a. die Element-Margins (p/h1.. /ul/figure).
 * Ohne diesen Reset brechen Plugin-Layouts, die margin-freie Block-Elemente voraussetzen (z.B. ein
 * <p class="title"> in einer fix hohen Kopfzeile läuft durch den UA-Default-Margin über). Generisch,
 * NICHT plugin-spezifisch; lädt VOR der echten Plugin-CSS, damit diese gewinnt. KEINE Optik nachbauen.
 */
export const HARNESS_RESET = '*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.4;color:#333;background:#fff}h1,h2,h3,h4,h5,h6,p,figure,blockquote,dl,dd,ul,ol,pre{margin:0}ul,ol{padding:0}';

/** Erzeugt ein DOM-Element für einen erkannten Selektor (#id bzw. .class), sichtbar. */
function domFor(sel) {
  const s = String(sel || '').trim();
  if (/^#[\w-]+$/.test(s)) return `<div id="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  if (/^\.[\w-]+$/.test(s)) return `<div class="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  return '';
}

/** Self-contained Mock-Seite (rein). libFiles + pluginFiles werden via <script src> geladen (relativ). */
export function buildMockPage({ name = 'plugin', libFiles = [], cssFiles = [], pluginFiles = [], selectors = [], entryPoints = [], events = [] } = {}) {
  const dom = [...new Set(selectors.map(domFor).filter(Boolean))].join('\n      ');
  const cssTags = cssFiles.map((f) => `<link rel="stylesheet" href="${esc(f)}">`).join('\n  '); // echte Plugin-CSS, nicht nachbauen
  const libTags = libFiles.map((f) => `<script src="${esc(f)}"></script>`).join('\n    ');
  // Plugin-Code als EXTERNE Dateien laden (kein Inlining → keine HTML-Kontext-/Encoding-Brüche;
  // ein fehlerhaftes Skript bricht nur sich selbst, sichtbar als pageerror).
  const plugin = pluginFiles.map((f) => `  <script src="${esc(f)}"></script>`).join('\n');
  // Einstiegspunkt-Aufrufe sind NICHT fatal: ohne echte APEX-Config scheitern sie oft — das soll die
  // „lädt sauber"-Baseline nicht rot machen. Erfolge/Fehler je Entry werden separat erfasst (Info bzw.
  // zusätzliche grüne Szenarien, die eine Migration dann doch schützen, wenn ein Entry hier läuft).
  const entry = entryPoints.map((fn) => `  try{ if(typeof ${fn}==='function'){ ${fn}(); window.__mockEntry.push({fn:'${esc(fn)}',ok:true}); } }catch(e){ window.__mockEntry.push({fn:'${esc(fn)}',ok:false,error:(e&&e.message||String(e))}); }`).join('\n');
  // Erkannte Events auf ihren Elementen auslösen (non-fatal) → die Event-Handler des Plugins werden ausgeübt,
  // nicht nur das Laden. Jedes Ergebnis wird in window.__mockEvents protokolliert.
  const evDispatch = (events || []).map((ev) => `  try{ var el=document.querySelector(${JSON.stringify(ev.selector)}); if(el){ el.dispatchEvent(new Event(${JSON.stringify(ev.type)},{bubbles:true})); window.__mockEvents.push({type:${JSON.stringify(ev.type)},selector:${JSON.stringify(ev.selector)},ok:true}); } else { window.__mockEvents.push({type:${JSON.stringify(ev.type)},selector:${JSON.stringify(ev.selector)},ok:true,skipped:true}); } }catch(e){ window.__mockEvents.push({type:${JSON.stringify(ev.type)},selector:${JSON.stringify(ev.selector)},ok:false,error:(e&&e.message||String(e))}); }`).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock — ${esc(name)}</title>
  <style id="harness-reset">${HARNESS_RESET}</style>
  ${cssTags}
</head>
<body>
  <h3>Mock harness — ${esc(name)}</h3>
  <p class="muted">Self-contained test page (apex shim + libs + plugin). For manual testing &amp; the works-as-before baseline.</p>
  <div id="mock-root" style="width:200px;height:60px;border:1px solid #888">plugin mount</div>
      ${dom}
  <script>window.__mockErrors=[]; window.__mockEntry=[]; window.__mockEvents=[]; window.onerror=function(m){ window.__mockErrors.push(String(m)); };</script>
    ${libTags}
  <script>
    // apex-Shim (nach den Libs, damit jQuery verfügbar ist) — breit genug, damit Plugins beim Laden nicht stolpern
    window.apex = window.apex || {};
    apex.jQuery = window.jQuery || window.$ || undefined; window.$ = window.$ || window.jQuery;
    var _item = { getValue:function(){return '';}, setValue:function(){}, hide:function(){}, show:function(){}, disable:function(){}, enable:function(){}, isEmpty:function(){return true;}, node:null };
    apex.item = function(){ return _item; }; apex.items = {}; apex.fileURL = function(p){ return p; };
    window.$v = function(){ return ''; }; window.$s = function(){}; window.$x = function(){ return null; };
    apex.region = function(){ return { refresh:function(){}, widget:function(){return {};}, call:function(){} }; };
    apex.submit = function(){}; apex.debug = Object.assign(function(){}, { info:function(){}, error:function(){}, trace:function(){}, log:function(){} });
    apex.message = { clearErrors:function(){}, showErrors:function(){}, alert:function(){}, confirm:function(){}, showPageSuccess:function(){} };
    apex.server = { process:function(){ return Promise.resolve({}); }, plugin:function(){ return Promise.resolve({}); }, url:function(){ return ''; } };
    apex.util = { escapeHTML:function(s){return String(s==null?'':s);}, debounce:function(f){return f;}, htmlBuilder:function(){ return { markup:function(){return this;}, toString:function(){return '';} }; }, applyTemplate:function(s){return s;} };
    apex.env = {}; apex.theme = { defaultStickyTop:function(){return 0;} }; apex.widget = {}; apex.lang = { getMessage:function(k){return k;}, formatMessage:function(k){return k;} };
    apex.actions = { add:function(){}, lookup:function(){}, invoke:function(){} }; apex.navigation = { dialog:function(){}, redirect:function(){} }; apex.clipboard = {};
  </script>
${plugin}
  <script>
${entry}
${evDispatch}
    // __rendered: hat das Plugin substanziellen Output in #mock-root erzeugt (Feature „rendert")?
    (function(){ var r=document.querySelector('#mock-root'); window.__rendered = !!(r && (r.querySelector('svg,canvas') || (r.children.length>0 && r.innerHTML.replace(/\\s/g,'').length>40))); })();
    // Feature-Übersicht (Einstiegspunkte + Events) für die Charakterisierung
    window.__features = [].concat(
      (window.__mockEntry||[]).map(function(e){ return { feature:'entry:'+e.fn, ok:e.ok, error:e.error }; }),
      (window.__mockEvents||[]).map(function(e){ return { feature:'event:'+e.type+'@'+e.selector, ok:e.ok, error:e.error }; })
    );
    // Baseline „lädt sauber" = nur Lade-/Top-Level-Fehler zählen (Feature-Aufrufe ohne Config sind nicht fatal)
    window.__ok = (window.__mockErrors.length === 0);
  </script>
</body></html>`;
}

/** Playwright-Spec, der den Mock prüft: lädt fehlerfrei (window.__ok) + Mount sichtbar. */
export function buildMockSpec(name = 'plugin') {
  return `import { test, expect } from '@playwright/test';
const URL = process.env.PLUGIN_URL;

// The mock characterizes itself asynchronously (mxGraph etc. need a tick to lay out). Mocks differ in
// HOW they signal: some leave window.__ok undefined until done, others initialise it to false and flip
// it to true at the end. So wait for the FINAL state (__ok === true); on timeout fall through and read
// the final value so the assertions fail with captured detail instead of a cryptic timeout.
async function settle(page) {
  await page.goto(URL);
  await expect(page.locator('#mock-root')).toBeVisible();
  await page.waitForFunction(() => window.__ok === true, null, { timeout: 8000 }).catch(() => {});
}

test('mock loads the plugin without JS errors (works as before)', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await settle(page);
  const ok = await page.evaluate(() => window.__ok === true);
  const mockErrors = await page.evaluate(() => window.__mockErrors || []);
  expect(errors, errors.join('\\n')).toEqual([]);
  expect(ok, 'plugin reported load errors: ' + JSON.stringify(mockErrors)).toBe(true);
});

test('plugin renders output and exercises its features', async ({ page }) => {
  await settle(page);
  const info = await page.evaluate(() => {
    var r = document.querySelector('#mock-root');
    var dom = !!(r && (r.querySelector('svg,canvas') || (r.children.length > 0 && r.innerHTML.replace(/\\s/g, '').length > 40)));
    var rendered = (window.__rendered === true) || (window.__rendered !== false && dom);
    var features = window.__features || [];
    return { rendered: rendered, selftested: window.__selftested === true, failed: features.filter(function (f) { return f && f.ok === false; }), features: features };
  });
  expect(info.rendered, 'plugin produced no visible output in #mock-root; features=' + JSON.stringify(info.features)).toBe(true);
  // When the mock self-tested its features (AI harness), EVERY characterized feature must work — this
  // is what makes "works as before" cover drag & drop and the plugin's real behavior, not just load.
  if (info.selftested) {
    expect(info.failed, 'characterized features regressed (must work as before): ' + JSON.stringify(info.failed)).toEqual([]);
  }
});`;
}

// Verzeichnisse, die beim Repo-Scan übersprungen werden (kein Quellcode/keine Assets des Plugins).
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.maintenance|\.idea|\.vscode|test|tests|spec|specs|docs?|examples?|img|images)$/i;

/** Läuft das Repo rekursiv ab (ohne SKIP_DIR) und ruft onFile(relPfad, absPfad) je Datei. Best effort. */
function walkRepoFiles(dir, onFile) {
  const walk = (d, rel) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.test('/' + r)) walk(path.join(d, e.name), r); continue; }
      else onFile(r, path.join(d, e.name));
    }
  };
  try { walk(dir, ''); } catch { /* best effort */ }
}

const tooBig = (abs) => { try { return fs.statSync(abs).size > 4_000_000; } catch { return true; } };

/**
 * Findet lib-artige JS-Dateien im Repo, die NICHT per Fingerprint erkannt wurden (z.B. vanta/*.min.js).
 * Sonst würden sie ganz fehlen und die KI müsste die Lib faken (statischer Mock, keine echte Funktion). B-21.
 */
function scanExtraLibFiles(dir, libSet) {
  const out = [];
  const libDir = /(^|\/)(lib|libs|vendor|vendors|dist|build|vanta|three|deps|third[-_]?party|external|externals)(\/|$)/i;
  walkRepoFiles(dir, (r, abs) => {
    if (!/\.js$/i.test(r) || libSet.has(r)) return;                  // kein JS / schon als erkannte Lib gelistet
    if (!(libDir.test('/' + r) || isLibraryFile(r))) return;        // nur lib-artige Dateien
    if (!tooBig(abs)) out.push(r);
  });
  return out;
}

/**
 * Findet die echten CSS-Dateien des Plugins im Repo. Optik ist Teil des Verhaltens („wie zuvor") und darf
 * NICHT von der KI nachgebaut werden — die echten Stylesheets werden geladen (generisch, für jedes Plugin).
 * Dedupliziert min/non-min (bevorzugt .min.css = Produktionsstand). Reihenfolge: Frameworks vor Plugin-eigener CSS.
 */
function scanCssFiles(dir) {
  const found = [];
  walkRepoFiles(dir, (r, abs) => { if (/\.css$/i.test(r) && !tooBig(abs)) found.push(r); });
  // min/non-min entdoppeln: pro Basis (ohne .min) genau eine Datei, .min bevorzugt
  const byBase = new Map();
  for (const r of found) { const key = r.replace(/\.min\.css$/i, '.css').toLowerCase(); const cur = byBase.get(key); if (!cur || (/\.min\.css$/i.test(r) && !/\.min\.css$/i.test(cur))) byBase.set(key, r); }
  // Frameworks/Reset/Grid zuerst, plugin-eigene Stylesheets (style*) zuletzt, damit sie überschreiben
  const rank = (f) => /(normalize|reset|bootstrap|foundation|font-?awesome|fontawesome|grid|material|theme|vendor)/i.test(f) ? 0 : (/\bstyle(\.|$)/i.test(f) ? 2 : 1);
  return [...byBase.values()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Liest den DEKLARIERTEN Funktionsumfang eines APEX-Plugins aus dem SQL-Export: die Attribut-Prompts
 * (p_prompt=>'…'). Das ist der Vertrag des Plugins über seine Optionen/Modi — generische Basis dafür,
 * dass die KI MEHRERE Sichten/Testfälle (je Modus/Option) plant und charakterisiert, statt nur einer
 * Default-Konfiguration. Kein plugin-spezifisches Wissen nötig — kommt aus dem Plugin selbst.
 */
/**
 * Liest die GENERISCHE, bei JEDEM APEX-Plugin standardisierte Vertragsbasis aus dem SQL-Export:
 * die `wwv_flow_api.create_plugin_attribute`-Deklarationen (Prompt, Typ, Default, Hilfetext) plus die
 * zugehörigen `create_plugin_attr_value`-LOV-Werte. KEINE Annahme über config-JSON/<li>/o.ä. — wie ein
 * Plugin seine Modes konkret umsetzt (Select-List-Attribut, Checkbox, freier JS/JSON-Config-Blob …) steht
 * IN dieser Deklaration (Werte/Default/Hilfetext sind die plugin-eigene Doku). Fehlt sie → leer (ehrlich).
 * Diese Fakten sind die Eingabe der KI-Analyse (analyzeViews), die daraus die Sichten ABLEITET.
 */
function scanPluginAttributes(dir) {
  const attrs = []; // {prompt, type, def, help, values:[]}
  walkRepoFiles(dir, (rel, abs) => {
    if (!/\.sql$/i.test(rel) || tooBig(abs)) return;
    let txt = ''; try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
    let last = null;
    for (const call of plsqlApiCalls(txt, /wwv_flow_api\.(create_plugin_attribute|create_plugin_attr_value)\s*\(/gi)) {
      const p = plsqlParams(call.body);
      if (call.name === 'create_plugin_attribute') {
        const a = {
          prompt: (plsqlText(p.p_prompt) || '').trim(),
          type: (plsqlText(p.p_attribute_type) || '').trim(),
          def: (plsqlText(p.p_default_value) || '').replace(/\s+/g, ' ').trim(),
          help: (plsqlText(p.p_help_text) || '').replace(/\s+/g, ' ').trim(),
          values: [],
        };
        if (a.prompt) { attrs.push(a); last = a; }
      } else if (last) {
        const disp = (plsqlText(p.p_display_value) || '').trim();
        const ret = (plsqlText(p.p_return_value) || '').trim();
        const v = disp && ret && disp !== ret ? `${disp}=${ret}` : (disp || ret);
        if (v) last.values.push(v);
      }
    }
  });
  // Vertragstext rendern: pro Attribut Prompt [Typ], erlaubte Werte, Default + Hilfetext (plugin-eigene Doku).
  const lines = []; let len = 0;
  for (const a of attrs) {
    let line = `• ${a.prompt}${a.type ? ` [${a.type}]` : ''}`;
    if (a.values.length) line += ` — allowed values: ${a.values.join(' | ')}`;
    const doc = [a.help, a.def].filter(Boolean).join(' || ');
    if (doc) line += ` — ${doc}`;
    line = line.slice(0, 1400); // Config-Blob-Defaults (wo Modes stehen) komplett mitnehmen
    if (len + line.length > 4500) break;
    lines.push(line); len += line.length;
  }
  return { names: attrs.map((a) => a.prompt), surface: lines.join('\n'), attrs };
}

/**
 * T-126 — Strukturierte Plugin-Schnittstelle (für den exakten Akzeptanz-Vertrag/.feature-Export).
 * Liefert je deklariertem APEX-Attribut Name/Typ/erlaubte Werte/voller Default (inkl. JSON-Konfig)/Hilfe.
 * @returns {{attributes:Array<{prompt,type,values,def,help}>, surface:string}}
 */
export function pluginInterface(dir) {
  const a = scanPluginAttributes(dir);
  return { attributes: a.attrs, surface: a.surface };
}

/** Findet `pkg.fn(...)`-Aufrufe mit balancierten Klammern (PL/SQL-String-' bewusst). Liefert {name, body}. */
function plsqlApiCalls(txt, re) {
  const out = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    let i = re.lastIndex, depth = 1, inStr = false;
    while (i < txt.length && depth > 0) {
      const ch = txt[i];
      if (inStr) { if (ch === "'") { if (txt[i + 1] === "'") i++; else inStr = false; } }
      else if (ch === "'") inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    out.push({ name: m[1].toLowerCase(), body: txt.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/** Zerlegt einen Aufrufkörper in `p_name => <rohwert>` (Wert bis zum nächsten Parameter-Token). */
function plsqlParams(body) {
  const re = /(?:^|[\s,(])(p_[a-z0-9_]+)\s*=>/gi;
  const marks = []; let m;
  while ((m = re.exec(body)) !== null) marks.push({ name: m[1].toLowerCase(), tok: m.index, val: re.lastIndex });
  const params = {};
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].tok : body.length;
    if (!(marks[k].name in params)) params[marks[k].name] = body.slice(marks[k].val, end);
  }
  return params;
}

/** Verkettet alle einfach-quotierten Literale eines Rohwerts (deckt Skalar '…' und wwv_flow_string.join-Listen). */
function plsqlText(raw) {
  if (!raw) return '';
  const parts = []; const re = /'((?:[^']|'')*)'/g; let m;
  while ((m = re.exec(raw)) !== null) parts.push(m[1].replace(/''/g, "'"));
  return parts.join('');
}

/**
 * Sammelt aus dem Repo, was der Mock braucht: Lib-Dateien (erkannt + extra/nicht-erkannt), Plugin-Dateien, CSS, Analyse.
 * @returns {{libFiles:string[], extraLibFiles:string[], cssFiles:string[], attributes:string[], pluginFiles:{name:string,code:string}[], selectors:string[], entryPoints:string[], functions:object[], events:object[]}}
 */
export function collectMock(dir) {
  const libs = detectVendoredLibraries(dir).filter((l) => l.evidence && /\.js$/i.test(l.evidence));
  const libFiles = libs.map((l) => l.evidence);
  const libSet = new Set(libFiles);
  // B-21: echte, aber nicht-fingerprinted Repo-Libs (z.B. vanta/*.min.js) mitnehmen statt faken.
  const extraLibFiles = scanExtraLibFiles(dir, libSet);
  // Echte CSS des Plugins laden statt von der KI nachbauen lassen (Optik = „wie zuvor", generisch).
  const cssFiles = scanCssFiles(dir);
  // Deklarierter Funktionsumfang (APEX-Plugin-Attribute + Options-/Mode-Surface) → Basis für mehrere Sichten.
  const attr = scanPluginAttributes(dir);
  const attributes = attr.names;
  const optionSurface = attr.surface;
  const pluginFiles = [];
  const selectors = new Set();
  const entryPoints = new Set();
  const functions = [];
  const events = new Map(); // key: type|selector → {type,selector}
  const seen = new Set();
  let n = 0;
  try {
    for (const a of inspectAssets(dir)) {
      const rel = a.origin?.type === 'file' ? String(a.origin.path).replace(/\\/g, '/') : '';
      if (rel && (libSet.has(rel) || isLibraryFile(rel) || /(^|\/)(lib|libs|vendor|vendors|dist)\//i.test(rel))) continue; // Lib → schon als <script src>
      const base = (rel || a.name || '').replace(/\.min\.js$/i, '.js');
      if (base && seen.has(base)) continue; if (base) seen.add(base);
      if (a.code && parseOk(a.code) && a.code.length < 200000) {
        const fname = `plugin/${String((rel ? rel.split('/').pop() : a.name) || `inline-${++n}.js`).replace(/[^\w.-]/g, '_').replace(/\.min\.js$/i, '.js')}`;
        pluginFiles.push({ name: fname, code: a.code });
      }
      const deep = analyzeDeep(a.code || '');
      for (const s of deep.selectors || []) selectors.add(s);
      for (const ev of deep.events || []) { if (ev && ev.selector) { const k = ev.type + '|' + ev.selector; if (!events.has(k)) events.set(k, { type: ev.type, selector: ev.selector }); } }
      for (const f of deep.functions || []) { functions.push(f); if (f.name && /^(init|refresh|render|draw|setup|load|create|destroy)/i.test(f.name)) entryPoints.add(f.name); }
    }
  } catch { /* best effort */ }
  return { libFiles, extraLibFiles, cssFiles, attributes, optionSurface, pluginFiles, selectors: [...selectors], entryPoints: [...entryPoints], functions, events: [...events.values()] };
}

/**
 * Spec-Version der Mock-/Analyse-LOGIK. HOCHZÄHLEN, wenn sich Analyse-Stufe, Prompt oder Mock-Aufbau
 * fachlich ändern → bekannte Plugins werden einmalig neu untersucht, gleicher Stand bleibt gecacht.
 */
export const MOCK_SPEC_VERSION = '2026-06-27.48';

/**
 * Fingerprint der EINGABEN, die den Mock bestimmen: Plugin-Code + deklarierter Vertrag (Options-Surface)
 * + verdrahtete Libs/CSS + Spec-Version. Gleicher Fingerprint = bekannte Version → KI-Untersuchung sparen
 * und den eingecheckten Mock wiederverwenden. Ändert sich Plugin-Quelle/Vertrag (oder unsere Logik) → neu.
 */
export function mockInputFingerprint(dir) {
  let c; try { c = collectMock(dir); } catch { return null; }
  const canon = JSON.stringify({
    spec: MOCK_SPEC_VERSION,
    plugin: (c.pluginFiles || []).map((p) => [p.name, p.code]).sort((a, b) => a[0] < b[0] ? -1 : 1),
    surface: c.optionSurface || '',
    libs: [...(c.libFiles || []), ...(c.extraLibFiles || [])].slice().sort(),
    css: (c.cssFiles || []).slice().sort(),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/**
 * Statischer Mock (Fallback ohne KI) — generisches Template.
 * @returns {{html, spec, libFiles, pluginFiles, selectors, entryPoints, mode:'static'}}
 */
export function generateMock(dir, opts = {}) {
  const name = opts.name || 'plugin';
  const c = collectMock(dir);
  const allLibs = [...c.libFiles, ...(c.extraLibFiles || [])]; // B-21: auch nicht-fingerprinted Libs (vanta/*) real laden
  const html = buildMockPage({ name, libFiles: allLibs, cssFiles: c.cssFiles || [], pluginFiles: c.pluginFiles.map((p) => p.name), selectors: c.selectors, entryPoints: c.entryPoints, events: c.events });
  return { html, spec: { name: `${slug(name)}.ui.spec.js`, content: buildMockSpec(name) }, libFiles: c.libFiles, extraLibFiles: c.extraLibFiles || [], cssFiles: c.cssFiles || [], pluginFiles: c.pluginFiles, selectors: c.selectors, entryPoints: c.entryPoints, mode: 'static' };
}

/**
 * Prompt der ANALYSE-Stufe: die KI untersucht NUR dieses Plugin (deklarierte Attribute + Quellcode) und
 * leitet daraus die zu testenden Sichten/Modes AB. Bewusst OHNE Beispiel-Modes von uns — was es an Modes
 * gibt, ist das Ergebnis der Analyse, nicht vorgegeben. Output: JSON-Array [{view, why, config}].
 */
export function aiAnalyzePrompt(name, c) {
  const src = (c.pluginFiles || []).map((p) => `// ${p.name}\n${p.code}`).join('\n\n').slice(0, 16000);
  return `You are a senior test engineer analyzing ONE Oracle APEX plugin to plan its characterization tests.
Plugin: ${name}

Your ONLY job: DISCOVER, from THIS plugin itself, the distinct configurations / modes / behaviors that need SEPARATE test coverage — then output them as a plan. Derive EVERY entry from the evidence below; do NOT assume any particular config format and do NOT invent capabilities the plugin lacks.

The plugin's OWN declared attributes (APEX standard contract — per attribute: prompt, type, allowed values, default value and help text). HOW this plugin exposes modes lives here: a select-list lists its values; a checkbox is a boolean mode; a free-text / JS / JSON config attribute documents its option keys and allowed values inside its default value & help text. Read them as the source of truth:
${c.optionSurface || '(no declared attributes found)'}

Plugin source (excerpt) — read it to see how each option is READ and which branches/modes/data states it drives (look for where option values are compared, switched on, or change rendering):
${src || '(none)'}

Enumerate EXHAUSTIVELY (not a sample), but ONLY modes THIS plugin actually has (evidence in the contract or source):
- one scenario per discrete value of every multi-valued option (take the values from the contract/source — an enum/numeric mode with N documented values ⇒ N scenarios),
- a scenario for each boolean option both ON and OFF where it changes behavior,
- the data states the source actually supports (e.g. static vs lazy/async, filtered/unfiltered, cached, empty, error),
- always include the plugin's default configuration as one scenario.

Output ONLY a JSON array (no prose, no markdown fences). Each element:
{ "view": "<short unique label>", "why": "<which option value or data state this exercises, citing the evidence>", "config": { <the concrete option values / data state for THIS scenario, exactly as the plugin expects them> } }
Cover the contract above completely. Start the response with [ and end with ].`;
}

/**
 * Führt die Analyse-Stufe aus: liefert den von der KI aus dem Plugin abgeleiteten Sichten-Plan
 * (Array {view, why, config}). Ohne KI/auf Fehler → [] (der Mock-Prompt plant dann selbst aus dem Vertrag).
 */
export async function analyzeViews(deps, name, c) {
  const ai = deps?.ai;
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function') return [];
  let out = '';
  try { out = String(await ai.complete(aiAnalyzePrompt(name, c), {})); } catch { return []; }
  out = out.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  const s = out.indexOf('['); const e = out.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  let arr; try { arr = JSON.parse(out.slice(s, e + 1)); } catch { return []; }
  return Array.isArray(arr) ? arr.filter((v) => v && typeof v.view === 'string' && v.view.trim()) : [];
}

/** Baut den Prompt, mit dem die KI einen plugin-spezifischen Mock schreibt (rein/testbar). */
export function aiMockPrompt(name, c) {
  const fns = (c.functions || []).slice(0, 40).map((f) => `${f.name}(${(f.params || []).join(', ')})${f.apexCalls?.length ? ' [apex: ' + f.apexCalls.slice(0, 6).join(', ') + ']' : ''}`).join('\n');
  const src = (c.pluginFiles || []).map((p) => `// ${p.name}\n${p.code}`).join('\n\n').slice(0, 14000);
  return `You are a senior test engineer. Write ONE self-contained HTML page that loads and INITIALIZES this Oracle APEX plugin in a plain browser (no real APEX), so its load behavior can be characterized.

Plugin: ${name}
Libraries to load FIRST, in this order, via <script src="<path>"> (use exactly these relative paths):
${(c.libFiles || []).map((f) => '  ' + f).join('\n') || '  (none)'}
Other REAL library files from the repo — these are ALREADY COPIED next to the page at EXACTLY these relative paths. Load the ones the plugin needs via <script src="<path>"> using these paths VERBATIM (relative to index.html — do NOT prepend "/" and do NOT add any "../"; e.g. write src="vanta/vanta.net.min.js", NOT "../../vanta/..."). Load them in correct dependency order (e.g. three.js BEFORE vanta/*; load every animation/feature module the plugin can use). NEVER reimplement these:
${(c.extraLibFiles || []).map((f) => '  ' + f).join('\n') || '  (none)'}
Plugin code files to load via <script src="plugin/<file>"> (already written next to the page):
${(c.pluginFiles || []).map((p) => '  ' + p.name).join('\n') || '  (none)'}
REAL CSS stylesheets of the plugin — ALREADY COPIED next to the page at EXACTLY these relative paths (their url(...) font/image assets are copied too). Load ALL of them via <link rel="stylesheet" href="<path>"> in the <head>, in this order, using the paths VERBATIM (no "/" prefix, no "../"). This is the plugin's REAL appearance — load it; do NOT hand-write/approximate the plugin's own styling (its layout/classes) inline. Inline <style> is ONLY for the harness chrome (status line) and the mock-root sizing, never to recreate the plugin's CSS:
${(c.cssFiles || []).map((f) => '  ' + f).join('\n') || '  (none)'}

Detected DOM selectors the plugin uses: ${(c.selectors || []).join(', ') || '(none)'}
Likely entry points: ${(c.entryPoints || []).join(', ') || '(none)'}
Detected interactions/events the plugin binds (trigger EACH on its element): ${(c.events || []).map((e) => e.type + '→' + e.selector).join(', ') || '(none)'}
DECLARED PLUGIN OPTIONS/ATTRIBUTES (the plugin's own capability contract — each is a configurable mode/feature to characterize): ${(c.attributes || []).join(' · ') || '(none)'}
OPTION/MODE SURFACE — the plugin's OWN declared attribute contract (prompt, type, allowed values, default, help text). This is where its modes live (a select-list's values, a checkbox's on/off, or the option keys + allowed values documented inside a free-text/JSON config attribute). Treat it as the source of truth for which modes exist:
${(c.optionSurface || '(none)').slice(0, 4500)}
${(c.viewPlan && c.viewPlan.length) ? `DISCOVERED VIEW PLAN — a prior analysis pass derived these distinct test scenarios FROM THIS PLUGIN. Render and self-test EXACTLY these views (do not drop any; you may add one only if you find a clear additional mode in the source). Each: view label, rationale, and the concrete config to apply:
${c.viewPlan.map((v, i) => `  ${i + 1}. ${v.view}${v.why ? ` — ${String(v.why).slice(0, 160)}` : ''}\n     config: ${JSON.stringify(v.config || {}).slice(0, 400)}`).join('\n')}` : ''}
Functions/signatures (with apex.* usage):
${fns || '(none)'}

Plugin source (excerpt):
${src}

Goal: a FUNCTIONAL mock that actually RENDERS the plugin WITH realistic sample data — not an empty mount. Study the source to understand how the plugin gets its data and what it produces, then feed it that data so its visual output appears.

HARD RULE — MOCK DATA, NEVER FUNCTIONALITY:
- You may ONLY mock/shim (a) the APEX runtime (apex.*, $v/$s) and (b) the DATA the plugin consumes. That's it.
- You must NOT fake, stub, reimplement or "shim" ANY library or the plugin's own behavior. Load the REAL library files listed above (they are in the repo / copied next to the page) and run the REAL plugin code. A faked library (e.g. drawing a static picture instead of running the real animation) is an INVALID mock.
- If the plugin needs a library that is genuinely NOT in the repo, load the real file from its official CDN (e.g. jsDelivr/unpkg) — do NOT reimplement it.
- LOAD PEER / TRANSITIVE DEPENDENCIES TOO, in the correct order: a library often needs ANOTHER library that is not vendored in this repo. A "$(...).somePlugin is not a function", a bare "X is not defined" / "X is not a function" (a required global/library is missing — e.g. a JSONPath/parser/util lib the plugin calls), or an explicit "X requires Y" error ALL mean a dependency is missing — load it: FIRST from the library list above (it is very likely already there and just needs a <script src>, loaded BEFORE the plugin code that uses it), otherwise from its official CDN. Common cases: a jQuery plugin needs jQuery first; jQuery-UI-based widgets (and Fancytree) need jQuery UI; an mxGraph/flow plugin may need a JSONPath lib; a plugin may need its theme/widget CSS. A "… is not defined" error is NEVER the plugin's characterized behavior — it is the mock failing to load a dependency. Inspect the error output and load EVERY dependency so the real plugin actually initializes and renders.
- The real library must actually DO its work: animations must really animate, interactions must really react. Mocking data is required; mocking functionality is forbidden.

Requirements for the page:
- STUDY THE DATA FLOW in the source: how does the plugin obtain data (apex.server.process / apex.jQuery.ajax / item values via $v/apex.item / plugin attributes/options / jsonpath over a JSON string)? What output does it build (e.g. an mxGraph flow chart, an SVG, a list)? Infer the exact data SHAPE it expects.
- PROVIDE REALISTIC SAMPLE DATA matching that shape so the plugin renders real content (e.g. a flow chart with several nodes + edges, or a kanban board with a few realistic cards per column). Use PLAUSIBLE, HUMAN-READABLE labels — real-ish titles/names/values (e.g. "Design login screen", "In Review", "Anna M.") — NEVER random gibberish AND NEVER joke/placeholder/meta strings (no "trustworthy text", "lorem", "test123", "foo/bar", or comments about the mock itself). The data must look like genuine domain content a real user would see. Make the apex shim return it: apex.server.process(name, opts) and apex.jQuery.ajax resolve/callback with a plausible response; set item values ($v/apex.item) and pass plausible plugin attributes/options to the init call. Embed the sample data inline.
- Provide a realistic apex.* shim covering the apex.* calls above (apex.item/$v/$s/apex.server.process/apex.jQuery/apex.message/apex.debug/apex.region/apex.util/etc.) so the plugin does not crash.
- Create the DOM the plugin needs: a visible <div id="mock-root"> mount (give it a real size, e.g. width:900px;height:560px) plus elements for the detected selectors. The plugin's rendered output MUST appear inside #mock-root.
- VISUAL QUALITY MATTERS — and THE PLUGIN MUST LOOK RIGHT BECAUSE ITS REAL CSS IS LOADED — NOT BECAUSE YOU PATCHED IT: load EVERY real CSS file listed above via <link> with the EXACT paths (a wrong path → 404 → broken/unstyled). A generic CSS reset (box-sizing + margins, APEX-like) is auto-injected before your stylesheets — rely on it, don't re-add one. Never hand-write/approximate the plugin's own classes to "fix" the look (that fakes it). Your ONLY layout job: give #mock-root a sensible size and the page enough height (it may scroll) so the whole plugin is visible. Load libs + plugin files via <script src> (exact paths, not inline); then init the plugin the way APEX would.
- Wrap initialization in try/catch; collect errors in window.__mockErrors (array); add window.onerror to push to it. Set window.__ok = (window.__mockErrors.length === 0). Set window.__rendered to true ONLY if the plugin produced its REAL output — i.e. the actual visual artifact has substance (an mxGraph/SVG with real shapes: rect/ellipse/path count > 0; a tree/list/board with real nodes/cards; etc.), NOT merely that #mock-root has some child or harness text. An empty graph (0 shapes) / empty list = __rendered MUST be false.
- THE PLUGIN MUST ACTUALLY RENDER — an empty/error render is a BROKEN MOCK, never a valid characterization. If the plugin produced no real output (empty SVG/graph/list, or it threw because a dependency/global was undefined), DO NOT write self-tests that assert that empty/error state as "green". Fix the mock first: load the missing library (see PEER/TRANSITIVE rule above), feed the correct data shape, and call the plugin the way APEX does — until the real output appears. Only THEN characterize the (working) behavior. A mock where every view is blank is wrong even if window.__ok is true.
- CHARACTERIZE THE PLUGIN AS IT IS — NOT AS IT SHOULD BE. This page is the "works EXACTLY as before" spec: after the libraries are updated the plugin must do the SAME — no more, no less. Therefore EVERY self-test must describe the CURRENT behavior of the unmodified plugin and MUST PASS right now. Do NOT invent aspirational/robustness checks the current plugin does not already satisfy (e.g. "handles missing/undefined input gracefully", error-handling or edge cases it was never built for). If a check would be RED against the current unmodified plugin, it is NOT a valid characterization — drop it, or if the behavior matters record the plugin's ACTUAL current result as the expected value. (This applies ONLY to the plugin's genuine domain logic — e.g. it deliberately rejects malformed user input. It does NOT apply to mock-setup failures: a "… is not defined"/missing-dependency error, an empty render, or a crash because you didn't load a library or feed data is a BROKEN MOCK to fix, NEVER a "characterized" behavior to assert green.) window.__ok MUST be true for the unmodified plugin; a failing self-test here means you mis-characterized, not that the plugin is broken.
- NEVER ASSERT A GUESSED CONSTANT FOR A VALUE/STATE/PROPERTY. Do not assume what an option resolves to, what a class/icon will be, how many nodes stay in the DOM, or what an internal state equals — READ the plugin's ACTUAL value at runtime (after init / after the action) and assert THAT exact observed value. The check exists to detect a CHANGE after migration, so derive its expected value from the live plugin, not from your expectation. Concretely: read the actual value from the real plugin/DOM/options now into a variable, then assert it equals that just-observed value (or, for "did X change" checks, snapshot before, act, compare after). If your hardcoded guess differs from what the unmodified plugin produces, the guess is wrong — use the observed value. A red here is a mis-read, never a plugin defect.
- PLAN MULTIPLE VIEWS / TEST SCENARIOS — one configuration is NOT enough; the default leaves most behavior unprotected. If a DISCOVERED VIEW PLAN is given above, implement EXACTLY those views (they were derived from this plugin's analysis). Otherwise go through the OPTION/MODE SURFACE + source SYSTEMATICALLY and plan a view for EVERY mode/value the plugin supports — EXHAUSTIVELY, not a sample: each discrete value of every multi-valued option, each boolean option on AND off where it changes behavior, plus the data states (static/lazy, filtered/unfiltered, cached, empty, error). Take the concrete modes/values from THIS plugin's own contract+source — never from generic examples, never invent capabilities it lacks, never skip ones it has. Render the plugin SEPARATELY per view (own mount + that view's config/data) so all are visible, and self-test EACH view independently. Expose the plan as window.__views = array of { view, config }.
- FIRST UNDERSTAND the plugin from the source: what it is, EVERY feature it offers, and how each one works. THEN make this page a SELF-TEST HARNESS that characterizes those features (ACROSS ALL planned views) as the spec a future migration must preserve. For EACH feature IN EACH view, run a check that ASSERTS its REAL EFFECT (not merely that code ran), e.g.:
   • render: #mock-root actually contains the expected output (the right number of nodes/cards/rows/svg etc.).
   • each interaction/event above: perform it and verify the resulting DOM change — e.g. a click toggles/opens the expected element; selection/sort/filter changes what is shown.
   • DRAG & DROP (and other pointer-driven gestures): inspect the source to see which mechanism the plugin actually listens for and reproduce EXACTLY that full sequence — HTML5 DnD (dragstart → dragenter → dragover → drop → dragend, all sharing ONE DataTransfer object) OR pointer/mouse events (pointerdown → pointermove(s) → pointerup, or mousedown → mousemove → mouseup, with realistic clientX/clientY on the right elements). Then verify the item really moved containers. IMPORTANT: synthetic drag is often NOT reliably triggerable in a headless harness even though it works for a real user. So if — after faithfully reproducing the real sequence — the move still cannot be observed, record this check as ok:true with detail "works for a real user; not reliably simulable headlessly — verify manually" — do NOT mark it failed. A feature that genuinely works must never be a red characterization.
   • ANIMATION (if the plugin animates, e.g. canvas/WebGL/SVG/CSS): verify it REALLY runs over time — capture the canvas/element state, wait ~300ms, capture again, and assert it CHANGED (a frozen/static frame = FAIL). The real library must be driving it, not a screenshot.
   • BUTTONS / mode switches (if the plugin has any, discovered from its source/markup): click EACH and assert it actually switches AND the new mode then animates/renders — not merely that the button exists.
   • each entry point and each main option/mode produces its expected result.
  Wrap every check in try/catch (non-fatal) and push ONE result per feature-and-view to window.__features = array of { view, feature, ok, detail } where ok is TRUE only if the effect really happened (false + detail otherwise) and view names which planned scenario it belongs to. Then set window.__selftested = true. These window.__features entries (across ALL views) ARE the test cases the migration must keep green — make them concrete and meaningful, covering every planned view and the plugin's real features (selection modes, filter, async, caching, drag & drop, etc.).
- KEEP THE VISIBLE STATE CLEAN: the self-tests must be NON-DESTRUCTIVE to the view. After all checks, the visible page MUST show the clean, correctly-rendered plugin with the original sample data — exactly what a user would see. Undo any mutation your tests caused (remove test-added cards/groups, restore toggles/collapses, move dragged items back), or run the checks on cloned/detached nodes. A screenshot taken at the end (for the visual "looks-as-before" gate) must show the tidy plugin, NOT a cluttered post-test board.
- Show a short visible status line (e.g. #mock-status) reporting __ok / __rendered, so a human opening the page sees whether it worked.
- Return ONLY the complete HTML document. Start the response DIRECTLY with <!DOCTYPE html> and end with </html>. Do NOT write any explanation, preamble or prose before or after the HTML, and no Markdown fences.`;
}

/**
 * KI-geschriebener, plugin-spezifischer Mock. Fällt bei fehlender/ungültiger KI-Antwort auf generateMock zurück.
 * @param {string} dir @param {{ai:object, name?:string}} deps
 */
/**
 * B-21: korrigiert lokale Lib-<script src> auf den echten relativen Pfad im Mock-Verzeichnis.
 * Die KI schreibt manchmal "../../vanta/x.min.js" oder "/vanta/x.min.js" — beides verfehlt die neben
 * der Seite kopierte Datei. Anhand des Dateinamens auf den bekannten Pfad zurücksetzen. CDN-/data:-URLs
 * (echte fehlende Libs) bleiben unangetastet — das Prinzip „echte Libs laden" bleibt gewahrt.
 */
export function normalizeLibPaths(html, relPaths) {
  const byBase = new Map();
  for (const p of relPaths || []) {
    const norm = String(p).replace(/\\/g, '/');
    const base = norm.split('/').pop();
    if (base) byBase.set(base.toLowerCase(), norm);
  }
  if (!byBase.size) return html;
  return html.replace(/(\s(?:src|href)\s*=\s*)("([^"]*)"|'([^']*)')/gi, (m, pre, _q, dq, sq) => {
    const val = dq !== undefined ? dq : sq;
    if (/^(https?:)?\/\//i.test(val) || /^data:/i.test(val) || /^#/.test(val)) return m; // CDN/protokoll-relativ/data:/Anker nicht anfassen
    const base = val.replace(/[?#].*$/, '').split('/').pop().toLowerCase();
    const correct = byBase.get(base);
    if (!correct || correct === val) return m;
    return `${pre}"${correct}"`;
  });
}

export async function generateAiMock(dir, deps = {}) {
  const name = deps.name || 'plugin';
  const c = collectMock(dir);
  const ai = deps.ai;
  const onStep = typeof deps.onStep === 'function' ? deps.onStep : () => {};
  const fallback = (reason) => ({ ...generateMock(dir, { name }), fallbackReason: reason });
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function') return fallback('no AI backend (Settings → Test connection)');
  // Analyse-Stufe zuerst: die KI leitet die zu testenden Sichten/Modes AUS DEM PLUGIN ab (kein Beispiel-Bias).
  onStep('Analyse (Sichten/Modes aus dem Plugin ableiten)');
  try { c.viewPlan = await analyzeViews(deps, name, c); } catch { c.viewPlan = []; }
  // Mock generieren; ein transienter KI-Fehlschlag (kein HTML/leer) wird EINMAL wiederholt, statt still
  // in den statischen Fallback zu kippen. Erst nach dem Retry geben wir den (sichtbaren) Fallback-Grund zurück.
  const attempts = Math.max(1, deps.attempts ?? 2);
  let lastErr = 'AI returned no usable HTML';
  for (let i = 1; i <= attempts; i++) {
    onStep(attempts > 1 ? `Mock generieren (Versuch ${i}/${attempts})` : 'Mock generieren');
    let raw = '';
    try { raw = String(await ai.complete(aiMockPrompt(name, c), {})); }
    catch (e) { lastErr = 'AI error: ' + (e?.message ?? e); continue; }
    const fin = finalizeAiHtml(raw, c);
    if (!fin.error) {
      return { html: fin.html, spec: { name: `${slug(name)}.ui.spec.js`, content: buildMockSpec(name) }, libFiles: c.libFiles, extraLibFiles: c.extraLibFiles || [], cssFiles: c.cssFiles || [], pluginFiles: c.pluginFiles, selectors: c.selectors, entryPoints: c.entryPoints, mode: 'ai', viewPlan: c.viewPlan || [] };
    }
    lastErr = fin.error;
  }
  return fallback(lastErr);
}

/**
 * Bereinigt eine KI-HTML-Antwort zum lauffähigen Mock: Markdown-Zäune weg, sauber <!doctype…</html>
 * extrahieren, lokale Lib-/CSS-Pfade normalisieren, Harness-Reset injizieren, __ok-Vertrag sicherstellen.
 * Genutzt von generateAiMock UND der Selbstkorrektur-Schleife (refineMock). @returns {{html}|{error}}
 */
export function finalizeAiHtml(raw, c = {}) {
  let html = String(raw || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  // Die KI stellt der HTML manchmal Prosa voran ("I now understand…"). Vom ersten <!doctype>/<html> bis zum letzten </html>.
  const low = html.toLowerCase();
  let s = low.indexOf('<!doctype'); if (s < 0) s = low.indexOf('<html');
  if (s > 0) html = html.slice(s);
  const e = html.toLowerCase().lastIndexOf('</html>');
  if (e >= 0) html = html.slice(0, e + 7);
  html = html.trim();
  if (!html) return { error: 'AI returned empty' };
  if (!/<html[\s>]/i.test(html)) return { error: 'AI response was not an HTML document' };
  html = normalizeLibPaths(html, [...(c.libFiles || []), ...(c.extraLibFiles || []), ...(c.cssFiles || [])]); // B-21: lokale Lib-/CSS-Pfade auf die kopierten Dateien zurücksetzen
  // Generischer CSS-Reset (wie APEX/Frameworks) als ERSTES im <head>, vor der echten Plugin-CSS → diese gewinnt.
  if (!/id=["']harness-reset["']/.test(html)) {
    const resetTag = `<style id="harness-reset">${HARNESS_RESET}</style>`;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + '\n  ' + resetTag);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + '\n<head>' + resetTag + '</head>');
    else html = resetTag + html;
  }
  if (!/__ok/.test(html)) { // gültige HTML ohne Vertrag → Vertrag injizieren statt verwerfen
    html = html.replace(/<\/body>/i, '<script>window.__mockErrors=window.__mockErrors||[];window.addEventListener("error",function(ev){window.__mockErrors.push(String(ev.message||ev));});if(typeof window.__ok==="undefined")window.__ok=(window.__mockErrors.length===0);</script></body>');
    if (!/__ok/.test(html)) return { error: 'AI HTML missing the window.__ok contract' };
  }
  return { html };
}

/**
 * Führt die Self-Tests des Mocks headless aus (Chromium) und liest das Charakterisierungs-Ergebnis aus:
 * window.__ok / __views / __features. launch ist injizierbar (Tests). @returns Ergebnis inkl. roter Checks.
 */
export async function runMockSelfTests(url, deps = {}) {
  if (!url) return { ran: false, reason: 'no url' };
  let launch = deps.launch;
  if (!launch) {
    try { const pw = await import('@playwright/test'); launch = () => pw.chromium.launch(); }
    catch { return { ran: false, reason: 'Playwright not installed' }; }
  }
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    // B-37: Probleme, die der Harness selbst nicht misst, direkt am Browser einsammeln — Konsole-Fehler,
    // uncaught Exceptions und fehlgeschlagene Ressourcen (404) sind ECHTE Mock-Probleme, auch wenn alle
    // Checks grün sind (sonst „0 failed", obwohl die Seite sichtbar Fehler zeigt → nie korrigiert).
    const consoleErrs = [];
    const badResponses = [];
    const instrumented = typeof page.on === 'function'; // Test-Fakes ohne Event-API überspringen die Zusatz-Checks
    if (instrumented) {
      page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + String(e?.message ?? e).slice(0, 200)));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)); });
      page.on('response', (r) => { try { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(-80)}`); } catch { /* egal */ } });
    }
    await page.goto(url, { waitUntil: 'load' });
    // auf die Selbst-Charakterisierung warten (async-Render/selftest), dann lesen
    await page.waitForFunction(() => window.__selftested === true || window.__ok === true, null, { timeout: deps.timeoutMs ?? 12000 }).catch(() => {});
    await page.waitForTimeout(300);
    const data = await page.evaluate(() => ({
      ok: window.__ok === true,
      rendered: window.__rendered === true,
      views: Array.isArray(window.__views) ? window.__views.length : 0,
      features: Array.isArray(window.__features) ? window.__features : [],
      errors: Array.isArray(window.__mockErrors) ? window.__mockErrors.map(String) : [],
    }));
    const feats = data.features || [];
    const failed = feats.filter((f) => f && f.ok === false).map((f) => ({ view: f.view, feature: f.feature, detail: f.detail }));
    // FALSCH-GRÜN aufspüren: ein „bestandener" Check, der in Wirklichkeit einen Dependency-/Ladefehler ODER
    // ein leeres Rendern beschreibt, ist KEINE gültige Charakterisierung — er muss korrigiert werden.
    const BROKEN = /is not defined|is not a function|is undefined|cannot read|threw before|empty (?:mx)?graph|empty svg|rect=0 ellipse=0 path=0|0 (?:nodes|cards|rows|shapes|cells)\b|nothing rendered|no .* rendered/i;
    const falseGreen = feats.filter((f) => f && f.ok !== false && BROKEN.test(String(f.detail || ''))).map((f) => ({ view: f.view, feature: f.feature, detail: f.detail }));
    const errBroken = (data.errors || []).filter((e) => /is not defined|is not a function|cannot read/i.test(e));
    const problems = [...failed, ...falseGreen];
    if (errBroken.length) problems.push({ view: 'global', feature: 'uncaught dependency error — a required library/global is missing, load it', detail: errBroken.slice(0, 3).join(' | ') });
    // B-37: sichtbare Fehler-Kacheln („Error occured"), Konsole-Fehler und 404-Ressourcen sind Probleme,
    // auch wenn alle Checks grün melden — sie gehen als Korrektur-Auftrag in die Refine-Schleife.
    const errorTiles = !instrumented ? 0 : await page.evaluate(() => [...document.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && !/^(SCRIPT|STYLE)$/.test(e.tagName) && /\berror occurr?ed\b/i.test(e.textContent || '')).length).catch(() => 0);
    if (errorTiles) problems.push({ view: 'global', feature: `${errorTiles} visible error tile(s) ("Error occured") — the plugin renders an error state; fix the mock config/data/feature activation so the REAL content appears instead`, detail: `${errorTiles} error tile(s) in the DOM` });
    const consoleBroken = [...new Set(consoleErrs)].filter((e) => !/favicon/i.test(e));
    if (consoleBroken.length) problems.push({ view: 'global', feature: 'console errors during render — resolve them in the mock (missing feature activation, wrong config, missing library)', detail: consoleBroken.slice(0, 3).join(' | ') });
    const badRes = [...new Set(badResponses)].filter((e) => !/favicon/i.test(e));
    if (badRes.length) problems.push({ view: 'global', feature: 'failed resource loads (HTTP >= 400) — fix the paths or inline the resources in the mock', detail: badRes.slice(0, 3).join(' | ') });
    return { ran: true, ok: data.ok, rendered: data.rendered, views: data.views, total: feats.length, features: feats, failed, errors: data.errors, falseGreen, consoleErrors: consoleBroken, badResponses: badRes, errorTiles, problems };
  } catch (e) {
    return { ran: false, reason: String(e?.message ?? e) };
  } finally {
    try { await browser?.close(); } catch { /* egal */ }
  }
}

/** Prompt der KORREKTUR-Stufe: rote Checks UND falsch-grüne (Dependency-/Leer-Render-)Probleme → fixen. */
export function aiRefinePrompt(name, html, problems, opts = {}) {
  const list = (problems || []).map((f, i) => `${i + 1}. [view: ${f.view}] ${f.feature}\n   observed: ${String(f.detail || '').slice(0, 220)}`).join('\n');
  const renderWarn = opts.rendered === false ? '\nIMPORTANT: window.__rendered is FALSE — the plugin currently produces NO real output. The mock is broken (a missing library/global or wrong data), not the plugin.' : '';
  return `You wrote this self-testing characterization mock for the Oracle APEX plugin "${name}". Running it against the UNMODIFIED plugin, these problems remain:
${list}${renderWarn}

This page is the "works exactly as before" baseline: the REAL plugin must actually run and render, and every self-test must be green by reflecting that real behavior. Two kinds of problems and how to fix each:

A) A "… is not defined" / "is not a function" / missing-dependency error, an empty render (empty mxGraph/SVG with 0 shapes, empty list/board), or "threw before … rendered": this is a BROKEN MOCK, not characterized behavior. FIX the mock — do NOT assert the error/emptiness as green:
   - Load the missing library/global with a <script src> BEFORE the plugin code. It is most likely already in the page's lib list (e.g. a JSONPath/parser/util lib) — just add the script tag in the right order; otherwise load it from an official CDN.
   - Feed the correct data shape and call the plugin the way APEX does, so the real visual output appears (the SVG/graph has real shapes, the list/board has real items). Use realistic, human-readable data — never joke/placeholder strings.
   - Set window.__rendered true ONLY when the real output is actually present.

B) A genuinely RED check (wrong expected value): read the REAL current value/state from the live plugin/DOM/options and assert THAT exact observed value (never a guessed constant). If a check tests something the plugin does not do, DROP it.

Keep EVERYTHING else identical: all existing views, the real <script>/<link> tags and paths, the apex shim, the non-destructive cleanup, and the window.__ok/__rendered/__views/__features/__selftested contract.

Return ONLY the complete corrected HTML document, starting at <!DOCTYPE html> and ending at </html>. No prose, no markdown fences.`;
}

/**
 * Selbstkorrektur-Schleife: führt die Self-Tests aus; bei roten Checks lässt die KI den Mock nachbessern
 * (Ist-Werte statt geratener Konstanten), schreibt neu und prüft erneut — bis grün oder keine Besserung.
 * @param {{ai,url,name,write:(html)=>void,maxRounds?,launch?,timeoutMs?,log?}} deps
 * @returns {Promise<{rounds, before, after, html, failed}>}
 */
export async function refineMock(gen, deps = {}) {
  const { ai, url, name, write, launch, timeoutMs } = deps;
  const maxRounds = deps.maxRounds ?? 3;
  const log = deps.log || (() => {});
  const probsOf = (st) => (st.problems || st.failed || []); // rot + falsch-grün + Dependency-Fehler
  let html = gen.html;
  let first = null;
  let last = null;
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function' || !url || gen.mode !== 'ai') return { rounds: 0, before: null, after: null, html, failed: [] };
  for (let round = 1; round <= maxRounds; round++) {
    const st = await runMockSelfTests(url, { launch, timeoutMs });
    if (!st.ran) { log(`Self-Test nicht ausführbar (${st.reason}) — Korrektur übersprungen`); break; }
    if (first === null) first = st;
    last = st;
    const probs = probsOf(st);
    const extra = (st.falseGreen?.length || 0) || (st.rendered === false ? 1 : 0);
    if (!probs.length && st.rendered !== false) { log(`Self-Korrektur: alle ${st.total} Checks grün, Plugin rendert echt (${st.views} Sichten)`); break; }
    const note = st.falseGreen?.length ? ` (davon ${st.falseGreen.length} falsch-grün: Dependency/leeres Rendern)` : (st.rendered === false ? ' (Plugin rendert NICHTS — Dependency/Daten fehlen)' : '');
    log(`Self-Korrektur Runde ${round}: ${probs.length || extra} Problem(e)${note} → KI bessert nach`);
    let raw;
    try { raw = String(await ai.complete(aiRefinePrompt(name, html, probs.length ? probs : [{ view: 'global', feature: 'plugin renders no real output', detail: 'load missing libs + feed data so the plugin truly renders' }], { rendered: st.rendered }), {})); }
    catch (e) { log(`Korrektur-KI-Fehler: ${e?.message ?? e}`); break; }
    const fin = finalizeAiHtml(raw, gen);
    if (fin.error) { log(`Korrektur verworfen: ${fin.error}`); break; }
    const prev = probs.length;
    html = fin.html; write(html);
    if (round === maxRounds) { const fst = await runMockSelfTests(url, { launch, timeoutMs }); if (fst.ran) { last = fst; if (probsOf(fst).length >= prev) log('Self-Korrektur: keine weitere Besserung'); } }
  }
  return { rounds: (first ? 1 : 0), before: first, after: last, html, failed: last ? probsOf(last) : [] };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'plugin';

/** Schreibt den Mock (index.html + benötigte Lib-Dateien) in mockDir. */
export function writeMock(mockDir, repoDir, gen) {
  fs.mkdirSync(mockDir, { recursive: true });
  for (const rel of [...(gen.libFiles || []), ...(gen.extraLibFiles || [])]) { // B-21: echte Libs (inkl. nicht-fingerprinted) mitkopieren
    try {
      const src = path.join(repoDir, rel);
      const dst = path.join(mockDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch { /* Lib fehlt → Mock lädt sie eben nicht */ }
  }
  // Echte CSS + ihre per url(...) referenzierten Assets (Fonts/Bilder) mitkopieren — Optik „wie zuvor", generisch.
  const copyRel = (rel) => { try { const src = path.join(repoDir, rel); const dst = path.join(mockDir, rel); if (!fs.existsSync(src)) return; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } catch { /* skip */ } };
  for (const rel of gen.cssFiles || []) {
    copyRel(rel);
    try {
      const css = fs.readFileSync(path.join(repoDir, rel), 'utf8');
      const cssDir = path.posix.dirname(rel.replace(/\\/g, '/'));
      for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        const u = m[1].trim();
        if (/^(https?:)?\/\//i.test(u) || /^data:/i.test(u) || u.startsWith('#')) continue; // CDN/data:/Anker überspringen
        const assetRel = path.posix.normalize(path.posix.join(cssDir, u.replace(/[?#].*$/, ''))); // relativ zur CSS-Datei
        if (assetRel.startsWith('..')) continue; // außerhalb des Repos
        copyRel(assetRel);
      }
    } catch { /* best effort */ }
  }
  for (const pf of gen.pluginFiles || []) {
    try { const dst = path.join(mockDir, pf.name); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, pf.code); } catch { /* skip */ }
  }
  fs.writeFileSync(path.join(mockDir, 'index.html'), gen.html);
  return path.join(mockDir, 'index.html');
}
