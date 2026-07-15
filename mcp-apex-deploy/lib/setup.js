/**
 * setup.js — richtet eine Testseite AUSSCHLIESSLICH anhand des Setup-Manifests (buildSetupManifest) ein.
 *
 * Damit ist der apex-deploy-MCP standalone/wiederverwendbar: JSON („Rezept") rein → Testseite in APEX raus.
 * Der Ablauf (optional Plugin-Install → File URLs → Testseite im Page Designer aus dem Manifest → Render-
 * Smoke-Test) liest ALLES aus dem Manifest; es wird nichts neu „gedacht". Alle Browser-Bausteine sind
 * injizierbar → ohne echten Browser/Instanz unit-testbar. Secrets (Passwort) kommen vom Aufrufer, nie geloggt.
 *
 * Resultat: mcp-apex-deploy/lib/setup.js
 */

import { loadChromium, uiLogin, uiImportFile, uiSetPluginFileUrls, uiCreateTestPage, uiCreateItemTestPage, uiCreateDynamicActionTestPage, uiCreateTemplateComponentTestPage, smokeCheckPage } from './apex-ui.js';

const clean = (v) => String(v ?? '').replace(/[\x00-\x1f]+/g, ' ');

/**
 * @param {object} manifest  Ausgabe von buildSetupManifest (plugin/testPage/attributes/fileUrls)
 * @param {{baseUrl,workspace,user,pass,appId,alias?}} connection  Ziel-APEX + Login (Passwort nie geloggt)
 * @param {{pageId?:number, sourceSql?:string, install?:string, setFileUrls?:boolean, cwd?:string, settleMs?:number}} [o]
 *   install = Pfad zum Plugin-Export (.sql) → Plugin wird zuerst über die Plug-ins-UI installiert.
 * @param {object} [deps]  injizierbar (Default: echte apex-ui-Funktionen)
 */
export async function setupFromManifest(manifest, connection, o = {}, deps = {}) {
  const d = { loadChromium, uiLogin, uiImportFile, uiSetPluginFileUrls, uiCreateTestPage, uiCreateItemTestPage, uiCreateDynamicActionTestPage, uiCreateTemplateComponentTestPage, smokeCheckPage, ...deps };
  const m = manifest || {};
  if (!m.plugin || !m.plugin.internalName) return { ok: false, error: 'Manifest ohne plugin.internalName.' };
  const c = connection || {};
  if (!c.baseUrl || !c.workspace || !c.user || !c.pass || !c.appId) {
    return { ok: false, error: 'Connection incomplete (baseUrl/workspace/user/password/appId).' };
  }
  const cfg = { baseUrl: c.baseUrl, workspace: c.workspace, user: c.user, pass: c.pass };
  const pageId = Number(o.pageId ?? m.testPage?.id ?? 20000);
  const displayName = m.plugin.displayName || m.plugin.internalName;
  const regionName = m.testPage?.region?.name || `Test: ${m.plugin.internalName}`;
  const pageName = m.testPage?.name || `Live-Test: ${m.plugin.internalName}`;
  const sourceSql = o.sourceSql || m.testPage?.source?.sql || undefined;
  const attributes = (m.attributes || [])
    .filter((a) => a && a.prompt && a.default != null && a.default !== '')
    .map((a) => ({ prompt: a.prompt, value: clean(a.default) }));

  const chromium = await d.loadChromium(o.cwd || process.cwd());
  if (!chromium) return { ok: false, error: 'Playwright not installed — setup not possible.' };
  const browser = await chromium.launch({ headless: true });
  const result = { ok: false, plugin: m.plugin.internalName, appId: Number(c.appId), pageId };
  try {
    const page = await browser.newPage();
    const login = await d.uiLogin(page, cfg);
    result.login = { ok: login.ok, error: login.error };
    if (!login.ok) return result;

    // 1) Optional: Plugin installieren (app-interner Plug-in-Import) — nötig, damit der Region-Typ existiert.
    if (o.install) result.install = await d.uiImportFile(page, o.install, { appId: c.appId, viaPlugins: true });

    // 2) File URLs to Load (JS+CSS) aus dem Manifest setzen. B-38: lädt das Plugin seine Files SELBST
    //    (selfLoadsFiles), werden KEINE URLs gesetzt und fälschlich vorhandene GELEERT (Doppel-Ladung
    //    „Identifier … has already been declared" beheben).
    const js = m.fileUrls?.js || [], css = m.fileUrls?.css || [];
    if (o.setFileUrls !== false && m.plugin?.selfLoadsFiles) {
      result.fileUrls = await d.uiSetPluginFileUrls(page, { appId: c.appId, displayName, jsUrls: [], cssUrls: [], clear: true });
      result.fileUrls.note = 'Plugin lädt seine Files selbst (ADD_LIBRARY) — File URLs geleert statt gesetzt.';
    } else if (o.setFileUrls !== false && (js.length || css.length)) {
      result.fileUrls = await d.uiSetPluginFileUrls(page, { appId: c.appId, displayName, jsUrls: js, cssUrls: css });
    }

    // 3) Testseite im Page Designer aus dem Manifest bauen — abhängig vom Plugin-TYP.
    //    region = Plugin-Region · item = Page-Item vom Plugin-Typ in einer Host-Region (beide automatisiert).
    //    dynamic-action/template-component = eigener Aufbau, noch nicht automatisiert → Plugin ist installiert
    //    + File-URLs gesetzt, aber keine Testseite gebaut (ehrlich gemeldet).
    const kind = m.plugin?.kind || m.testPage?.setupKind || 'region';
    const automated = ['region', 'item', 'dynamic-action', 'template-component'];
    if (!automated.includes(kind)) {
      result.testPage = { ok: false, setupKind: kind, error: `Test-page setup for type "${kind}" (${m.plugin?.pluginType || '?'}) is not yet automated — currently automated: ${automated.map((k) => `"${k}"`).join(', ')}. The plugin was installed${result.fileUrls ? ' and the file URLs were set' : ''}.` };
      result.render = { rendered: false, note: `No auto-render for type "${kind}".` };
      return result;
    }
    const pdPage = await browser.newPage();
    const pdLogin = await d.uiLogin(pdPage, cfg);
    if (!pdLogin.ok) {
      result.testPage = { ok: false, error: 'Login for the Page Designer step failed.' };
    } else if (kind === 'item') {
      const itemName = m.testPage?.item?.name || `P${pageId}_ITEM`;
      const hostRegionName = m.testPage?.item?.hostRegion || 'Host';
      result.testPage = await d.uiCreateItemTestPage(pdPage, { appId: c.appId, pageId, pageName, pluginDisplayName: displayName, itemName, hostRegionName, attributes });
    } else if (kind === 'dynamic-action') {
      const da = m.testPage?.dynamicAction || {};
      result.testPage = await d.uiCreateDynamicActionTestPage(pdPage, { appId: c.appId, pageId, pageName, pluginDisplayName: displayName, event: da.event, selectionType: da.selectionType, selector: da.selector, attributes });
    } else if (kind === 'template-component') {
      const tc = m.testPage?.templateComponent || {};
      result.testPage = await d.uiCreateTemplateComponentTestPage(pdPage, { appId: c.appId, pageId, pageName, pluginDisplayName: displayName, regionName: tc.region?.name || regionName, sourceSql: tc.source?.sql || sourceSql, columnMap: tc.columnMap, attributes });
    } else {
      // T-149: benötigte Page-Items (Mehrzahl) + „Items to Submit" durchreichen; rückwärtskompatibel zu
      // altem Einzel-pageItem (→ als einelementige Liste behandeln).
      const pageItems = m.testPage?.pageItems || (m.testPage?.pageItem ? [m.testPage.pageItem] : []);
      const itemsToSubmit = m.testPage?.itemsToSubmit || pageItems.filter((i) => i?.ajaxItemsToSubmit).map((i) => i.name);
      // T-150: createPageItems ist opt-in (Default aus → sichere read-only Bestandsaufnahme). Erst mit
      // c.createPageItems=true legt uiCreateTestPage fehlende Items transaction-sicher an (Live-Verifikation).
      result.testPage = await d.uiCreateTestPage(pdPage, { appId: c.appId, pageId, pageName, pluginDisplayName: displayName, regionName, sourceSql, attributes, pageItems, itemsToSubmit, createPageItems: c.createPageItems });
    }
    await pdPage.close().catch(() => {});

    // 4) Render-Smoke-Test über die Friendly-URL (öffentliche Testseite).
    const base = String(c.baseUrl).replace(/\/$/, '');
    const url = c.alias ? `${base}/r/${String(c.workspace).toLowerCase()}/${c.alias}/${pageId}` : `${base}/f?p=${c.appId}:${pageId}`;
    const rt = await browser.newPage();
    const errors = [];
    rt.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
    rt.on('console', (mm) => { if (mm.type() === 'error') errors.push(mm.text()); });
    await rt.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    result.render = await d.smokeCheckPage(rt, errors, { settleMs: o.settleMs, expectMarker: m.plugin.internalName });
    result.render.url = url;

    result.ok = !!(result.testPage?.ok && result.render?.rendered);
    return result;
  } finally { await browser.close(); }
}
