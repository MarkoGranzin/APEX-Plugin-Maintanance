#!/usr/bin/env node
/**
 * apex-deploy — eigenständiger MCP-Server (stdio, KEINE npm-Abhängigkeiten → überall kopierbar).
 *
 * Spielt APEX-Exporte (Plugins, Template-Components, Pages, Apps) headless in eine echte
 * APEX-App ein (SQLcl + apex_application_install), erzeugt eine generische Testseite mit
 * einer Region vom Plugin-Typ (Attribute aus der Schnittstelle gefüttert) und macht einen
 * headless Smoke-Test (Playwright, optional). Deterministisch → minimaler Token-Verbrauch.
 *
 * Konfiguration über Umgebungsvariablen (Secrets werden NIE ausgegeben):
 *   APEX_SQLCL      Pfad zu SQLcl (sql/sql.exe). Default: "sql" (im PATH)
 *   APEX_CONN       Connect-String user/pass@host:port/service (Parsing-Schema-User der Ziel-App)
 *   APEX_WORKSPACE  Default-Workspace
 *   APEX_APP_ID     Default-Ziel-App
 *   APEX_BASE_URL   z.B. https://host/ords  (für Testseiten-URL f?p=APP:PAGE)
 *   APEX_LOGIN_USER / APEX_LOGIN_PASS  optional für den Headless-Login der Testseite
 *
 * Resultat: mcp-apex-deploy/server.js
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInstallScript, buildTestPageSql, parsePluginName, maskConn, pluginLoadFiles, analyzePlugin } from './lib/apex.js';

/** Anzeigename (p_display_name) aus einem Plugin-Export lesen — zum Auffinden in der Plug-ins-Liste. */
const parsePluginDisplayName = (sqlText) => { const m = String(sqlText || '').match(/p_display_name=>'((?:[^']|'')*)'/i); return m ? m[1].replace(/''/g, "'").trim() : null; };

const ENV = {
  sqlcl: process.env.APEX_SQLCL || 'sql',
  conn: process.env.APEX_CONN || '',
  workspace: process.env.APEX_WORKSPACE || '',
  appId: process.env.APEX_APP_ID || '',
  baseUrl: process.env.APEX_BASE_URL || '',
  // Instanzspezifische Header-Werte für generierte Seiten-Importe (24.x). Aus einem echten App-Export ablesbar.
  workspaceId: process.env.APEX_WORKSPACE_ID || '',
  owner: process.env.APEX_OWNER || '',
  release: process.env.APEX_RELEASE || '24.2',
};

// Gemeinsamer app-interner Import über die APEX-UI (Export/Import → Import → Upload → primäre Aktion durchklicken).
// Funktioniert für Plug-in- UND Seiten-Importe; erkennt Erfolg bzw. Replace-Bestätigung. Session bleibt via Klicks erhalten.
async function uiImportFile(page, filePath, o = {}) {
  const clickFirst = async (locs) => { for (const l of locs) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
  const appId = o.appId ?? ENV.appId;
  const appTile = page.locator(`a[href*="fb_flow_id=${appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000);
  if (o.viaPlugins) { // Plug-in-Import: Shared Components → Plug-ins → Import
    await clickFirst([page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]);
    await clickFirst([page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]);
    await clickFirst([page.getByRole('link', { name: /^import$/i }), page.getByRole('button', { name: /^import$/i }), page.getByText(/^import$/i)]);
  } else { // Seiten-/Komponenten-Import: Export / Import → Import
    await clickFirst([page.getByRole('link', { name: /export ?\/ ?import/i }), page.getByText(/export ?\/ ?import/i)]);
    await clickFirst([page.getByRole('link', { name: /^import$/i }), page.getByRole('button', { name: /^import$/i }), page.getByText(/^import$/i)]);
  }
  const file = page.locator('input[type="file"]');
  try { await file.first().waitFor({ state: 'attached', timeout: 15000 }); }
  catch { return { ok: false, error: 'Upload-Feld nicht gefunden (Navigation weicht ab).' }; }
  await file.first().setInputFiles(filePath);
  const steps = [];
  for (let i = 0; i < 8; i++) {
    const hot = page.locator('button.a-Button--hot, a.a-Button--hot').filter({ hasText: /\S/ });
    try { await hot.first().waitFor({ state: 'visible', timeout: 20000 }); } catch { break; }
    const label = (await hot.first().innerText().catch(() => '')).trim();
    steps.push(label);
    await hot.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2000);
    const title = await page.locator('title').first().innerText().catch(() => '');
    if (/edit page|page designer|pages -|plug-?ins$/i.test(title)) break; // im Ziel gelandet
  }
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const oraErr = (body.match(/ORA-\d+[^.]{0,120}|PLS-\d+[^.]{0,120}/i) || [])[0] || null;
  const ok = !oraErr && /installed|imported|installiert|created|erstellt|plug-?in installed|checksum/i.test(body) === true;
  return { ok: !oraErr, steps, oraError: oraErr, resultTitle: await page.locator('title').first().innerText().catch(() => '') };
}

/**
 * Setzt die „File URLs to Load" (JS + CSS) eines installierten Plugins über die APEX-UI, damit APEX die
 * Plugin-Dateien automatisch lädt (alte 19.1-Plugins laden sonst per ADD_LIBRARY mit brüchigen URLs).
 * Navigiert App → Shared Components → Plug-ins → <Plugin> und füllt P4410_JAVASCRIPT_FILE_URLS/_CSS_FILE_URLS.
 * Standard: nur leere Felder füllen (manuelle Einstellungen nicht überschreiben; overwrite=true erzwingt).
 */
async function uiSetPluginFileUrls(page, o = {}) {
  const clickFirst = async (locs) => { for (const l of locs) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
  const appId = o.appId ?? ENV.appId;
  const appTile = page.locator(`a[href*="fb_flow_id=${appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(800);
  await clickFirst([page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]);
  await clickFirst([page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]);
  // Plugin per Anzeigename öffnen (Fallback: erster Plug-in-Link).
  const nameRe = o.displayName ? new RegExp(o.displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  let opened = false;
  if (nameRe) opened = await clickFirst([page.getByRole('link', { name: nameRe })]);
  if (!opened) return { ok: false, error: `Plugin „${o.displayName || '?'}" in der Liste nicht gefunden.` };
  await page.waitForTimeout(800);
  // Felder setzen (value + Events; Felder liegen oft in eingeklapptem Abschnitt → über JS setzen).
  const setField = async (id, urls) => {
    if (!urls?.length) return { field: id, skipped: 'keine Dateien' };
    return page.evaluate(({ id, val, overwrite }) => {
      const t = document.getElementById(id); if (!t) return { field: id, error: 'Feld fehlt' };
      if (t.value && t.value.trim() && !overwrite) return { field: id, skipped: 'bereits gesetzt' };
      t.value = val; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (window.apex && apex.item) apex.item(id).setValue(val); } catch (e) { /* egal */ }
      return { field: id, set: true, count: val.split('\n').filter(Boolean).length };
    }, { id, val: urls.join('\n'), overwrite: !!o.overwrite });
  };
  const jsRes = await setField('P4410_JAVASCRIPT_FILE_URLS', o.jsUrls);
  const cssRes = await setField('P4410_CSS_FILE_URLS', o.cssUrls);
  let applied = false;
  if (jsRes.set || cssRes.set) {
    for (const b of [page.getByRole('button', { name: /apply changes/i }), page.locator('button:has-text("Apply Changes")')]) { if (await b.count()) { await b.first().click(); applied = true; break; } }
    await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1500);
  }
  return { ok: true, js: jsRes, css: cssRes, applied };
}

// ── SQLcl headless ausführen (Skript in Temp-Datei, -S = silent) ────────────────────────────
function runSqlcl(script, opts = {}) {
  return new Promise((resolve) => {
    const conn = opts.conn || ENV.conn;
    if (!conn) return resolve({ ok: false, output: 'APEX_CONN nicht gesetzt (user/pass@host:port/service).' });
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apexdep-')), 'run.sql');
    fs.writeFileSync(f, script);
    const child = spawn(ENV.sqlcl, ['-S', conn, `@${f}`], { windowsHide: true, timeout: opts.timeoutMs ?? 300000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ ok: false, output: `SQLcl-Start fehlgeschlagen (${ENV.sqlcl}): ${e.message}` }));
    child.on('close', (code) => {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* egal */ }
      const scrubbed = out.split(conn).join(maskConn(conn)); // Secrets nie ausgeben
      resolve({ ok: code === 0 && !/ORA-\d+|SP2-\d+|PLS-\d+/i.test(scrubbed), exitCode: code, output: scrubbed.slice(-6000) });
    });
  });
}

// ── Browser (Playwright) laden + generischer APEX-Workspace-Login ──────────────────────────────
async function loadChromium() {
  try { const m = await import(pathToFileURL(path.join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href); return m.chromium; }
  catch { try { return (await import('playwright')).chromium; } catch { return null; } }
}
/**
 * Meldet sich an der modernen APEX-Workspace-Sign-In-Seite an (Workspace + Database Username + Passwort).
 * Zugangsdaten aus env — das Passwort erreicht diesen Prozess nur lokal, nie den Aufrufer.
 */
async function uiLogin(page, o = {}) {
  const workspace = o.workspace || ENV.workspace;
  const user = process.env.APEX_LOGIN_USER || '';
  const pass = process.env.APEX_LOGIN_PASS || '';
  if (!ENV.baseUrl) return { ok: false, error: 'APEX_BASE_URL nicht gesetzt.' };
  if (!workspace || !user || !pass) return { ok: false, error: 'Login unvollständig — APEX_WORKSPACE, APEX_LOGIN_USER, APEX_LOGIN_PASS setzen.' };
  await page.goto(`${ENV.baseUrl.replace(/\/$/, '')}/r/apex/app-builder/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Robuste, versionsunabhängige Feldsuche über Platzhalter/Rollen; danach Fallback auf klassische Item-IDs.
  const fill = async (labels, ids, value) => {
    for (const l of labels) { const loc = page.getByPlaceholder(l, { exact: false }); if (await loc.count()) { await loc.first().fill(value); return true; } }
    for (const id of ids) { const loc = page.locator(id); if (await loc.count()) { await loc.first().fill(value); return true; } }
    return false;
  };
  const isLogin = await page.getByPlaceholder('Workspace', { exact: false }).count();
  if (isLogin) {
    await fill(['Workspace'], ['#P9999_COMPANY', '#P101_COMPANY'], workspace);
    await fill(['Database Username', 'Username'], ['#P9999_USERNAME', '#P101_USERNAME'], user);
    await fill(['Password'], ['#P9999_PASSWORD', '#P101_PASSWORD'], pass);
    const btn = page.getByRole('button', { name: /sign in|anmelden/i });
    if (await btn.count()) await btn.first().click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  const url = page.url();
  const stillLogin = /sign-in|login/i.test(url) || (await page.getByPlaceholder('Password', { exact: false }).count()) > 0;
  return stillLogin ? { ok: false, error: 'Login nicht erfolgreich — Workspace/Username/Passwort prüfen (evtl. Workspace=AP200000, Username=Meetup).', url }
                    : { ok: true, url, workspace, user };
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'apex_install',
    description: 'Spielt einen beliebigen APEX-Export (Plugin/Template-Component/Page/App-SQL) headless in die Ziel-App ein — generisch via apex_application_install (set_workspace, set_application_id, generate_offset) + SQLcl. Kein UI, keine KI.',
    inputSchema: { type: 'object', properties: {
      exportFile: { type: 'string', description: 'Pfad zum Export-SQL (z.B. region_type_plugin_*.sql)' },
      workspace: { type: 'string', description: 'Ziel-Workspace (Default: env APEX_WORKSPACE)' },
      appId: { type: 'number', description: 'Ziel-Application-ID (Default: env APEX_APP_ID)' },
    }, required: ['exportFile'] },
    run: async (a) => {
      const workspace = a.workspace || ENV.workspace; const appId = a.appId ?? ENV.appId;
      if (!workspace || !appId) return { ok: false, error: 'workspace/appId fehlen (Parameter oder env APEX_WORKSPACE/APEX_APP_ID setzen).' };
      if (!fs.existsSync(a.exportFile)) return { ok: false, error: `Export-Datei nicht gefunden: ${a.exportFile}` };
      const pluginName = parsePluginName(fs.readFileSync(a.exportFile, 'utf8'));
      const r = await runSqlcl(buildInstallScript({ exportFile: path.resolve(a.exportFile), workspace, appId }));
      return { ...r, pluginName, appId: Number(appId), workspace };
    },
  },
  {
    name: 'apex_create_test_page',
    description: 'Erzeugt eine funktionierende Testseite in der Ziel-App über die APEX-IMPORT-UI (Browser, headless): EINE Region vom Plugin-Typ. Mit exportFile wird das Plugin GRÜNDLICH ANALYSIERT (analyzePlugin) und die Seite automatisch korrekt eingerichtet: Source-Type (api_version), ConfigJSON-Default ins richtige Attribut, und — falls das Plugin „Items to Submit" nutzt — ein Page-Item + Verdrahtung (sonst ORA-01403). Kein SQLcl. dryRun=true gibt nur das SQL zurück.',
    inputSchema: { type: 'object', properties: {
      exportFile: { type: 'string', description: 'Plugin-Export-SQL → wird analysiert; leitet Name/Source-Type/ConfigJSON-Default/AJAX-Item automatisch ab (empfohlen).' },
      pluginInternalName: { type: 'string', description: 'Alternativ zu exportFile: interner Plugin-Name (dann ohne Auto-Analyse).' },
      pageId: { type: 'number', description: 'Seiten-ID (Default 9999)' },
      pageName: { type: 'string' },
      appId: { type: 'number' }, workspace: { type: 'string' },
      sourceSql: { type: 'string', description: 'Optionale SQL-Datenquelle der Region (Plugin-Daten).' },
      attributes: { type: 'object', description: 'Optional { attribute_NN: wert } — überschreibt die aus der Analyse abgeleiteten Defaults.' },
      dryRun: { type: 'boolean' },
    } },
    run: async (a) => {
      const appId = a.appId ?? ENV.appId;
      if (!appId) return { ok: false, error: 'appId fehlt (Parameter oder env APEX_APP_ID).' };
      const pageId = a.pageId ?? 9999;
      // Gründliche Plugin-Analyse (sofern Export gegeben) → Seite automatisch korrekt einrichten.
      let derived = {};
      if (a.exportFile) {
        if (!fs.existsSync(a.exportFile)) return { ok: false, error: `Export-Datei nicht gefunden: ${a.exportFile}` };
        const an = analyzePlugin(fs.readFileSync(a.exportFile, 'utf8'));
        if (!an.internalName) return { ok: false, error: 'Plugin-Name im Export nicht gefunden.' };
        derived = {
          pluginInternalName: an.internalName,
          sourceTypePrefix: an.sourceTypePrefix,
          needsAjaxItem: an.usesAjaxItemsToSubmit,
          // ConfigJSON-Default von Steuerzeichen (Tabs/Zeilenumbrüche in Strings) säubern → sonst scheitert JSON.parse im Plugin.
          attributes: (an.configAttributeKey && an.configDefault) ? { [an.configAttributeKey]: an.configDefault.replace(/[\x00-\x1f]+/g, ' ') } : undefined,
          _analysis: { internalName: an.internalName, apiVersion: an.apiVersion, sourceTypePrefix: an.sourceTypePrefix, standardAttributes: an.standardAttributes, usesAjaxItemsToSubmit: an.usesAjaxItemsToSubmit, hasAjaxCallback: an.hasAjaxCallback, configAttributeKey: an.configAttributeKey },
        };
      }
      const opts = { ...derived, ...a, appId, pageId, workspaceId: ENV.workspaceId, owner: ENV.owner, release: ENV.release,
        // explizit übergebene attributes überschreiben die abgeleiteten
        attributes: a.attributes || derived.attributes };
      if (!opts.pluginInternalName) return { ok: false, error: 'pluginInternalName oder exportFile nötig.' };
      const sql = buildTestPageSql(opts);
      if (a.dryRun) return { ok: true, dryRun: true, analysis: derived._analysis, sql };
      const chromium = await loadChromium();
      if (!chromium) return { ok: false, error: 'Playwright nicht installiert.', sql };
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apexpage-')), `page_${pageId}.sql`);
      fs.writeFileSync(tmp, sql);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const login = await uiLogin(page, a); if (!login.ok) return { ok: false, error: login.error };
        const imp = await uiImportFile(page, tmp, { appId });
        return { ...imp, pageId, appId: Number(appId), analysis: derived._analysis, ajaxItem: opts.needsAjaxItem ? `P${pageId}_AJAX` : null, runtimeHint: `${ENV.baseUrl.replace(/\/$/, '')}/f?p=${appId}:${pageId}`, note: imp.oraError ? 'Import-Fehler — SQL/Instanz prüfen' : 'Seite eingespielt (bei „Replace"-Bestätigung wurde die bestehende Seite ersetzt).' };
      } finally { try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* egal */ } await browser.close(); }
    },
  },
  {
    name: 'apex_test_page',
    description: 'Headless Smoke-Test der Testseite (Playwright): Seite laden (optional APEX-Login via env), JS-Fehler sammeln, sichtbares Rendern prüfen. Ohne Playwright: ehrliche Meldung statt grün.',
    inputSchema: { type: 'object', properties: {
      url: { type: 'string', description: 'Seiten-URL (Default: APEX_BASE_URL/f?p=APP:PAGE)' },
      appId: { type: 'number' }, pageId: { type: 'number' },
      selector: { type: 'string', description: 'CSS-Selektor, der sichtbar sein muss (Default: .t-Body, body)' },
      timeoutMs: { type: 'number' },
    } },
    run: async (a) => {
      const url = a.url || (ENV.baseUrl && a.appId != null && a.pageId != null ? `${ENV.baseUrl.replace(/\/$/, '')}/f?p=${a.appId}:${a.pageId}` : null);
      if (!url) return { ok: false, error: 'url fehlt (oder APEX_BASE_URL + appId/pageId setzen).' };
      let chromium;
      try { ({ chromium } = await import(pathToFileURL(path.join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href)); }
      catch { try { ({ chromium } = await import('playwright')); } catch { return { ok: false, error: 'Playwright nicht installiert — Headless-Test kann nicht laufen (npm i playwright im Aufruf-Verzeichnis).' }; } }
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: a.timeoutMs ?? 30000 });
        // Generischer APEX-Login, falls die Login-Seite kommt und Credentials gesetzt sind.
        const user = process.env.APEX_LOGIN_USER, pass = process.env.APEX_LOGIN_PASS;
        if (user && pass && await page.locator('#P9999_USERNAME, #P101_USERNAME').count()) {
          const u = page.locator('#P9999_USERNAME, #P101_USERNAME').first();
          const p = page.locator('#P9999_PASSWORD, #P101_PASSWORD').first();
          await u.fill(user); await p.fill(pass);
          await page.keyboard.press('Enter');
          await page.waitForLoadState('domcontentloaded');
        }
        await page.waitForTimeout(a.settleMs ?? 3500); // Plugin-Init/async-Render (mxGraph u.ä.) abwarten
        const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
        // APEX-Server-Fehlerseite ehrlich erkennen (ORA-/is_internal_error) — NICHT als grün durchwinken.
        const apexError = /Error processing request|apex_error_code|ORA-\d{4,5}/i.test(body)
          ? (body.match(/ORA-\d{4,5}: [^A-Z]{0,80}|apex_error_code: [\w.]+/i) || ['APEX-Fehlerseite'])[0] : null;
        const sel = a.selector || 'body';
        const visibleText = (await page.locator(sel).first().innerText().catch(() => '')).trim();
        const hasGraphics = await page.locator('canvas, svg, .mxgraph, [class*="mx"]').count();
        const stillLogin = /sign-in|\/login/i.test(page.url());
        const ok = !apexError && !stillLogin && errors.length === 0 && (visibleText.length > 0 || hasGraphics > 0);
        return { ok, url: page.url().replace(/session=\d+/, 'session=…'), apexError, needsLogin: stillLogin || undefined,
                 jsErrors: errors.slice(0, 20), rendered: !apexError && (hasGraphics > 0), graphics: hasGraphics,
                 note: apexError ? `APEX-Fehlerseite: ${apexError} — Plugin-Render schlug fehl (Region-/Laufzeit-Setup prüfen).` : (stillLogin ? 'Laufzeit verlangt App-Login (Seite nicht öffentlich?).' : undefined) };
      } finally { await browser.close(); }
    },
  },
  {
    name: 'apex_info',
    description: 'Zeigt die aktive Konfiguration (Connect maskiert — Secrets werden nie ausgegeben) und prüft, ob SQLcl erreichbar ist.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const which = await new Promise((res) => {
        const c = spawn(ENV.sqlcl, ['-V'], { windowsHide: true });
        let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
        c.on('error', () => res(null)); c.on('close', () => res(o.trim().split('\n')[0] || 'ok'));
      });
      return { ok: true, sqlcl: ENV.sqlcl, sqlclVersion: which || 'NICHT gefunden — APEX_SQLCL setzen', conn: maskConn(ENV.conn), workspace: ENV.workspace || '(not set)', appId: ENV.appId || '(not set)', baseUrl: ENV.baseUrl || '(not set)', uiLogin: process.env.APEX_LOGIN_USER ? `${process.env.APEX_LOGIN_USER}@${ENV.workspace} (Passwort ${process.env.APEX_LOGIN_PASS ? 'gesetzt' : 'FEHLT'})` : '(APEX_LOGIN_USER nicht gesetzt)' };
    },
  },
  {
    name: 'apex_ui_login_check',
    description: 'Prüft den APEX-Workspace-Login (Browser, headless) mit den env-Zugangsdaten (APEX_WORKSPACE/APEX_LOGIN_USER/APEX_LOGIN_PASS) — landet er im App Builder? Kein Import, nur Verbindungs-/Login-Test. Passwort nie in der Ausgabe.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' } } },
    run: async (a) => {
      const chromium = await loadChromium();
      if (!chromium) return { ok: false, error: 'Playwright nicht installiert.' };
      const browser = await chromium.launch({ headless: true });
      try { const page = await browser.newPage(); const r = await uiLogin(page, a); return r; }
      finally { await browser.close(); }
    },
  },
  {
    name: 'apex_install_ui',
    description: 'Spielt ein Plugin/eine Template-Component über die APEX-IMPORT-UI ein (Browser, headless) — KEIN SQLcl, KEIN DB-Connect, nur der APEX-Login (env). Loggt ein → Shared Components → Plug-ins → Import → Datei hochladen → Wizard bis „Install". Deterministisch = ein Aufruf, token-minimal. Best effort über APEX-Versionen; liefert Schritt-Log + Screenshot-Pfad.',
    inputSchema: { type: 'object', properties: {
      exportFile: { type: 'string', description: 'Pfad zum Plugin-Export-SQL' },
      appId: { type: 'number', description: 'Ziel-App (Default env APEX_APP_ID) — Plug-ins werden in eine App importiert' },
      workspace: { type: 'string' },
      headed: { type: 'boolean', description: 'true = sichtbares Browserfenster (zum Zuschauen/Tunen)' },
      setFileUrls: { type: 'boolean', description: 'Nach dem Install automatisch die „File URLs to Load" (JS+CSS) des Plugins füllen. Default true.' },
    }, required: ['exportFile'] },
    run: async (a) => {
      if (!fs.existsSync(a.exportFile)) return { ok: false, error: `Export-Datei nicht gefunden: ${a.exportFile}` };
      const appId = a.appId ?? ENV.appId;
      const chromium = await loadChromium();
      if (!chromium) return { ok: false, error: 'Playwright nicht installiert.' };
      const steps = [];
      const browser = await chromium.launch({ headless: !a.headed });
      const clickFirst = async (page, locators) => { for (const l of locators) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
      try {
        const page = await browser.newPage();
        const login = await uiLogin(page, a); steps.push({ step: 'login', ok: login.ok, url: login.url });
        if (!login.ok) return { ok: false, steps, error: login.error };
        // App-internen Plug-in-Import ansteuern (verifizierter Pfad, moderne Friendly-URLs, Session bleibt durch Klicks erhalten):
        // App-Kachel (fb_flow_id=appId) → Shared Components → Plug-ins → Import.
        const appTile = page.locator(`a[href*="fb_flow_id=${appId}"]`);
        if (!(await appTile.count())) { const shot = path.join(os.tmpdir(), 'apex-noapp.png'); await page.screenshot({ path: shot }).catch(() => {}); return { ok: false, steps, error: `App ${appId} nicht in der Apps-Liste gefunden (Workspace/App-ID prüfen).`, screenshot: shot }; }
        await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); steps.push({ step: 'open-app', appId: Number(appId) });
        await clickFirst(page, [page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]); steps.push({ step: 'shared-components' });
        await clickFirst(page, [page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]); steps.push({ step: 'plug-ins' });
        await clickFirst(page, [page.getByRole('link', { name: /^import$/i }), page.getByRole('button', { name: /^import$/i }), page.getByText(/^import$/i)]); steps.push({ step: 'import', url: page.url() });
        const file = page.locator('input[type="file"]');
        try { await file.first().waitFor({ state: 'attached', timeout: 15000 }); }
        catch { const shot = path.join(os.tmpdir(), 'apex-import-noupload.png'); await page.screenshot({ path: shot }).catch(() => {}); return { ok: false, steps, error: 'Plug-in-Import-Upload-Feld nicht gefunden — Navigation weicht ab (Screenshot/Schritt-Log prüfen).', screenshot: shot }; }
        await file.first().setInputFiles(path.resolve(a.exportFile)); steps.push({ step: 'file-selected', file: path.basename(a.exportFile) });
        // Wizard: die PRIMÄRE Aktion (a-Button--hot = Next → Next → Install Plug-in) durchklicken.
        for (let i = 0; i < 6; i++) {
          const hot = page.locator('button.a-Button--hot, a.a-Button--hot').filter({ hasText: /\S/ });
          try { await hot.first().waitFor({ state: 'visible', timeout: 20000 }); } catch { steps.push({ step: 'no-primary', at: i }); break; }
          const label = (await hot.first().innerText().catch(() => '')).trim();
          steps.push({ step: 'click', label, at: i });
          await hot.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2000);
          if (/install|finish|fertig|abschließen/i.test(label)) break;
        }
        const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
        const ok = /plug-?in installed|installed|installiert|success|erfolg/i.test(body);
        const shot = path.join(os.tmpdir(), 'apex-import-result.png'); await page.screenshot({ path: shot }).catch(() => {});
        const exportSql = fs.readFileSync(a.exportFile, 'utf8');
        const msg = (body.match(/([^.]*\b(installed|installiert)\b[^.]*)/i) || [])[1];
        // Automatisch die „File URLs to Load" (JS+CSS) des Plugins setzen → APEX lädt die Plugin-Dateien zuverlässig.
        let fileUrls = null;
        if (ok && a.setFileUrls !== false) {
          try {
            const { jsUrls, cssUrls } = pluginLoadFiles(exportSql);
            fileUrls = await uiSetPluginFileUrls(page, { appId, displayName: parsePluginDisplayName(exportSql), jsUrls, cssUrls });
            steps.push({ step: 'set-file-urls', js: fileUrls.js, css: fileUrls.css, applied: fileUrls.applied });
          } catch (e) { steps.push({ step: 'set-file-urls', error: String(e?.message ?? e) }); }
        }
        return { ok, steps, appId: Number(appId), plugin: parsePluginName(exportSql), message: msg?.trim(), fileUrls, screenshot: shot, note: ok ? undefined : 'Kein eindeutiger Erfolgstext — Screenshot/Schritt-Log prüfen.' };
      } finally { await browser.close(); }
    },
  },
  {
    name: 'apex_plugin_load_files',
    description: 'Setzt die „File URLs to Load" (JavaScript + CSS, sofern vorhanden) eines bereits installierten Plugins über die APEX-UI — generisch aus dem Plugin-Export abgeleitet (Datei-Liste + ADD_LIBRARY-Ladereihenfolge). Damit lädt APEX die Plugin-Dateien automatisch. Standard: nur leere Felder füllen (overwrite=true erzwingt).',
    inputSchema: { type: 'object', properties: {
      exportFile: { type: 'string', description: 'Pfad zum Plugin-Export-SQL (liefert Dateien + Reihenfolge + Anzeigename)' },
      appId: { type: 'number' }, workspace: { type: 'string' },
      overwrite: { type: 'boolean', description: 'true = auch bereits gefüllte Felder überschreiben' },
      dryRun: { type: 'boolean', description: 'true = nur die abgeleiteten URLs zurückgeben, nichts setzen' },
    }, required: ['exportFile'] },
    run: async (a) => {
      if (!fs.existsSync(a.exportFile)) return { ok: false, error: `Export-Datei nicht gefunden: ${a.exportFile}` };
      const sql = fs.readFileSync(a.exportFile, 'utf8');
      const { jsUrls, cssUrls } = pluginLoadFiles(sql);
      if (a.dryRun) return { ok: true, dryRun: true, jsUrls, cssUrls, displayName: parsePluginDisplayName(sql) };
      const chromium = await loadChromium();
      if (!chromium) return { ok: false, error: 'Playwright nicht installiert.', jsUrls, cssUrls };
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const login = await uiLogin(page, a); if (!login.ok) return { ok: false, error: login.error };
        const r = await uiSetPluginFileUrls(page, { appId: a.appId ?? ENV.appId, displayName: parsePluginDisplayName(sql), jsUrls, cssUrls, overwrite: a.overwrite });
        return { ...r, jsUrls, cssUrls };
      } finally { await browser.close(); }
    },
  },
];

// ── Minimaler MCP-stdio-Loop (JSON-RPC 2.0, Zeilen-getrennt) ────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'apex-deploy', version: '1.0.0' } } });
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    } else if (req.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === req.params?.name);
      if (!tool) { send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `unknown tool: ${req.params?.name}` } }); continue; }
      try {
        const result = await tool.run(req.params?.arguments || {});
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result?.ok === false } });
      } catch (e) {
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }], isError: true } });
      }
    } else if (req.id != null) {
      send({ jsonrpc: '2.0', id: req.id, result: {} }); // ping u.ä.
    } // notifications (initialized, …) brauchen keine Antwort
  }
});
