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

import { detectEmbeddedAssets } from './plugin-assets.js';

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

/** Einen (evtl. via wwv_flow_string.join gejointen) PL/SQL-Stringwert rekonstruieren.
 *  WICHTIG: NICHT am ersten „))" stoppen — das kommt im SQL/PL-SQL selbst vor (z.B. VALUE(6, 12))).
 *  `raw` ist bereits am nächsten Parameter begrenzt (val()-Lookahead); daher einfach ALLE quoted Teile
 *  einsammeln und mit Zeilenumbruch verbinden (wwv_flow_string.join reassembliert Zeile für Zeile). */
function plsqlValue(raw) {
  if (!raw) return null;
  const parts = [...String(raw).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return parts.length ? parts.join('\n') : null;
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
  // Plugin-TYP (bestimmt, WIE die Testseite eingerichtet wird): Region/Item/Dynamic Action/Template-Component.
  const rawType = g(/p_plugin_type=>'([^']*)'/i, head) || (/create_template_component\b/i.test(t) ? 'TEMPLATE COMPONENT' : null);
  const kind = (/template/i.test(rawType || '') || /create_template_component\b/i.test(t)) ? 'template-component'
    : /item\s*type/i.test(rawType || '') ? 'item'
      : /dynamic\s*action/i.test(rawType || '') ? 'dynamic-action'
        : /region\s*type/i.test(rawType || '') ? 'region'
          : 'other';
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
    const dv = tail.search(/p_default_value=>/i);
    if (dv >= 0) {
      // Block vom p_default_value bis zum NÄCHSTEN Parameter (\n,p_) bzw. Ende der Aufruf-Klammer (\n);) —
      // NICHT am ersten „))" begrenzen (das steht im SQL selbst, z.B. VALUE(6, 12))). Dann alle quoted Teile.
      const after = tail.slice(dv + 'p_default_value=>'.length);
      const end = after.search(/\n\s*,\s*p_[a-z]|\n\s*\)\s*;/i);
      const block = end >= 0 ? after.slice(0, end) : after;
      const parts = [...block.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
      defaultSourceSql = parts.length ? parts.join('\n').trim() : null;
    }
  }

  return {
    internalName, displayName: (g(/p_display_name=>'((?:[^']|'')*)'/i, head) || '').replace(/''/g, "'").trim() || null,
    apiVersion,
    pluginType: rawType, kind, // Region/Item/Dynamic Action/Template-Component → bestimmt die Einricht-Art
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
/** APEX-Item-Liste („P1_A, P1_B:P1_C") in Namen zerlegen — Trenner Komma/Doppelpunkt/Whitespace. */
function splitItemList(v) {
  return String(v || '').split(/[,:\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * T-149 — die Page-Items, die eine Testseite für DIESES Plugin braucht, generisch ableiten (dedupliziert,
 * auf die Testseiten-ID gemappt). Quellen:
 *   (a) Custom-Attribut „Items to Submit"/„Items2Submit" → dessen Wert ist eine Item-LISTE (Mehrzahl!),
 *   (b) :P<n>_NAME-Binds in der Region-Beispiel-SQL UND in den PL/SQL-Attribut-Defaults (async/save/download),
 *   Fallback: synthetisches P<id>_AJAX, wenn das Plugin AJAX_ITEMS_TO_SUBMIT deklariert, aber nichts erkannt wurde.
 * Interne Binds OHNE P<n>_-Muster (:PK/:ITEM_ID/:CLOB/:RESULT…) sind KEINE Page-Items (setzt das Plugin-JS) → ignoriert.
 * `submit`=true kennzeichnet Items, die in die Region-Eigenschaft „Items to Submit" gehören.
 * @returns {Array<{name:string, type:'Hidden', ajaxItemsToSubmit:boolean}>}
 */
export function detectPageItems(a, pageId) {
  const items = new Map(); // gemappter NAME → {name, submit}
  const add = (raw, submit) => {
    const n = String(raw || '').trim().toUpperCase();
    if (!/^P\d+_[A-Z0-9_]+$/.test(n)) return; // nur echte Page-Item-Namen (P<seite>_NAME)
    const mapped = n.replace(/^P\d+_/, `P${pageId}_`); // Beispiel-Seite (P1_…) → Testseite (P<id>_…)
    const cur = items.get(mapped) || { name: mapped, submit: false };
    cur.submit = cur.submit || !!submit;
    items.set(mapped, cur);
  };
  for (const at of a.customAttributes || []) {
    if (/items?\s*2?\s*(to\s*)?submit/i.test(at.prompt || '')) for (const n of splitItemList(at.default)) add(n, true);
  }
  const haystack = [a.defaultSourceSql || '', ...(a.customAttributes || []).map((x) => x.default || '')].join('\n');
  for (const m of haystack.matchAll(/:(P\d+_[A-Z0-9_]+)/gi)) add(m[1], false);
  if (a.usesAjaxItemsToSubmit && ![...items.values()].some((i) => i.submit)) add(`P${pageId}_AJAX`, true);
  return [...items.values()].map((i) => ({ name: i.name, type: 'Hidden', ajaxItemsToSubmit: i.submit }));
}

export function buildSetupManifest(sqlText, opts = {}) {
  const a = analyzePlugin(sqlText);
  const { jsUrls, cssUrls } = pluginLoadFiles(sqlText);
  // B-38: Lädt das Plugin seine Dateien SELBST (PL/SQL-Render mit APEX_JAVASCRIPT.ADD_LIBRARY/APEX_CSS),
  // dürfen KEINE „File URLs to Load" gesetzt werden — sonst wird jedes File doppelt geladen
  // („Identifier … has already been declared"). Evidenz-basiert aus dem Export erkannt, generisch.
  const selfLoadsFiles = /\bAPEX_JAVASCRIPT\s*\.\s*ADD_LIBRARY\b|\bAPEX_CSS\s*\.\s*ADD(_FILE|_3RD_PARTY_LIBRARY_FILE)?\b/i.test(String(sqlText || ''));
  const pageId = Number(opts.pageId ?? 20000); // Default-Basis 20000 (nie reservierte App-Seiten)
  const pageItems = detectPageItems(a, pageId); // T-149: ALLE benötigten Page-Items (Mehrzahl), nicht ein synthetisches
  const clean = (v) => (v != null ? String(v).replace(/[\x00-\x1f]+/g, ' ').trim() : null);
  return {
    manifestVersion: 1,
    plugin: {
      internalName: a.internalName,
      displayName: a.displayName,
      apiVersion: a.apiVersion,
      pluginType: a.pluginType, // roher APEX-Typ (z.B. „REGION TYPE", „ITEM TYPE")
      kind: a.kind, // normalisiert: region | item | dynamic-action | template-component | other
      regionSourceType: a.internalName ? `${a.sourceTypePrefix}${a.internalName}` : null,
      hasAjaxCallback: a.hasAjaxCallback,
      selfLoadsFiles, // lädt seine JS/CSS selbst im Render → keine File URLs setzen (B-38)
    },
    standardAttributes: a.standardAttributes,
    testPage: {
      id: pageId,
      name: `Live-Test: ${a.internalName || 'plugin'}`,
      isPublic: true,
      // Wie die Testseite gebaut wird: region = Plugin-Region; item = Page-Item vom Plugin-Typ;
      // dynamic-action/template-component = eigener Aufbau (noch nicht automatisiert).
      setupKind: a.kind,
      region: { name: `Test: ${a.internalName || 'plugin'}`, plugin: a.displayName || a.internalName },
      // Bei Item-Plugins: das Page-Item VOM Plugin-Typ, das in einer Host-Region angelegt wird.
      item: a.kind === 'item' ? { name: `P${pageId}_ITEM`, plugin: a.displayName || a.internalName, hostRegion: 'Host' } : null,
      // Bei Dynamic-Action-Plugins: die DA auf einem Event mit dem Plugin als True-Aktion, Ziel = Selektor.
      dynamicAction: a.kind === 'dynamic-action' ? { event: 'Page Load', action: a.displayName || a.internalName, selectionType: 'jQuery Selector', selector: 'body' } : null,
      // Bei Template-Component-Plugins (region-artig, datengebunden): Beispiel-SQL + Best-Effort-Spalten-Mapping.
      templateComponent: a.kind === 'template-component' ? {
        region: { name: `Test: ${a.internalName || 'plugin'}`, plugin: a.displayName || a.internalName },
        source: { type: 'SQL Query', sql: opts.sourceSql || "select level as id, 'Card '||level as title, 'Backside '||level as subtitle from dual connect by level<=4" },
        columnMap: { Title: '&TITLE.', Subtitle: '&SUBTITLE.' },
      } : null,
      // T-149: ALLE benötigten Page-Items (Hidden) + „Items to Submit"-Liste der Region. pageItem (Einzel)
      // bleibt rückwärtskompatibel = das erste Item; itemsToSubmit = die als submit markierten Namen.
      pageItems,
      pageItem: pageItems[0] || null,
      itemsToSubmit: pageItems.filter((i) => i.ajaxItemsToSubmit).map((i) => i.name),
      // Datenquelle: eigene SQL des Aufrufers, sonst die plugin-eigene Beispielquery UNVERÄNDERT.
      // (Bewusst KEIN Heraus-Filtern von ASYNC-Blöcken: die Beispiel-SQL des Autors ist als Ganzes
      // lauffähig; ein chirurgischer Umbau brach live den getData-PL/SQL-Abruf. Async-Items ohne
      // AJAX-Prozess zeigen auf der Testseite ihre Fehler-Kachel — dokumentiertes Beispiel-Verhalten.)
      source: a.hasSourceSql ? { type: 'SQL Query', sql: opts.sourceSql || a.defaultSourceSql || null } : null,
    },
    // Region-Attribute (ConfigJSON etc.) — im Page Designer je Prompt-Label zu setzen.
    attributes: (a.customAttributes || []).map((x) => ({ key: x.key, prompt: x.prompt, required: !!x.required, default: clean(x.default) })),
    // File URLs to Load am Plugin (Shared Components → Plug-ins), #PLUGIN_FILES#-Referenzen.
    // Bei selbst-ladenden Plugins bewusst LEER (B-38) — setupFromManifest räumt dort ggf. Altbestand weg.
    fileUrls: selfLoadsFiles ? { js: [], css: [] } : { js: jsUrls, css: cssUrls },
    // B-40 (generisch): Herkunft der in die .sql eingebetteten Laufzeit-Assets (bundle/copy/unknown) —
    // von der Analyse festgestellt und ins Manifest überführt, damit Update/Import die Assets aus den
    // (aktualisierten) Quellen neu erzeugen und re-einbetten kann. Nur wenn ein Repo-Verzeichnis vorliegt.
    assets: opts.repoDir ? detectEmbeddedAssets(sqlText, opts.repoDir, opts.assetDeps) : undefined,
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
