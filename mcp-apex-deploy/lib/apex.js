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

/** Einen (evtl. via wwv_flow_string.join gejointen) PL/SQL-Stringwert rekonstruieren. */
function plsqlValue(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const join = s.match(/wwv_flow_string\.join\(wwv_flow_t_varchar2\(([\s\S]*?)\)\)/i);
  const body = join ? join[1] : s;
  const parts = [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return parts.length ? parts.join('') : null;
}

/**
 * GRÜNDLICHE Plugin-Analyse fürs Einrichten einer funktionierenden Testseite (generisch, aus dem Export).
 * Leitet ab, was die Region/Seite braucht — inkl. der Fälle „Page-Item + AJAX_ITEMS_TO_SUBMIT nötig".
 * @returns {{internalName,displayName,apiVersion,sourceTypePrefix,standardAttributes:string[],
 *   hasSourceSql:boolean, usesAjaxItemsToSubmit:boolean, hasAjaxCallback:boolean,
 *   customAttributes:Array<{sequence:number,key:string,prompt:string,default:string|null,required:boolean}>,
 *   configAttributeKey:string|null, configDefault:string|null}}
 */
export function analyzePlugin(sqlText) {
  const t = String(sqlText || '');
  // Kopf des create_plugin (bis zum ersten Attribut) — der Plugin-Name steht dort, nicht in den Attributen.
  const headEnd = t.search(/create_plugin_attribute/i); const head = headEnd > 0 ? t.slice(0, headEnd) : t;
  const g = (re, src = t) => (src.match(re) || [])[1] || null;
  const internalName = g(/p_name=>'((?:[^']|'')*)'/i, head);
  const apiVersion = Number(g(/p_api_version=>(\d+)/i) || 1);
  const standard = (g(/p_standard_attributes=>'([^']*)'/i) || '').split(':').map((s) => s.trim()).filter(Boolean);
  const hasAjaxFn = /p_ajax_function=>/i.test(t);
  const usesGetAjaxId = /GET_AJAX_IDENTIFIER/i.test(t);

  // Custom-Attribute (create_plugin_attribute): Sequenz, Prompt, Default, Pflicht. Werte enden am nächsten „\n,p_" bzw. „\n);".
  const customAttributes = [];
  for (const m of t.matchAll(/create_plugin_attribute\(([\s\S]*?)\n\s*\);/gi)) {
    const blk = m[1];
    const seq = Number((blk.match(/p_attribute_sequence=>(\d+)/i) || [])[1] || 0);
    if (!seq) continue;
    const val = (name) => { const mm = blk.match(new RegExp('p_' + name + '=>([\\s\\S]*?)(?=\\n\\s*,p_|$)', 'i')); return mm ? plsqlValue(mm[1]) : null; };
    customAttributes.push({
      sequence: seq,
      key: `attribute_${String(seq).padStart(2, '0')}`,
      prompt: (blk.match(/p_prompt=>'((?:[^']|'')*)'/i) || [])[1]?.replace(/''/g, "'") || '',
      default: val('default_value'),
      required: /p_is_required=>true/i.test(blk),
    });
  }
  // „Config/JSON"-Attribut heuristisch (Prompt enthält JSON/Config), sonst erstes Attribut.
  const cfg = customAttributes.find((a) => /json|config/i.test(a.prompt)) || customAttributes[0] || null;
  return {
    internalName, displayName: (g(/p_display_name=>'((?:[^']|'')*)'/i, head) || '').replace(/''/g, "'").trim() || null,
    apiVersion,
    sourceTypePrefix: apiVersion >= 2 ? 'NATIVE_PLUGIN_' : 'PLUGIN_',
    standardAttributes: standard,
    hasSourceSql: standard.includes('SOURCE_SQL'),
    usesAjaxItemsToSubmit: standard.includes('AJAX_ITEMS_TO_SUBMIT'),
    hasAjaxCallback: hasAjaxFn || usesGetAjaxId,
    customAttributes,
    configAttributeKey: cfg?.key || null,
    configDefault: cfg?.default || null,
  };
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
  const sourcePrefix = o.sourceTypePrefix || 'NATIVE_PLUGIN_'; // aus der Analyse: api_version 1 → PLUGIN_, sonst NATIVE_PLUGIN_
  const attrsClob = pluginAttrsClob(o.attributes);
  // Braucht das Plugin „Items to Submit" (AJAX), MUSS ein Page-Item existieren, auf das die Region zeigt —
  // sonst scheitert PAGE_ITEM_NAMES_TO_JQUERY im Plugin-Render mit ORA-01403 (verifiziert an Seite 2).
  const ajaxItem = o.ajaxItemName || (o.needsAjaxItem ? `P${pageId}_AJAX` : null);

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
    `,p_plug_source_type=>'${sourcePrefix}${pluginName.replace(/'/g, "''")}'`,
    // SQL-Datenquelle korrekt als SQL-Query-Region setzen (sonst ist P_REGION.SOURCE leer → SOURCE_SQL-Plugins scheitern).
    ...(o.sourceSql ? [`,p_query_type=>'SQL'`, `,p_plug_source=>${sqlString(o.sourceSql)}`] : []),
    ...(ajaxItem ? [`,p_ajax_items_to_submit=>${q(ajaxItem)}`] : []),
    ...(attrsClob ? [`,p_attributes=>${attrsClob}`] : []),
    ');',
    // Page-Item anlegen, das die Region über „Items to Submit" referenziert (Plugin-Voraussetzung).
    ...(ajaxItem ? [
      'wwv_flow_imp_page.create_page_item(',
      ` p_id=>wwv_flow_imp.id(${regionId}1)`,
      `,p_name=>${q(ajaxItem)}`,
      `,p_item_sequence=>10`,
      `,p_item_plug_id=>wwv_flow_imp.id(${regionId})`,
      `,p_display_as=>'NATIVE_HIDDEN'`,
      ');',
    ] : []),
    'end;',
    '/',
  ];
  const footer = ['begin', 'wwv_flow_imp.import_end(p_auto_install_sup_obj => false);', 'commit;', 'end;', '/'];
  return [...header, ...page, ...footer].join('\n') + '\n';
}
