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
import { buildInstallScript, buildTestPageSql, parsePluginName, maskConn } from './lib/apex.js';

const ENV = {
  sqlcl: process.env.APEX_SQLCL || 'sql',
  conn: process.env.APEX_CONN || '',
  workspace: process.env.APEX_WORKSPACE || '',
  appId: process.env.APEX_APP_ID || '',
  baseUrl: process.env.APEX_BASE_URL || '',
};

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
    description: 'Erzeugt eine generische Testseite in der Ziel-App: EINE Region vom Plugin-Typ, Attribute (z.B. ConfigJSON) aus der Schnittstelle gefüttert. Empfohlen mit templateFile (echter Seiten-Export der Instanz als Vorlage); ohne Vorlage best-effort-Gerüst (auf der Instanz verifizieren).',
    inputSchema: { type: 'object', properties: {
      pluginName: { type: 'string', description: 'Interner Plugin-Name (p_name, z.B. DE.AISS.APEXFLOWCHART)' },
      attributes: { type: 'array', items: { type: 'string' }, description: 'Attributwerte in Reihenfolge (attribute_01..25), z.B. [ConfigJSON-Default]' },
      pageId: { type: 'number', description: 'Seiten-ID (Default 9999)' },
      appId: { type: 'number' }, workspace: { type: 'string' },
      templateFile: { type: 'string', description: 'Optional: echter Seiten-Export als Vorlage (robusteste Variante)' },
      apiPackage: { type: 'string', description: 'Gerüst-Modus: wwv_flow_imp_page (Default) oder wwv_flow_api (ältere Instanzen)' },
      dryRun: { type: 'boolean', description: 'true = nur SQL zurückgeben, nichts einspielen' },
    }, required: ['pluginName'] },
    run: async (a) => {
      const workspace = a.workspace || ENV.workspace; const appId = a.appId ?? ENV.appId;
      const template = a.templateFile ? fs.readFileSync(a.templateFile, 'utf8') : undefined;
      const sql = buildTestPageSql({ ...a, appId, template });
      if (a.dryRun) return { ok: true, dryRun: true, sql };
      if (!workspace || !appId) return { ok: false, error: 'workspace/appId fehlen.', sql };
      const script = buildInstallScript({ exportFile: '__INLINE__', workspace, appId }).replace('@"__INLINE__"', sql);
      const r = await runSqlcl(script);
      const url = ENV.baseUrl ? `${ENV.baseUrl.replace(/\/$/, '')}/f?p=${appId}:${a.pageId ?? 9999}` : null;
      return { ...r, pageId: a.pageId ?? 9999, url, note: template ? 'Vorlagen-Modus' : 'Gerüst-Modus (best effort — auf der Instanz verifizieren)' };
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
        await page.waitForTimeout(2500); // Plugin-Init/async-Render abwarten
        const sel = a.selector || 'body';
        const visibleText = (await page.locator(sel).first().innerText().catch(() => '')).trim();
        const hasCanvasOrSvg = await page.locator('canvas, svg, .t-Region').count();
        const ok = errors.length === 0 && (visibleText.length > 0 || hasCanvasOrSvg > 0);
        return { ok, url, jsErrors: errors.slice(0, 20), rendered: visibleText.length > 0 || hasCanvasOrSvg > 0, regions: hasCanvasOrSvg };
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
        const msg = (body.match(/([^.]*\b(installed|installiert)\b[^.]*)/i) || [])[1];
        return { ok, steps, appId: Number(appId), plugin: parsePluginName(fs.readFileSync(a.exportFile, 'utf8')), message: msg?.trim(), screenshot: shot, note: ok ? undefined : 'Kein eindeutiger Erfolgstext — Screenshot/Schritt-Log prüfen.' };
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
