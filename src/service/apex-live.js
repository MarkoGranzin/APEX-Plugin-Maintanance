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

import { analyzePlugin, buildTestPageSql, buildSetupManifest, pluginLoadFiles, parsePluginName } from '../../mcp-apex-deploy/lib/apex.js';
import { loadChromium, uiLogin, uiImportFile, uiSetPluginFileUrls, uiCreateTestPage, smokeCheckPage } from '../../mcp-apex-deploy/lib/apex-ui.js';
import { setupFromManifest } from '../../mcp-apex-deploy/lib/setup.js';

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
    analyzePlugin, buildSetupManifest, setupFromManifest,
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    exists: (f) => fs.existsSync(f),
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
  const pageId = o.pageId ?? 20000;

  // Analyse → Setup-Manifest („Rezept"). Die Einrichtung läuft AUSSCHLIESSLICH über setupFromManifest —
  // dieselbe Quelle, die auch der standalone apex-deploy-MCP (Tool apex_setup) nutzt. So wird nichts doppelt
  // „gedacht": das JSON beschreibt die Verwendung, der Runner richtet nur noch daraus ein.
  const manifest = d.buildSetupManifest(exportSql, { pageId, sourceSql: o.sourceSql, repoDir: path.dirname(o.exportFile) });
  const connection = { baseUrl: t.baseUrl, workspace: t.workspace, user: t.user, pass: t.pass, appId, alias: t.alias };
  const r = await d.setupFromManifest(manifest, connection, { pageId, sourceSql: o.sourceSql, install: o.exportFile, setFileUrls: o.setFileUrls }, deps);
  return {
    ...r,
    plugin: an.internalName, displayName: an.displayName,
    analysis: { apiVersion: an.apiVersion, sourceTypePrefix: an.sourceTypePrefix, usesAjaxItemsToSubmit: an.usesAjaxItemsToSubmit },
    manifest, at: d.now(),
  };
}
