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

/**
 * Generisches Testseiten-SQL: EINE Region vom Plugin-Typ, Attribute (01..25) aus der
 * Schnittstelle/dem Akzeptanz-Vertrag gefüttert.
 *
 * Zwei Modi:
 *  - template: ein ECHTER Seiten-Export der Ziel-Instanz als Vorlage (empfohlen, robust) —
 *    Seiten-ID/-Name werden ersetzt, die Plugin-Region samt Attributen wird injiziert/ersetzt.
 *  - skeleton: minimales Page-Import-SQL aus eingebautem Gerüst (best effort; API-Package und
 *    Versionszeile sind versionsabhängig → auf der Ziel-Instanz verifizieren).
 *
 * @param {{appId:number|string, pageId?:number|string, pageName?:string, pluginName:string,
 *          attributes?:string[], apiPackage?:string, versionLine?:string, template?:string}} o
 */
export function buildTestPageSql(o = {}) {
  if (!o.pluginName) throw new Error('pluginName fehlt');
  const pageId = Number(o.pageId ?? 9999);
  const pageName = o.pageName || `Plugin Test: ${o.pluginName}`;
  const attrs = (o.attributes || []).slice(0, 25);
  const attrLines = attrs
    .map((v, i) => (v == null || v === '' ? null : `,p_attribute_${String(i + 1).padStart(2, '0')}=>${sqlString(v)}`))
    .filter(Boolean)
    .join('\n');

  if (o.template) {
    // Vorlagen-Modus: Seiten-ID/-Name tauschen + Plugin-Typ und Attribute der ERSTEN Plugin-Region ersetzen.
    let t = String(o.template);
    t = t.replace(/(p_id\s*=>\s*wwv_flow_imp\.id\()\d+(\))/i, `$1${pageId}$2`);
    t = t.replace(/(create_page\s*\([\s\S]*?p_name\s*=>\s*)'((?:[^']|'')*)'/i, `$1${q(pageName)}`);
    t = t.replace(/(p_plugin_name\s*=>\s*)'((?:[^']|'')*)'/i, `$1${q(o.pluginName)}`)
         .replace(/(p_(?:plug_)?source_type\s*=>\s*)'PLUGIN_[^']*'/i, `$1'PLUGIN_${o.pluginName.replace(/'/g, "''").toUpperCase()}'`);
    if (attrLines) {
      // vorhandene p_attribute_NN der Region entfernen, neue einsetzen (vor dem schließenden ");" des create_page_plug)
      t = t.replace(/,\s*p_attribute_\d{2}\s*=>\s*(?:'(?:[^']|'')*'|wwv_flow_string\.join\([\s\S]*?\)\))/gi, '');
      t = t.replace(/(create_page_plug\s*\([\s\S]*?)(\)\s*;)/i, `$1\n${attrLines}\n$2`);
    }
    return t;
  }

  // Gerüst-Modus (best effort): minimale Seite + Plugin-Region. API-Package/Version parametrisierbar.
  const api = o.apiPackage || 'wwv_flow_imp_page';
  const core = (o.apiPackage || '').includes('api') ? 'wwv_flow_api' : 'wwv_flow_imp';
  const versionLine = o.versionLine || "p_version_yyyy_mm_dd=>'2024.11.30'";
  return [
    `prompt --application/pages/page_${String(pageId).padStart(5, '0')}`,
    'begin',
    `${core}.component_begin (`,
    ` ${versionLine}`,
    `,p_default_application_id=>${Number(o.appId)}`,
    `,p_default_id_offset=>0`,
    `);`,
    `${api}.create_page(`,
    ` p_id=>${pageId}`,
    `,p_name=>${q(pageName)}`,
    `,p_alias=>${q('PLUGIN-TEST-' + pageId)}`,
    `,p_step_title=>${q(pageName)}`,
    `,p_autocomplete_on_off=>'OFF'`,
    `,p_page_template_options=>'#DEFAULT#'`,
    `,p_protection_level=>'C'`,
    `);`,
    `${api}.create_page_plug(`,
    ` p_id=>${core}.id(${pageId}0001)`,
    `,p_plug_name=>${q('Test: ' + o.pluginName)}`,
    `,p_region_template_options=>'#DEFAULT#'`,
    `,p_plug_display_sequence=>10`,
    `,p_plug_source_type=>${q('PLUGIN_' + o.pluginName.toUpperCase())}`,
    `,p_plugin_name=>${q(o.pluginName)}`,
    attrLines,
    `);`,
    `${core}.component_end;`,
    'end;',
    '/',
  ].filter((l) => l !== '').join('\n') + '\n';
}
