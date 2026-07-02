import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildInstallScript, buildTestPageSql, parsePluginName, maskConn } from '../mcp-apex-deploy/lib/apex.js';

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

  it('parsePluginName liest p_name aus dem Export', () => {
    const sql = `wwv_flow_api.create_plugin(\n p_id=>wwv_flow_api.id(123)\n,p_plugin_type=>'REGION TYPE'\n,p_name=>'DE.AISS.APEXFLOWCHART'\n,p_display_name=>'ApexFlowChart'\n);`;
    expect(parsePluginName(sql)).toBe('DE.AISS.APEXFLOWCHART');
  });

  it('maskConn maskiert das Passwort — Secrets nie in Ausgaben', () => {
    expect(maskConn('scott/tiger@db:1521/xe')).toBe('scott/***@db:1521/xe');
    expect(maskConn('scott/"t@ig"er"@db')).not.toContain('tiger');
    expect(maskConn('')).toBe('(not set)');
  });
});

describe('F-31 T-129 apex-deploy: generische Testseite', () => {
  const CFG = '{"refresh":0,"style":[{"name":"default"}]}';

  it('Gerüst-Modus: Region vom Plugin-Typ + Attribute aus der Schnittstelle', () => {
    const sql = buildTestPageSql({ appId: 100, pageId: 9999, pluginName: 'DE.AISS.APEXFLOWCHART', attributes: [CFG] });
    expect(sql).toMatch(/create_page\(/);
    expect(sql).toMatch(/create_page_plug\(/);
    expect(sql).toContain(`p_plug_source_type=>'PLUGIN_DE.AISS.APEXFLOWCHART'`);
    expect(sql).toContain(`p_plugin_name=>'DE.AISS.APEXFLOWCHART'`);
    expect(sql).toContain('p_attribute_01=>');
    expect(sql).toContain('refresh');
  });

  it('API-Package parametrisierbar (Default wwv_flow_imp_page, alternativ wwv_flow_api)', () => {
    expect(buildTestPageSql({ appId: 1, pluginName: 'X' })).toMatch(/wwv_flow_imp_page\.create_page\(/);
    expect(buildTestPageSql({ appId: 1, pluginName: 'X', apiPackage: 'wwv_flow_api' })).toMatch(/wwv_flow_api\.create_page\(/);
  });

  it('lange Attribute (JSON > 800 Zeichen) werden als wwv_flow_string.join geschrieben', () => {
    const big = '{"a":"' + 'x'.repeat(1200) + '"}';
    const sql = buildTestPageSql({ appId: 1, pluginName: 'X', attributes: [big] });
    expect(sql).toMatch(/wwv_flow_string\.join\(wwv_flow_t_varchar2\(/);
  });

  it('Vorlagen-Modus: Seiten-ID, Plugin-Typ und Attribute werden im echten Export ersetzt', () => {
    const template = [
      'begin',
      'wwv_flow_imp_page.create_page(',
      ' p_id=>wwv_flow_imp.id(12)',
      ",p_name=>'Alte Seite'",
      ');',
      'wwv_flow_imp_page.create_page_plug(',
      ' p_id=>wwv_flow_imp.id(345)',
      ",p_plug_name=>'Alt'",
      ",p_plug_source_type=>'PLUGIN_ALT.PLUGIN'",
      ",p_plugin_name=>'ALT.PLUGIN'",
      ",p_attribute_01=>'altwert'",
      ');',
      'end;',
    ].join('\n');
    const sql = buildTestPageSql({ appId: 100, pageId: 777, pluginName: 'NEU.PLUGIN', attributes: ['neuwert'], template });
    expect(sql).toContain('wwv_flow_imp.id(777)');
    expect(sql).toContain(`p_plugin_name=>'NEU.PLUGIN'`);
    expect(sql).toContain(`p_plug_source_type=>'PLUGIN_NEU.PLUGIN'`);
    expect(sql).toContain(`p_attribute_01=>'neuwert'`);
    expect(sql).not.toContain('altwert');
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
