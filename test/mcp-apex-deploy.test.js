import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildInstallScript, buildTestPageSql, parsePluginName, maskConn, pluginLoadFiles, analyzePlugin, buildSetupManifest, detectPageItems } from '../mcp-apex-deploy/lib/apex.js';
import * as apexUi from '../mcp-apex-deploy/lib/apex-ui.js';

describe('F-31 T-128 apex-deploy: Install-Skript & Sicherheit', () => {
  it('Install-Skript setzt den APEX-Kontext generisch (workspace, appId, offset, Datei, commit)', () => {
    const s = buildInstallScript({ exportFile: 'D:/x/plugin.sql', workspace: 'WS_TEST', appId: 100 });
    expect(s).toMatch(/apex_application_install\.set_workspace\('WS_TEST'\)/);
    expect(s).toMatch(/apex_application_install\.set_application_id\(100\)/);
    expect(s).toMatch(/apex_application_install\.generate_offset/);
    expect(s).toMatch(/@"D:\/x\/plugin\.sql"/);
    expect(s).toMatch(/commit;/);
    expect(s).toMatch(/whenever sqlerror exit failure/);
  });

  it('ohne Pflichtangaben → klarer Fehler', () => {
    expect(() => buildInstallScript({ workspace: 'W' })).toThrow(/exportFile/);
    expect(() => buildInstallScript({ exportFile: 'x.sql' })).toThrow(/workspace/);
  });

  it('B-69: baseDir beschränkt die ausgeführte exportFile auf ein Verzeichnis', () => {
    const base = process.platform === 'win32' ? 'D:\\repo' : '/repo';
    const outside = process.platform === 'win32' ? 'D:\\evil\\x.sql' : '/evil/x.sql';
    // innerhalb → ok
    expect(() => buildInstallScript({ exportFile: `${base}${path.sep}plugin.sql`, workspace: 'W', baseDir: base })).not.toThrow();
    // absoluter Pfad außerhalb → wirft
    expect(() => buildInstallScript({ exportFile: outside, workspace: 'W', baseDir: base })).toThrow(/außerhalb/);
    // ../-Ausbruch → wirft
    expect(() => buildInstallScript({ exportFile: `${base}${path.sep}..${path.sep}evil.sql`, workspace: 'W', baseDir: base })).toThrow(/außerhalb/);
    // ohne baseDir → keine Beschränkung (rückwärtskompatibel)
    expect(() => buildInstallScript({ exportFile: outside, workspace: 'W' })).not.toThrow();
  });

  it('B-67: assertSafeApexBaseUrl erzwingt http(s) + https außerhalb localhost (kein Klartext-Credential-Leak)', () => {
    // https überall ok
    expect(() => apexUi.assertSafeApexBaseUrl('https://apex.example.com/ords')).not.toThrow();
    // http nur für localhost
    expect(() => apexUi.assertSafeApexBaseUrl('http://localhost:8080/ords')).not.toThrow();
    expect(() => apexUi.assertSafeApexBaseUrl('http://127.0.0.1/ords')).not.toThrow();
    // http auf fremdem Host → würde Passwort im Klartext senden → wirft
    expect(() => apexUi.assertSafeApexBaseUrl('http://evil.example.com/ords')).toThrow(/https/);
    // fremdes Schema (file:/javascript:) → wirft
    expect(() => apexUi.assertSafeApexBaseUrl('file:///etc/passwd')).toThrow(/http/);
    // Unfug → wirft
    expect(() => apexUi.assertSafeApexBaseUrl('not-a-url')).toThrow(/URL/);
  });

  it('B-67: uiLogin liefert bei unsicherer baseUrl einen Fehler und navigiert nicht dorthin', async () => {
    let navigated = null;
    const fakePage = { goto: async (u) => { navigated = u; }, getByPlaceholder: () => ({ count: async () => 0 }), locator: () => ({ count: async () => 0 }), url: () => '' };
    const r = await apexUi.uiLogin(fakePage, { baseUrl: 'http://evil.example.com', workspace: 'W', user: 'u', pass: 'p' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/);
    expect(navigated).toBeNull(); // nie zum unsicheren Host navigiert
  });

  it('parsePluginName liest p_name aus dem Export', () => {
    const sql = `wwv_flow_api.create_plugin(\n p_id=>wwv_flow_api.id(123)\n,p_plugin_type=>'REGION TYPE'\n,p_name=>'DE.AISS.APEXFLOWCHART'\n,p_display_name=>'ApexFlowChart'\n);`;
    expect(parsePluginName(sql)).toBe('DE.AISS.APEXFLOWCHART');
  });

  it('pluginLoadFiles: JS in ADD_LIBRARY-Reihenfolge, CSS getrennt, #PLUGIN_FILES#-Referenzen', () => {
    const sql = [
      `,p_file_name=>'mxClient.min.js'`,
      `,p_file_name=>'preScript.js'`,
      `,p_file_name=>'style.css'`,
      `,p_file_name=>'script.min.js'`,
      `,p_file_name=>'LICENSE'`,
      `,p_plsql_code=>wwv_flow_string.join(wwv_flow_t_varchar2(`,
      `'  APEX_JAVASCRIPT.ADD_LIBRARY( P_NAME => ''preScript'', P_DIRECTORY => X );'`,
      `,'  APEX_JAVASCRIPT.ADD_LIBRARY( P_NAME => ''mxClient.min'', P_DIRECTORY => X );'`,
      `,'  APEX_JAVASCRIPT.ADD_LIBRARY( P_NAME => ''script.min'', P_DIRECTORY => X );'`,
      `,'  APEX_CSS.ADD_STYLE( P_NAME => ''style'' );'))`,
    ].join('\n');
    const r = pluginLoadFiles(sql);
    expect(r.jsUrls).toEqual(['#PLUGIN_FILES#preScript.js', '#PLUGIN_FILES#mxClient.min.js', '#PLUGIN_FILES#script.min.js']);
    expect(r.cssUrls).toEqual(['#PLUGIN_FILES#style.css']);
  });

  it('pluginLoadFiles: ohne CSS-Dateien → cssUrls leer (sofern vorhanden)', () => {
    const r = pluginLoadFiles(`,p_file_name=>'app.js'\n,p_file_name=>'LICENSE'`);
    expect(r.jsUrls).toEqual(['#PLUGIN_FILES#app.js']);
    expect(r.cssUrls).toEqual([]);
  });

  it('maskConn maskiert das Passwort — Secrets nie in Ausgaben', () => {
    expect(maskConn('scott/tiger@db:1521/xe')).toBe('scott/***@db:1521/xe');
    expect(maskConn('scott/"t@ig"er"@db')).not.toContain('tiger');
    expect(maskConn('')).toBe('(not set)');
  });
});

describe('F-31 T-129 apex-deploy: generische Testseite (APEX 24.x-Format)', () => {
  const CFG = '{"refresh":0,"style":[{"name":"default"}]}';

  it('vollständige, importierbare Seite: Header + create_page + Plugin-Region + Footer', () => {
    const sql = buildTestPageSql({ appId: 200000, pageId: 9999, pluginInternalName: 'APEX.FLOW.CHART.1', workspaceId: '123', owner: 'WKSP_DEMO' });
    // Öffentliche wwv_flow_api.*-Aufrufe (versions-stabil, wie echte APEX-Exports) statt interner wwv_flow_imp*.
    expect(sql).toMatch(/wwv_flow_api\.import_begin/);
    expect(sql).toContain('p_default_application_id=>200000');
    expect(sql).toContain('p_default_workspace_id=>123');
    expect(sql).toContain(`p_default_owner=>'WKSP_DEMO'`);
    expect(sql).toMatch(/wwv_flow_api\.create_page\(/);
    expect(sql).toMatch(/wwv_flow_api\.create_page_plug\(/);
    expect(sql).toContain(`p_plug_source_type=>'NATIVE_PLUGIN_APEX.FLOW.CHART.1'`);
    expect(sql).toContain('p_id=>9999');
    expect(sql).toMatch(/wwv_flow_api\.import_end/);
  });

  it('ohne Attribute → keine p_attributes (Region nutzt Plugin-Defaults)', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X' });
    expect(sql).not.toContain('p_attributes=>');
  });

  it('mit Attributen → direkte p_attribute_NN-Parameter (create_page_plug-Format, kein Clob)', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', attributes: { '1': CFG } });
    // Korrektes Format: p_attribute_01 direkt an create_page_plug — NICHT p_attributes-Clob (den ignoriert die API).
    expect(sql).toMatch(/,p_attribute_01=>/);
    expect(sql).not.toContain('p_attributes=>');
    expect(sql).not.toContain('to_clob');
    expect(sql).toContain('refresh');
    // kurzer Wert → EIN Literal (separator-unabhängig gültiges JSON)
    const lit = (sql.match(/,p_attribute_01=>'((?:[^']|'')*)'/) || [])[1]?.replace(/''/g, "'");
    expect(() => JSON.parse(lit)).not.toThrow();
  });

  it('langer Attributwert (>3900) → wwv_flow_string.join (byte-exakt)', () => {
    const big = '{"a":"' + 'x'.repeat(4200) + '"}';
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', attributes: { '1': big } });
    expect(sql).toMatch(/,p_attribute_01=>wwv_flow_string\.join\(wwv_flow_t_varchar2\(/);
  });

  it('sourceSql wird als Region-Quelle gesetzt', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', sourceSql: 'select 1 id, 0 pid from dual' });
    expect(sql).toMatch(/p_plug_source=>'select 1 id/);
  });

  it('analyzePlugin: leitet Source-Type, ConfigJSON-Attribut, AJAX-Bedarf generisch ab', () => {
    const exp = [
      `wwv_flow_api.create_plugin(`,
      ` p_id=>1`,
      `,p_plugin_type=>'REGION TYPE'`,
      `,p_name=>'MY.PLUGIN.1'`,
      `,p_display_name=>'My Plugin'`,
      `,p_api_version=>1`,
      `,p_render_function=>'F_RENDER'`,
      `,p_ajax_function=>'F_AJAX'`,
      `,p_standard_attributes=>'SOURCE_SQL:AJAX_ITEMS_TO_SUBMIT'`,
      `);`,
      `wwv_flow_api.create_plugin_attribute(`,
      ` p_id=>2`,
      `,p_attribute_scope=>'COMPONENT'`,
      `,p_attribute_sequence=>1`,
      `,p_prompt=>'ConfigJSON'`,
      `,p_default_value=>'{"a":1}'`,
      `);`,
    ].join('\n');
    const a = analyzePlugin(exp);
    expect(a.internalName).toBe('MY.PLUGIN.1');
    expect(a.displayName).toBe('My Plugin');
    expect(a.sourceTypePrefix).toBe('PLUGIN_'); // api_version 1
    expect(a.hasSourceSql).toBe(true);
    expect(a.usesAjaxItemsToSubmit).toBe(true);
    expect(a.hasAjaxCallback).toBe(true);
    expect(a.configAttributeKey).toBe('attribute_01');
    expect(a.configDefault).toBe('{"a":1}');
  });

  it('analyzePlugin: extrahiert die SOURCE_SQL-Beispielquery als defaultSourceSql (Fallback-Datenquelle)', () => {
    const exp = [
      `wwv_flow_api.create_plugin(`,
      ` p_name=>'BAR.CHART'`,
      `,p_api_version=>1`,
      `,p_standard_attributes=>'SOURCE_SQL:AJAX_ITEMS_TO_SUBMIT'`,
      `);`,
      `wwv_flow_api.create_plugin_std_attribute(`,
      ` p_name=>'SOURCE_SQL'`,
      `,p_default_value=>wwv_flow_string.join(wwv_flow_t_varchar2(`,
      `'SELECT',`,
      `'    ''A'' AS TITLE,',`,
      `'    42 AS VALUE',`,
      `'FROM DUAL'))`,
      `,p_sql_min_column_count=>1`,
      `);`,
    ].join('\n');
    const a = analyzePlugin(exp);
    expect(a.hasSourceSql).toBe(true);
    expect(a.defaultSourceSql).toMatch(/SELECT/);
    expect(a.defaultSourceSql).toContain("'A' AS TITLE"); // '' → ' korrekt entpackt
    expect(a.defaultSourceSql).toContain('42 AS VALUE');
    expect(a.defaultSourceSql).toContain('FROM DUAL');
  });

  it('buildSetupManifest: „Rezept" mit Region-Typ, Page-Item/AJAX, Quelle, Attributen, File-URLs', () => {
    const exp = [
      `wwv_flow_api.create_plugin(`,
      ` p_name=>'BAR.1'`,
      `,p_display_name=>'Bar Plugin'`,
      `,p_api_version=>1`,
      `,p_standard_attributes=>'SOURCE_SQL:AJAX_ITEMS_TO_SUBMIT'`,
      `);`,
      `wwv_flow_api.create_plugin_attribute(`,
      ` p_attribute_scope=>'COMPONENT'`,
      `,p_attribute_sequence=>1`,
      `,p_prompt=>'ConfigJSON'`,
      `,p_default_value=>'{"a":1}'`,
      `);`,
      `wwv_flow_api.create_plugin_std_attribute(`,
      ` p_name=>'SOURCE_SQL'`,
      `,p_default_value=>'select 1 v from dual'`,
      `);`,
    ].join('\n');
    const man = buildSetupManifest(exp, { pageId: 9999 });
    expect(man.plugin.internalName).toBe('BAR.1');
    expect(man.plugin.regionSourceType).toBe('PLUGIN_BAR.1'); // api_version 1
    expect(man.testPage.pageItem).toMatchObject({ name: 'P9999_AJAX', ajaxItemsToSubmit: true });
    expect(man.testPage.source).toMatchObject({ type: 'SQL Query', sql: 'select 1 v from dual' }); // Fallback = Beispielquery
    expect(man.attributes[0]).toMatchObject({ key: 'attribute_01', prompt: 'ConfigJSON', default: '{"a":1}' });
    expect(Array.isArray(man.fileUrls.js)).toBe(true);
  });

  it('T-149: MEHRERE Page-Items generisch erkennen (Items-to-Submit-Liste + :P<n>_-Binds, interne Binds ignoriert)', () => {
    const exp = [
      `wwv_flow_api.create_plugin(`,
      ` p_name=>'MULTI.1'`,
      `,p_display_name=>'Multi'`,
      `,p_api_version=>1`,
      `,p_standard_attributes=>'SOURCE_SQL:AJAX_ITEMS_TO_SUBMIT'`,
      `);`,
      `wwv_flow_api.create_plugin_attribute(`,
      ` p_attribute_sequence=>1`,
      `,p_prompt=>'Items to Submit'`,
      `,p_default_value=>'P1_A,P1_B:P1_C'`,
      `);`,
      `wwv_flow_api.create_plugin_attribute(`,
      ` p_attribute_sequence=>2`,
      `,p_prompt=>'PLSQL Block'`,
      `,p_default_value=>'v := NVL(:P1_COL_NAME, x); y := :PK; z := :ITEM_ID;'`,
      `);`,
      `wwv_flow_api.create_plugin_std_attribute(`,
      ` p_name=>'SOURCE_SQL'`,
      `,p_default_value=>'select :P1_X from dual'`,
      `);`,
    ].join('\n');
    const man = buildSetupManifest(exp, { pageId: 20000 });
    const names = man.testPage.pageItems.map((i) => i.name).sort();
    // A/B/C aus der Liste, COL_NAME + X aus Binds; alle auf die Testseite gemappt; PK/ITEM_ID NICHT dabei
    expect(names).toEqual(['P20000_A', 'P20000_B', 'P20000_C', 'P20000_COL_NAME', 'P20000_X']);
    expect(man.testPage.itemsToSubmit.sort()).toEqual(['P20000_A', 'P20000_B', 'P20000_C']); // nur die submit-Items
    expect(man.testPage.pageItem.name).toBe(man.testPage.pageItems[0].name); // rückwärtskompatibel = erstes
    expect(man.testPage.pageItems.every((i) => i.type === 'Hidden')).toBe(true);
  });

  it('T-149: detectPageItems direkt — ohne AJAX-Attr & ohne Binds → leer (kein synthetisches Item)', () => {
    expect(detectPageItems({ customAttributes: [], usesAjaxItemsToSubmit: false }, 20000)).toEqual([]);
    // nur AJAX_ITEMS_TO_SUBMIT deklariert, sonst nichts → EIN synthetisches Submit-Item (Rückwärtskompat.)
    const only = detectPageItems({ customAttributes: [], usesAjaxItemsToSubmit: true }, 20000);
    expect(only).toEqual([{ name: 'P20000_AJAX', type: 'Hidden', ajaxItemsToSubmit: true }]);
  });

  it('analyzePlugin: api_version 2 → NATIVE_PLUGIN_; ohne AJAX_ITEMS_TO_SUBMIT → false', () => {
    const a = analyzePlugin(`p_name=>'X.Y'\n,p_api_version=>2\n,p_standard_attributes=>'SOURCE_SQL'`);
    expect(a.sourceTypePrefix).toBe('NATIVE_PLUGIN_');
    expect(a.usesAjaxItemsToSubmit).toBe(false);
  });

  it('buildTestPageSql: needsAjaxItem → Page-Item + p_ajax_items_to_submit', () => {
    const sql = buildTestPageSql({ appId: 1, pageId: 500, pluginInternalName: 'X', sourceTypePrefix: 'PLUGIN_', needsAjaxItem: true });
    expect(sql).toContain(`p_plug_source_type=>'PLUGIN_X'`);
    expect(sql).toMatch(/p_ajax_items_to_submit=>'P500_AJAX'/);
    expect(sql).toMatch(/create_page_item\(/);
  });

  it('apex-ui.js: wiederverwendbare UI-Automation ist importierbar (für Plugin Maintenance)', () => {
    for (const fn of ['loadChromium', 'uiLogin', 'uiImportFile', 'uiSetPluginFileUrls', 'smokeCheckPage']) {
      expect(typeof apexUi[fn]).toBe('function');
    }
  });

  it('uiLogin: unvollständige Config → klarer Fehler (ohne Browser)', async () => {
    expect((await apexUi.uiLogin(null, { baseUrl: '' })).error).toMatch(/baseUrl/);
    expect((await apexUi.uiLogin(null, { baseUrl: 'x', workspace: 'w' })).error).toMatch(/user|pass/i);
  });

  it('ohne pluginInternalName/appId → klarer Fehler', () => {
    expect(() => buildTestPageSql({ appId: 1 })).toThrow(/pluginInternalName/);
    expect(() => buildTestPageSql({ pluginInternalName: 'X' })).toThrow(/appId/);
  });
});

describe('F-31 T-128 apex-deploy: MCP-Handshake (stdio, dependency-frei)', () => {
  it('initialize + tools/list liefern die vier Tools', async () => {
    const server = path.join(process.cwd(), 'mcp-apex-deploy', 'server.js');
    const child = spawn(process.execPath, [server], { windowsHide: true });
    const lines = [];
    let resolveDone; const done = new Promise((r) => { resolveDone = r; });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (l) lines.push(JSON.parse(l)); if (lines.length >= 2) resolveDone(); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    child.kill();
    const init = lines.find((m) => m.id === 1);
    expect(init.result.serverInfo.name).toBe('apex-deploy');
    const list = lines.find((m) => m.id === 2);
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['apex_install', 'apex_create_test_page', 'apex_test_page', 'apex_info']));
  });
});

describe('T-150 Page-Items: reine Normalisierungs-/Submit-Logik', () => {
  it('normalizePageItems vereinheitlicht Strings und Manifest-Objekte zu {name,type,submit}', () => {
    const out = apexUi.normalizePageItems([
      'P1_X',
      { name: 'P1_Y', type: 'Hidden', ajaxItemsToSubmit: true },
      { name: 'P1_Z', submit: false },
      null, { foo: 'bar' },
    ]);
    expect(out).toEqual([
      { name: 'P1_X', type: 'Hidden', submit: false },
      { name: 'P1_Y', type: 'Hidden', submit: true },
      { name: 'P1_Z', type: 'Hidden', submit: false },
    ]);
  });

  it('itemsToSubmitNames liefert nur die als submit markierten Namen', () => {
    const items = [
      { name: 'P1_A', ajaxItemsToSubmit: true },
      { name: 'P1_B', ajaxItemsToSubmit: false },
      { name: 'P1_C', ajaxItemsToSubmit: true },
    ];
    expect(apexUi.itemsToSubmitNames(items)).toEqual(['P1_A', 'P1_C']);
  });
});
