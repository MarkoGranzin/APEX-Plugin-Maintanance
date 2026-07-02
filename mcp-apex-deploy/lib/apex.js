/**
 * apex-deploy MCP — reine, offline testbare Kernlogik (keine Abhängigkeiten).
 *
 * Idee: APEX-Exporte (Plugin/Template-Component/Page/App) sind standardisierte SQL-Skripte.
 * Einspielen geht deshalb GENERISCH und headless über SQLcl mit apex_application_install
 * (set_workspace → set_application_id → generate_offset → Export-Datei ausführen) — für
 * JEDES Plugin, ohne UI, ohne KI → minimaler Token-Verbrauch.
 *
 * Resultat: mcp-apex-deploy/lib/apex.js
 */

/** Passwort im Connect-String maskieren — Secrets erscheinen NIE in Ausgaben/Logs. */
export function maskConn(conn) {
  if (!conn) return '(not set)';
  // user/pass@host:port/service  |  user/"pa@ss"@host  → user/***@host...
  return String(conn).replace(/^([^/@]+)\/(?:"[^"]*"|[^@]*)@/, '$1/***@');
}

/**
 * Install-Skript für einen beliebigen APEX-Export bauen (Plugin, Template-Component, Page, App).
 * @param {{exportFile:string, workspace:string, appId?:number|string, offset?:boolean}} o
 */
export function buildInstallScript(o = {}) {
  if (!o.exportFile) throw new Error('exportFile fehlt');
  if (!o.workspace) throw new Error('workspace fehlt');
  const app = o.appId != null && String(o.appId) !== '' ? Number(o.appId) : null;
  const lines = [
    'whenever sqlerror exit failure rollback',
    'set define off',
    'begin',
    `  apex_application_install.set_workspace('${String(o.workspace).replace(/'/g, "''")}');`,
  ];
  if (app != null) lines.push(`  apex_application_install.set_application_id(${app});`);
  if (o.offset !== false) lines.push('  apex_application_install.generate_offset;');
  lines.push('end;', '/', `@"${o.exportFile}"`, 'commit;', 'exit');
  return lines.join('\n') + '\n';
}

/**
 * Ermittelt generisch die „File URLs to Load" eines Plugins aus seinem Export-SQL:
 * alle .js/.css-Plugin-Dateien, JS in der Ladereihenfolge, die der Plugin-Code selbst vorgibt
 * (Reihenfolge der APEX_JAVASCRIPT.ADD_LIBRARY-Aufrufe), CSS analog (ADD_CSS/STYLE) bzw. Datei-Reihenfolge.
 * @returns {{jsUrls:string[], cssUrls:string[], jsFiles:string[], cssFiles:string[]}}
 */
export function pluginLoadFiles(sqlText) {
  const t = String(sqlText || '');
  const files = [...t.matchAll(/p_file_name=>'((?:[^']|'')*)'/gi)].map((m) => m[1].replace(/''/g, "'"));
  const js = files.filter((f) => /\.js$/i.test(f));
  const css = files.filter((f) => /\.css$/i.test(f));
  // p_plsql_code (gejointer String) rekonstruieren, um die ADD_LIBRARY-/ADD_CSS-Reihenfolge zu lesen.
  const m = t.match(/p_plsql_code=>wwv_flow_string\.join\(wwv_flow_t_varchar2\(([\s\S]*?)\)\)/i);
  const code = m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")).join('') : '';
  const namesFrom = (re) => [...code.matchAll(re)].map((x) => x[1]);
  const libOrder = namesFrom(/ADD_LIBRARY\s*\(\s*P_NAME\s*=>\s*'([^']+)'/gi);
  const cssOrder = namesFrom(/ADD_(?:CSS|STYLE|STYLESHEET)\s*\(\s*P_NAME\s*=>\s*'([^']+)'/gi);
  const match = (list, name) => { const n = String(name).toLowerCase(); return list.find((f) => f.replace(/\.(js|css)$/i, '').toLowerCase() === n) || list.find((f) => f.toLowerCase().startsWith(n)); };
  const order = (list, names) => { const out = []; for (const n of names) { const f = match(list, n); if (f && !out.includes(f)) out.push(f); } for (const f of list) if (!out.includes(f)) out.push(f); return out; };
  const orderedJs = order(js, libOrder);
  const orderedCss = order(css, cssOrder);
  const ref = (f) => `#PLUGIN_FILES#${f}`;
  return { jsUrls: orderedJs.map(ref), cssUrls: orderedCss.map(ref), jsFiles: orderedJs, cssFiles: orderedCss };
}

/** Internal name / p_name des Plugins aus einem Export-SQL lesen (create_plugin-Aufruf). */
export function parsePluginName(sqlText) {
  const call = String(sqlText || '').match(/create_plugin\s*\(([\s\S]*?)\)\s*;/i);
  const body = call ? call[1] : String(sqlText || '');
  const m = body.match(/p_name\s*=>\s*'((?:[^']|'')*)'/i);
  return m ? m[1].replace(/''/g, "'") : null;
}

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
// APEX-Strings >~1000 Zeichen müssen als wwv_flow_string.join-Liste geschrieben werden.
function sqlString(s) {
  const str = String(s ?? '');
  if (str.length <= 800) return q(str);
  const parts = [];
  for (let i = 0; i < str.length; i += 800) parts.push(q(str.slice(i, i + 800)));
  return `wwv_flow_string.join(wwv_flow_t_varchar2(\n${parts.join(',\n')}))`;
}

/** Plugin-Attribute im 24.1-Format: wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2('name','wert',...)).to_clob
 *  attributes: { '<attr-name>': '<wert>' } — Attributnamen sind die internen Plugin-Attribut-Schlüssel. */
function pluginAttrsClob(attributes) {
  const pairs = Object.entries(attributes || {}).filter(([, v]) => v != null && v !== '');
  if (!pairs.length) return null;
  const body = pairs.map(([k, v]) => `  ${q(k)}, ${sqlString(v)}`).join(',\n');
  return `wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(\n${body})).to_clob`;
}

/**
 * Generisches Testseiten-Import-SQL (APEX 24.x-Format, wwv_flow_imp*): eine vollständige,
 * über den Import-Wizard einspielbare Seite mit EINER Region vom Plugin-Typ. Ohne gesetzte
 * Attribute nutzt die Region automatisch die Plugin-Defaults (z.B. ConfigJSON-Default aus dem
 * Akzeptanz-Vertrag). Header-Werte (workspaceId/owner/release/version) sind instanzspezifisch.
 *
 * @param {{appId:number|string, pageId?:number|string, pageName?:string, pluginInternalName:string,
 *          sourceSql?:string, attributes?:object, workspaceId?:string, owner?:string,
 *          release?:string, version?:string}} o
 */
export function buildTestPageSql(o = {}) {
  const pluginName = o.pluginInternalName || o.pluginName;
  if (!pluginName) throw new Error('pluginInternalName fehlt');
  if (!o.appId) throw new Error('appId fehlt');
  const pageId = Number(o.pageId ?? 9999);
  const pageName = o.pageName || `Plugin Test: ${pluginName}`;
  const version = o.version || '2024.11.30';
  const release = o.release || '24.2';
  const regionId = `${pageId}00001`; // stabile, page-abgeleitete Region-ID
  const attrsClob = pluginAttrsClob(o.attributes);

  const header = [
    'prompt --application/set_environment',
    'set define off verify off feedback off',
    'whenever sqlerror exit sql.sqlcode rollback',
    'begin',
    'wwv_flow_imp.import_begin (',
    ` p_version_yyyy_mm_dd=>'${version}'`,
    `,p_release=>'${release}'`,
    ...(o.workspaceId ? [`,p_default_workspace_id=>${o.workspaceId}`] : []),
    `,p_default_application_id=>${Number(o.appId)}`,
    ',p_default_id_offset=>0',
    ...(o.owner ? [`,p_default_owner=>'${String(o.owner).replace(/'/g, "''")}'`] : []),
    ');',
    'end;',
    '/',
  ];
  const page = [
    `prompt --application/pages/page_${String(pageId).padStart(5, '0')}`,
    'begin',
    'wwv_flow_imp_page.create_page(',
    ` p_id=>${pageId}`,
    `,p_name=>${q(pageName)}`,
    `,p_step_title=>${q(pageName)}`,
    `,p_autocomplete_on_off=>'OFF'`,
    `,p_page_template_options=>'#DEFAULT#'`,
    // Testseite standardmäßig ÖFFENTLICH → ohne App-End-User-Login smoke-testbar (public:false zum Abschalten).
    ...(o.public === false ? [] : [`,p_page_is_public_y_n=>'Y'`]),
    `,p_protection_level=>'C'`,
    ');',
    'wwv_flow_imp_page.create_page_plug(',
    ` p_id=>wwv_flow_imp.id(${regionId})`,
    `,p_plug_name=>${q('Test: ' + pluginName)}`,
    `,p_region_template_options=>'#DEFAULT#'`,
    `,p_plug_display_sequence=>10`,
    `,p_plug_display_point=>'REGION_POSITION_01'`,
    `,p_plug_source_type=>'NATIVE_PLUGIN_${pluginName.replace(/'/g, "''")}'`,
    // SQL-Datenquelle korrekt als SQL-Query-Region setzen (sonst ist P_REGION.SOURCE leer → SOURCE_SQL-Plugins scheitern).
    ...(o.sourceSql ? [`,p_query_type=>'SQL'`, `,p_plug_source=>${sqlString(o.sourceSql)}`] : []),
    ...(attrsClob ? [`,p_attributes=>${attrsClob}`] : []),
    ');',
    'end;',
    '/',
  ];
  const footer = ['begin', 'wwv_flow_imp.import_end(p_auto_install_sup_obj => false);', 'commit;', 'end;', '/'];
  return [...header, ...page, ...footer].join('\n') + '\n';
}
