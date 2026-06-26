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
import { inspectAssets } from '../extract/assets.js';
import { analyzeDeep } from './analyze-deep.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Erzeugt ein DOM-Element für einen erkannten Selektor (#id bzw. .class), sichtbar. */
function domFor(sel) {
  const s = String(sel || '').trim();
  if (/^#[\w-]+$/.test(s)) return `<div id="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  if (/^\.[\w-]+$/.test(s)) return `<div class="${esc(s.slice(1))}" style="width:120px;height:40px">mock</div>`;
  return '';
}

/** Self-contained Mock-Seite (rein). libFiles relativ zur Seite; pluginScripts inline. */
export function buildMockPage({ name = 'plugin', libFiles = [], pluginScripts = [], selectors = [], entryPoints = [] } = {}) {
  const dom = [...new Set(selectors.map(domFor).filter(Boolean))].join('\n      ');
  const libTags = libFiles.map((f) => `<script src="${esc(f)}"></script>`).join('\n    ');
  const plugin = pluginScripts.map((code) => `<script>\ntry{\n${code}\n}catch(e){ window.__mockErrors.push('plugin: '+(e&&e.message||e)); }\n</script>`).join('\n');
  const entry = entryPoints.map((fn) => `  try{ if(typeof ${fn}==='function'){ ${fn}(); } }catch(e){ window.__mockErrors.push('${esc(fn)}: '+(e&&e.message||e)); }`).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock — ${esc(name)}</title></head>
<body>
  <h3>Mock harness — ${esc(name)}</h3>
  <p class="muted">Self-contained test page (apex shim + libs + plugin). For manual testing &amp; the works-as-before baseline.</p>
  <div id="mock-root" style="width:200px;height:60px;border:1px solid #888">plugin mount</div>
      ${dom}
  <script>window.__mockErrors=[]; window.onerror=function(m){ window.__mockErrors.push(String(m)); };</script>
    ${libTags}
  <script>
    // Minimaler apex-Shim (nach den Libs, damit jQuery verfügbar ist)
    window.apex = window.apex || {};
    apex.jQuery = window.jQuery || window.$ || undefined; window.$ = window.$ || window.jQuery;
    apex.item = function(){ return { getValue:function(){return '';}, setValue:function(){}, hide:function(){}, show:function(){} }; };
    apex.region = function(){ return { refresh:function(){}, widget:function(){return {};} }; };
    apex.submit = function(){}; apex.debug = function(){}; apex.message = { clearErrors:function(){}, showErrors:function(){}, alert:function(){}, confirm:function(){} };
    apex.server = { process:function(){ return Promise.resolve({}); }, plugin:function(){ return Promise.resolve({}); } };
    apex.util = { escapeHTML:function(s){return String(s==null?'':s);}, debounce:function(f){return f;} };
    apex.env = {}; apex.theme = { defaultStickyTop:function(){return 0;} }; apex.widget = {};
  </script>
${plugin}
  <script>
${entry}
    window.__ok = (window.__mockErrors.length === 0);
  </script>
</body></html>`;
}

/** Playwright-Spec, der den Mock prüft: lädt fehlerfrei (window.__ok) + Mount sichtbar. */
export function buildMockSpec(name = 'plugin') {
  return `import { test, expect } from '@playwright/test';
const URL = process.env.PLUGIN_URL;
test('mock loads the plugin without JS errors (works as before)', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await expect(page.locator('#mock-root')).toBeVisible();
  const ok = await page.evaluate(() => window.__ok === true);
  const mockErrors = await page.evaluate(() => window.__mockErrors || []);
  expect(errors, errors.join('\\n')).toEqual([]);
  expect(ok, 'plugin reported load errors: ' + JSON.stringify(mockErrors)).toBe(true);
});`;
}

/**
 * Sammelt aus dem Repo, was der Mock braucht.
 * @returns {{html:string, spec:{name:string,content:string}, libFiles:string[], selectors:string[], entryPoints:string[]}}
 */
export function generateMock(dir, opts = {}) {
  const name = opts.name || 'plugin';
  const libs = detectVendoredLibraries(dir).filter((l) => l.evidence && /\.js$/i.test(l.evidence));
  const libFiles = libs.map((l) => l.evidence);
  const libSet = new Set(libFiles);
  // Plugin-Eigencode = extrahierte JS/Inline-Assets, die KEINE vendored Lib-Datei sind
  let pluginScripts = [];
  const selectors = new Set();
  const entryPoints = new Set();
  try {
    for (const a of inspectAssets(dir)) {
      const isLib = a.origin?.type === 'file' && libSet.has(String(a.origin.path).replace(/\\/g, '/'));
      if (isLib) continue;
      if (a.code && a.code.length < 200000) pluginScripts.push(a.code); // riesige Bundles auslassen
      const deep = analyzeDeep(a.code || '');
      for (const s of deep.selectors || []) selectors.add(s);
      for (const f of deep.functions || []) if (f.name && /^(init|refresh|render|draw|setup|load|create|destroy)/i.test(f.name)) entryPoints.add(f.name);
    }
  } catch { /* best effort */ }
  const html = buildMockPage({ name, libFiles, pluginScripts, selectors: [...selectors], entryPoints: [...entryPoints] });
  return { html, spec: { name: `${slug(name)}.ui.spec.js`, content: buildMockSpec(name) }, libFiles, selectors: [...selectors], entryPoints: [...entryPoints] };
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
  fs.writeFileSync(path.join(mockDir, 'index.html'), gen.html);
  return path.join(mockDir, 'index.html');
}
