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
import { detectVendoredLibraries } from '../sbom/vendored.js';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { isLibraryFile } from '../inventory/format.js';
import { analyzeDeep } from './analyze-deep.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Erzeugt ein DOM-Element für einen erkannten Selektor (#id bzw. .class), sichtbar. */
function domFor(sel) {
  const s = String(sel || '').trim();
  if (/^#[\w-]+$/.test(s)) return `<div id="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  if (/^\.[\w-]+$/.test(s)) return `<div class="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  return '';
}

/** Self-contained Mock-Seite (rein). libFiles + pluginFiles werden via <script src> geladen (relativ). */
export function buildMockPage({ name = 'plugin', libFiles = [], pluginFiles = [], selectors = [], entryPoints = [], events = [] } = {}) {
  const dom = [...new Set(selectors.map(domFor).filter(Boolean))].join('\n      ');
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
<html><head><meta charset="utf-8"><title>Mock — ${esc(name)}</title></head>
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

/**
 * Sammelt aus dem Repo, was der Mock braucht: Lib-Dateien, Plugin-Dateien (extern), Analyse.
 * @returns {{libFiles:string[], pluginFiles:{name:string,code:string}[], selectors:string[], entryPoints:string[], functions:object[]}}
 */
export function collectMock(dir) {
  const libs = detectVendoredLibraries(dir).filter((l) => l.evidence && /\.js$/i.test(l.evidence));
  const libFiles = libs.map((l) => l.evidence);
  const libSet = new Set(libFiles);
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
  return { libFiles, pluginFiles, selectors: [...selectors], entryPoints: [...entryPoints], functions, events: [...events.values()] };
}

/**
 * Statischer Mock (Fallback ohne KI) — generisches Template.
 * @returns {{html, spec, libFiles, pluginFiles, selectors, entryPoints, mode:'static'}}
 */
export function generateMock(dir, opts = {}) {
  const name = opts.name || 'plugin';
  const c = collectMock(dir);
  const html = buildMockPage({ name, libFiles: c.libFiles, pluginFiles: c.pluginFiles.map((p) => p.name), selectors: c.selectors, entryPoints: c.entryPoints, events: c.events });
  return { html, spec: { name: `${slug(name)}.ui.spec.js`, content: buildMockSpec(name) }, libFiles: c.libFiles, pluginFiles: c.pluginFiles, selectors: c.selectors, entryPoints: c.entryPoints, mode: 'static' };
}

/** Baut den Prompt, mit dem die KI einen plugin-spezifischen Mock schreibt (rein/testbar). */
export function aiMockPrompt(name, c) {
  const fns = (c.functions || []).slice(0, 40).map((f) => `${f.name}(${(f.params || []).join(', ')})${f.apexCalls?.length ? ' [apex: ' + f.apexCalls.slice(0, 6).join(', ') + ']' : ''}`).join('\n');
  const src = (c.pluginFiles || []).map((p) => `// ${p.name}\n${p.code}`).join('\n\n').slice(0, 14000);
  return `You are a senior test engineer. Write ONE self-contained HTML page that loads and INITIALIZES this Oracle APEX plugin in a plain browser (no real APEX), so its load behavior can be characterized.

Plugin: ${name}
Libraries to load FIRST, in this order, via <script src="<path>"> (use exactly these relative paths):
${(c.libFiles || []).map((f) => '  ' + f).join('\n') || '  (none)'}
Plugin code files to load via <script src="plugin/<file>"> (already written next to the page):
${(c.pluginFiles || []).map((p) => '  ' + p.name).join('\n') || '  (none)'}

Detected DOM selectors the plugin uses: ${(c.selectors || []).join(', ') || '(none)'}
Likely entry points: ${(c.entryPoints || []).join(', ') || '(none)'}
Detected interactions/events the plugin binds (trigger EACH on its element): ${(c.events || []).map((e) => e.type + '→' + e.selector).join(', ') || '(none)'}
Functions/signatures (with apex.* usage):
${fns || '(none)'}

Plugin source (excerpt):
${src}

Goal: a FUNCTIONAL mock that actually RENDERS the plugin WITH realistic sample data — not an empty mount. Study the source to understand how the plugin gets its data and what it produces, then feed it that data so its visual output appears.

Requirements for the page:
- STUDY THE DATA FLOW in the source: how does the plugin obtain data (apex.server.process / apex.jQuery.ajax / item values via $v/apex.item / plugin attributes/options / jsonpath over a JSON string)? What output does it build (e.g. an mxGraph flow chart, an SVG, a list)? Infer the exact data SHAPE it expects.
- PROVIDE REALISTIC SAMPLE DATA matching that shape so the plugin renders real content (e.g. a flow chart with several nodes + edges). Make the apex shim return it: apex.server.process(name, opts) and apex.jQuery.ajax resolve/callback with a plausible response; set item values ($v/apex.item) and pass plausible plugin attributes/options to the init call. Embed the sample data inline.
- Provide a realistic apex.* shim covering the apex.* calls above (apex.item/$v/$s/apex.server.process/apex.jQuery/apex.message/apex.debug/apex.region/apex.util/etc.) so the plugin does not crash.
- Create the DOM the plugin needs: a visible <div id="mock-root"> mount (give it a real size, e.g. width:600px;height:400px) plus elements for the detected selectors. The plugin's rendered output MUST appear inside #mock-root.
- Load libraries and plugin files via <script src> (NOT inline) using the exact paths above; then initialize the plugin the way APEX would.
- Wrap initialization in try/catch; collect errors in window.__mockErrors (array); add window.onerror to push to it. Set window.__ok = (window.__mockErrors.length === 0). Also set window.__rendered = (document.querySelector('#mock-root') has non-trivial child content, i.e. the plugin produced output).
- FIRST UNDERSTAND the plugin from the source: what it is, EVERY feature it offers, and how each one works. THEN make this page a SELF-TEST HARNESS that characterizes those features as the spec a future migration must preserve. For EACH feature, run a check that ASSERTS its REAL EFFECT (not merely that code ran), e.g.:
   • render: #mock-root actually contains the expected output (the right number of nodes/cards/rows/svg etc.).
   • each interaction/event above: perform it and verify the resulting DOM change — e.g. DRAG & DROP actually moves an item into another container; a click toggles/opens the expected element; selection/sort/filter changes what is shown.
   • each entry point and each main option/mode produces its expected result.
  Wrap every check in try/catch (non-fatal) and push ONE result per feature to window.__features = array of { feature, ok, detail } where ok is TRUE only if the effect really happened (false + detail otherwise). Then set window.__selftested = true. These window.__features entries ARE the test cases the migration must keep green — make them concrete and meaningful, covering drag & drop and the plugin's other real features.
- Show a short visible status line (e.g. #mock-status) reporting __ok / __rendered, so a human opening the page sees whether it worked.
- Return ONLY the complete HTML document. Start the response DIRECTLY with <!DOCTYPE html> and end with </html>. Do NOT write any explanation, preamble or prose before or after the HTML, and no Markdown fences.`;
}

/**
 * KI-geschriebener, plugin-spezifischer Mock. Fällt bei fehlender/ungültiger KI-Antwort auf generateMock zurück.
 * @param {string} dir @param {{ai:object, name?:string}} deps
 */
export async function generateAiMock(dir, deps = {}) {
  const name = deps.name || 'plugin';
  const c = collectMock(dir);
  const ai = deps.ai;
  const fallback = (reason) => ({ ...generateMock(dir, { name }), fallbackReason: reason });
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function') return fallback('no AI backend (Settings → Test connection)');
  let html = '';
  try { html = String(await ai.complete(aiMockPrompt(name, c), {})); }
  catch (e) { return fallback('AI error: ' + (e?.message ?? e)); }
  html = html.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  // Die KI stellt der HTML manchmal Prosa voran ("I now understand…"). Sauber das Dokument extrahieren:
  // vom ersten <!doctype>/<html> bis zum letzten </html>.
  const low = html.toLowerCase();
  let s = low.indexOf('<!doctype'); if (s < 0) s = low.indexOf('<html');
  if (s > 0) html = html.slice(s);
  const e = html.toLowerCase().lastIndexOf('</html>');
  if (e >= 0) html = html.slice(0, e + 7);
  html = html.trim();
  if (!html) return fallback('AI returned empty');
  if (!/<html[\s>]/i.test(html)) return fallback('AI response was not an HTML document');
  if (!/__ok/.test(html)) { // gültige HTML ohne Vertrag → Vertrag injizieren statt verwerfen
    html = html.replace(/<\/body>/i, '<script>window.__mockErrors=window.__mockErrors||[];window.addEventListener("error",function(ev){window.__mockErrors.push(String(ev.message||ev));});if(typeof window.__ok==="undefined")window.__ok=(window.__mockErrors.length===0);</script></body>');
    if (!/__ok/.test(html)) return fallback('AI HTML missing the window.__ok contract');
  }
  return { html, spec: { name: `${slug(name)}.ui.spec.js`, content: buildMockSpec(name) }, libFiles: c.libFiles, pluginFiles: c.pluginFiles, selectors: c.selectors, entryPoints: c.entryPoints, mode: 'ai' };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'plugin';

/** Schreibt den Mock (index.html + benötigte Lib-Dateien) in mockDir. */
export function writeMock(mockDir, repoDir, gen) {
  fs.mkdirSync(mockDir, { recursive: true });
  for (const rel of gen.libFiles) {
    try {
      const src = path.join(repoDir, rel);
      const dst = path.join(mockDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch { /* Lib fehlt → Mock lädt sie eben nicht */ }
  }
  for (const pf of gen.pluginFiles || []) {
    try { const dst = path.join(mockDir, pf.name); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, pf.code); } catch { /* skip */ }
  }
  fs.writeFileSync(path.join(mockDir, 'index.html'), gen.html);
  return path.join(mockDir, 'index.html');
}
