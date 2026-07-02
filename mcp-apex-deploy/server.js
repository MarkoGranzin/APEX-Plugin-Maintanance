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
      return { ok: true, sqlcl: ENV.sqlcl, sqlclVersion: which || 'NICHT gefunden — APEX_SQLCL setzen', conn: maskConn(ENV.conn), workspace: ENV.workspace || '(not set)', appId: ENV.appId || '(not set)', baseUrl: ENV.baseUrl || '(not set)' };
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
