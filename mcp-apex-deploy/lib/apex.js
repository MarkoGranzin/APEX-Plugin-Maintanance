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

  // Beispiel-/Default-Query der SOURCE_SQL-Standard-Attribute (create_plugin_std_attribute p_name='SOURCE_SQL').
  // Dient als Fallback-Datenquelle für die Testseite, wenn der Aufrufer keine eigene SQL übergibt — so rendert
  // ein SOURCE_SQL-Plugin auch über den GUI-Button mit echten Daten (statt „no data found").
  let defaultSourceSql = null;
  if (/p_name=>'SOURCE_SQL'/i.test(t)) {
    const tail = t.slice(t.search(/p_name=>'SOURCE_SQL'/i));
    const joinM = tail.match(/p_default_value=>wwv_flow_string\.join\(wwv_flow_t_varchar2\(([\s\S]*?)\)\)/i);
    const litM = tail.match(/p_default_value=>'((?:[^']|'')*)'/i);
    if (joinM) {
      const parts = [...joinM[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
      defaultSourceSql = parts.length ? parts.join('\n').trim() : null;
    } else if (litM) {
      defaultSourceSql = litM[1].replace(/''/g, "'").trim();
    }
  }

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
    defaultSourceSql,
  };
}

/**
 * Setup-Manifest („Rezept") für EIN Plugin: alles, was zum Einrichten einer Testseite nötig ist —
 * Region-Typ, benötigtes Page-Item + AJAX-Wiring, Datenquelle (eigene oder plugin-Beispielquery),
 * Attribute mit Defaults, JS/CSS-File-URLs. Rein aus der Analyse abgeleitet (kein APEX nötig), sodass
 * eine quasi-statische App / ein Page-Designer-Runner damit generisch einrichten kann.
 * @param {string} sqlText  Plugin-Export-SQL
 * @param {{pageId?:number, sourceSql?:string}} [opts]
 */
export function buildSetupManifest(sqlText, opts = {}) {
  const a = analyzePlugin(sqlText);
  const { jsUrls, cssUrls } = pluginLoadFiles(sqlText);
  const pageId = Number(opts.pageId ?? 9999);
  const ajaxItem = a.usesAjaxItemsToSubmit ? `P${pageId}_AJAX` : null;
  const clean = (v) => (v != null ? String(v).replace(/[\x00-\x1f]+/g, ' ').trim() : null);
  return {
    manifestVersion: 1,
    plugin: {
      internalName: a.internalName,
      displayName: a.displayName,
      apiVersion: a.apiVersion,
      regionSourceType: a.internalName ? `${a.sourceTypePrefix}${a.internalName}` : null,
      hasAjaxCallback: a.hasAjaxCallback,
    },
    standardAttributes: a.standardAttributes,
    testPage: {
      id: pageId,
      name: `Live-Test: ${a.internalName || 'plugin'}`,
      isPublic: true,
      region: { name: `Test: ${a.internalName || 'plugin'}`, plugin: a.displayName || a.internalName },
      // Page-Item, das die Region über „Items to Submit" referenziert (Pflicht bei AJAX_ITEMS_TO_SUBMIT).
      pageItem: ajaxItem ? { name: ajaxItem, type: 'Hidden', ajaxItemsToSubmit: true } : null,
      // Datenquelle: eigene SQL des Aufrufers, sonst die plugin-eigene Beispielquery.
      source: a.hasSourceSql ? { type: 'SQL Query', sql: opts.sourceSql || a.defaultSourceSql || null } : null,
    },
    // Region-Attribute (ConfigJSON etc.) — im Page Designer je Prompt-Label zu setzen.
    attributes: (a.customAttributes || []).map((x) => ({ key: x.key, prompt: x.prompt, required: !!x.required, default: clean(x.default) })),
    // File URLs to Load am Plugin (Shared Components → Plug-ins), #PLUGIN_FILES#-Referenzen.
    fileUrls: { js: jsUrls, css: cssUrls },
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
// Kurze EINZEILIGE Werte als Literal; alles Mehrzeilige oder Lange als wwv_flow_string.join.
// Die Import-Engine akzeptiert KEINE rohen Zeilenumbrüche in einem einzelnen Literal (→ „Bad Request").
// wwv_flow_string.join reassembliert die Elemente mit chr(10) → jede ZEILE als eigenes Element gibt
// mehrzeilige SQL byte-genau zurück (wie echte APEX-Exports).
function sqlString(s) {
  const str = String(s ?? '');
  if (str.length <= 800 && !str.includes('\n')) return q(str);
  const parts = [];
  for (const line of str.split('\n')) {
    if (line.length <= 800) parts.push(q(line));
    else for (let i = 0; i < line.length; i += 800) parts.push(q(line.slice(i, i + 800)));
  }
  return `wwv_flow_string.join(wwv_flow_t_varchar2(\n${parts.join(',\n')}))`;
}

/** Wert für ein einzelnes Plugin-Attribut. Kurze Werte (JSON-Configs etc.) als EIN Literal —
 *  separator-unabhängig sicher; lange Werte (>3900) als wwv_flow_string.join (byte-exakt reassembliert). */
function attrValue(v) {
  const s = String(v ?? '');
  return s.length <= 3900 ? q(s) : sqlString(s);
}

/** Plugin-Region-Attribute im create_page_plug-Format (wwv_flow_api/wwv_flow_imp_page): direkte
 *  Parameter p_attribute_01, p_attribute_02, … — NICHT als p_attributes-Clob (den kennt create_page_plug
 *  nicht → würde ignoriert; verifiziert am Sample-Export material-kanban-board).
 *  attributes: { 'attribute_NN'|'p_attribute_NN': '<wert>' }. Liefert Array von ',p_attribute_NN=>…'-Zeilen. */
function pluginAttrLines(attributes) {
  return Object.entries(attributes || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const key = /^\d+$/.test(k) ? `p_attribute_${String(k).padStart(2, '0')}`
        : /^attribute_\d+$/i.test(k) ? `p_${k}`
        : /^p_attribute_\d+$/i.test(k) ? k : `p_${k}`;
      return `,${key.toLowerCase()}=>${attrValue(v)}`;
    });
}

/**
 * Generisches Testseiten-Import-SQL (APEX 24.x, öffentliche wwv_flow_api.* wie echte Exports):
 * eine vollständige Seite mit EINER Region vom Plugin-Typ. Ohne gesetzte Attribute nutzt die Region
 * die Plugin-Defaults. HINWEIS (B-28): p_attribute_NN persistiert NICHT über den App-Builder-
 * Page-Import-Wizard — für gesetzte Config braucht es einen anderen Weg (Import-SQL als Skript
 * ausführen / Page Designer). Header-Werte (workspaceId/owner/release/version) sind instanzspezifisch.
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
  const attrLines = pluginAttrLines(o.attributes);
  // Braucht das Plugin „Items to Submit" (AJAX), MUSS ein Page-Item existieren, auf das die Region zeigt —
  // sonst scheitert PAGE_ITEM_NAMES_TO_JQUERY im Plugin-Render mit ORA-01403 (verifiziert an Seite 2).
  const ajaxItem = o.ajaxItemName || (o.needsAjaxItem ? `P${pageId}_AJAX` : null);

  const header = [
    'prompt --application/set_environment',
    'set define off verify off feedback off',
    'whenever sqlerror exit sql.sqlcode rollback',
    'begin',
    'wwv_flow_api.import_begin (',
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
    'wwv_flow_api.create_page(',
    ` p_id=>${pageId}`,
    `,p_name=>${q(pageName)}`,
    `,p_step_title=>${q(pageName)}`,
    `,p_autocomplete_on_off=>'OFF'`,
    `,p_page_template_options=>'#DEFAULT#'`,
    // Testseite standardmäßig ÖFFENTLICH → ohne App-End-User-Login smoke-testbar (public:false zum Abschalten).
    ...(o.public === false ? [] : [`,p_page_is_public_y_n=>'Y'`]),
    `,p_protection_level=>'C'`,
    ');',
    'wwv_flow_api.create_page_plug(',
    ` p_id=>wwv_flow_api.id(${regionId})`,
    `,p_plug_name=>${q('Test: ' + pluginName)}`,
    `,p_region_template_options=>'#DEFAULT#'`,
    `,p_plug_display_sequence=>10`,
    `,p_plug_display_point=>'REGION_POSITION_01'`,
    `,p_plug_source_type=>'${sourcePrefix}${pluginName.replace(/'/g, "''")}'`,
    // SQL-Datenquelle korrekt als SQL-Query-Region setzen (sonst ist P_REGION.SOURCE leer → SOURCE_SQL-Plugins scheitern).
    ...(o.sourceSql ? [`,p_query_type=>'SQL'`, `,p_plug_source=>${sqlString(o.sourceSql)}`] : []),
    ...(ajaxItem ? [`,p_ajax_items_to_submit=>${q(ajaxItem)}`] : []),
    ...attrLines,
    ');',
    // Page-Item anlegen, das die Region über „Items to Submit" referenziert (Plugin-Voraussetzung).
    ...(ajaxItem ? [
      'wwv_flow_api.create_page_item(',
      ` p_id=>wwv_flow_api.id(${regionId}1)`,
      `,p_name=>${q(ajaxItem)}`,
      `,p_item_sequence=>10`,
      `,p_item_plug_id=>wwv_flow_api.id(${regionId})`,
      `,p_display_as=>'NATIVE_HIDDEN'`,
      ');',
    ] : []),
    'end;',
    '/',
  ];
  const footer = ['begin', 'wwv_flow_api.import_end(p_auto_install_sup_obj => false);', 'commit;', 'end;', '/'];
  return [...header, ...page, ...footer].join('\n') + '\n';
}
