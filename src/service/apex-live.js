/**
 * T-135 — Plugin Maintenance: „In echte APEX-App einspielen & live testen".
 *
 * Orchestriert den vollen Live-Ablauf über die wiederverwendbare apex-deploy-Automation:
 *   analyzePlugin → Plugin per UI installieren → File URLs to Load setzen →
 *   analyse-getriebene Testseite (Page-Item/AJAX-Wiring, ConfigJSON, SQL-Quelle) →
 *   headless Render-Smoke-Test (SVG/Canvas + JS-Fehler + APEX-Fehlerseite ehrlich).
 *
 * Deterministisch (kein KI-Aufruf). Alle Browser-/IO-Bausteine sind injizierbar → ohne echten
 * Browser/Instanz unit-testbar. Secrets (Passwort) kommen vom Aufrufer, werden nie geloggt.
 *
 * Resultat: src/service/apex-live.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzePlugin, buildTestPageSql, pluginLoadFiles, parsePluginName } from '../../mcp-apex-deploy/lib/apex.js';
import { loadChromium, uiLogin, uiImportFile, uiSetPluginFileUrls, uiCreateTestPage, smokeCheckPage } from '../../mcp-apex-deploy/lib/apex-ui.js';

const parseDisplayName = (sql) => { const m = String(sql || '').match(/p_display_name=>'((?:[^']|'')*)'/i); return m ? m[1].replace(/''/g, "'").trim() : null; };

/** Findet die Plugin-Export-SQL im Komponenten-Verzeichnis (region_type_plugin_*.sql o.ä.). */
export function findPluginExport(dir, opts = {}) {
  const list = opts.listFiles ?? ((d) => fs.readdirSync(d));
  if (!dir) return null;
  let files = [];
  try { files = list(dir); } catch { return null; }
  const sql = files.filter((f) => /\.sql$/i.test(f));
  // bevorzugt echte Plugin-Exporte, keine „_APEX_5.1"-Altversion
  const prio = sql.find((f) => /region_type_plugin|plugin/i.test(f) && !/apex[_-]?5/i.test(f))
    || sql.find((f) => /region_type_plugin|plugin/i.test(f)) || sql[0];
  return prio ? path.join(dir, prio) : null;
}

/**
 * Spielt das Plugin einer Komponente in eine echte APEX-App ein und testet es live.
 * @param {{exportFile:string, target:{baseUrl,workspace,user,pass,appId,alias?,workspaceId?,owner?,release?},
 *          sourceSql?:string, pageId?:number, pageName?:string, setFileUrls?:boolean}} o
 * @param {object} deps injizierbar (Browser/IO) — Default: echte apex-deploy-Automation.
 */
export async function deployAndTest(o = {}, deps = {}) {
  const d = {
    loadChromium, uiLogin, uiImportFile, uiSetPluginFileUrls, uiCreateTestPage, smokeCheckPage,
    analyzePlugin, buildTestPageSql, pluginLoadFiles,
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    exists: (f) => fs.existsSync(f),
    writeTmp: (name, content) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apexlive-')), name); fs.writeFileSync(f, content); return f; },
    now: () => new Date().toISOString(),
    ...deps,
  };
  const t = o.target || {};
  const appId = o.appId ?? t.appId;
  if (!o.exportFile || !d.exists(o.exportFile)) return { ok: false, error: 'Plugin-Export nicht gefunden (Repo/Datei prüfen).' };
  if (!t.baseUrl || !t.workspace || !t.user || !t.pass) return { ok: false, error: 'APEX-Verbindung unvollständig (baseUrl/workspace/user/Passwort).' };
  if (!appId) return { ok: false, error: 'Ziel-App-ID fehlt.' };

  const exportSql = d.readFile(o.exportFile);
  const an = d.analyzePlugin(exportSql);
  if (!an.internalName) return { ok: false, error: 'Plugin-Name im Export nicht gefunden.' };
  const pageId = o.pageId ?? 9999;
  const cfg = { baseUrl: t.baseUrl, workspace: t.workspace, user: t.user, pass: t.pass };

  const chromium = await d.loadChromium();
  if (!chromium) return { ok: false, error: 'Playwright nicht installiert — Live-Test nicht möglich.' };
  const browser = await chromium.launch({ headless: true });
  const result = { ok: false, plugin: an.internalName, displayName: an.displayName, appId: Number(appId), pageId, analysis: { apiVersion: an.apiVersion, sourceTypePrefix: an.sourceTypePrefix, usesAjaxItemsToSubmit: an.usesAjaxItemsToSubmit } };
  try {
    const page = await browser.newPage();
    const login = await d.uiLogin(page, cfg);
    result.login = { ok: login.ok, error: login.error };
    if (!login.ok) return result;

    // 1) Plugin installieren (app-interner Plug-in-Import).
    result.install = await d.uiImportFile(page, o.exportFile, { appId, viaPlugins: true });

    // 2) File URLs to Load (JS+CSS) setzen.
    if (o.setFileUrls !== false) {
      const { jsUrls, cssUrls } = d.pluginLoadFiles(exportSql);
      result.fileUrls = await d.uiSetPluginFileUrls(page, { appId, displayName: an.displayName || parseDisplayName(exportSql), jsUrls, cssUrls });
    }

    // 3) Testseite im PAGE DESIGNER bauen — ersetzt den in dieser Instanz WAF-blockierten Wizard-Import (B-30):
    //    Create-Page (Blank) → Plugin-Region per Drag → Region-Name + SQL-Quelle + Custom-Attribute (ConfigJSON)
    //    → Seite öffentlich → Save. Existiert die Seite schon (gleiches Plugin), wird sie wiederverwendet.
    //    Auf FRISCHER, eingeloggter Seite → sauberer Navigationsstart, unabhängig vom Zustand nach Install.
    const sourceSql = o.sourceSql || (an.hasSourceSql ? an.defaultSourceSql : undefined) || undefined;
    const pdAttrs = (an.customAttributes || [])
      .filter((a) => a.default != null && a.default !== '' && a.prompt)
      .map((a) => ({ prompt: a.prompt, value: String(a.default).replace(/[\x00-\x1f]+/g, ' ') }));
    const pdPage = await browser.newPage();
    const pdLogin = await d.uiLogin(pdPage, cfg);
    result.testPage = pdLogin.ok
      ? await d.uiCreateTestPage(pdPage, {
        appId, pageId, pageName: o.pageName || `Live-Test: ${an.internalName}`,
        pluginDisplayName: an.displayName || parseDisplayName(exportSql) || an.internalName,
        regionName: `Test: ${an.internalName}`, sourceSql, attributes: pdAttrs,
      })
      : { ok: false, error: 'Login für Page-Designer-Schritt fehlgeschlagen.' };
    await pdPage.close().catch(() => {});

    // 4) Render-Smoke-Test über die Friendly-URL (öffentliche Testseite).
    const base = t.baseUrl.replace(/\/$/, '');
    const url = t.alias ? `${base}/r/${String(t.workspace).toLowerCase()}/${t.alias}/${pageId}` : `${base}/f?p=${appId}:${pageId}`;
    const rt = await browser.newPage();
    const errors = [];
    rt.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
    rt.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await rt.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // expectMarker = interner Plugin-Name → der Seitentitel „Live-Test: <plugin>" muss ihn enthalten,
    // sonst zeigt die URL noch eine alte/fremde Seite (Import nicht durchgelaufen) → kein False-Green.
    result.render = await d.smokeCheckPage(rt, errors, { settleMs: o.settleMs, expectMarker: an.internalName });
    result.render.url = url;

    // ok NUR wenn Install UND Seiten-Import UND Render echt durchliefen (testPage.ok verhindert False-Green
    // bei „Bad Request"/abgelehntem Import, während ein übrig gebliebenes Fremd-SVG noch sichtbar ist).
    result.ok = !!(result.install?.ok && result.testPage?.ok && result.render?.rendered);
    result.at = d.now();
    return result;
  } finally { await browser.close(); }
}
