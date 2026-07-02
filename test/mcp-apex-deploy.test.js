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

describe('F-31 T-129 apex-deploy: generische Testseite (APEX 24.x-Format)', () => {
  const CFG = '{"refresh":0,"style":[{"name":"default"}]}';

  it('vollständige, importierbare Seite: Header + create_page + Plugin-Region + Footer', () => {
    const sql = buildTestPageSql({ appId: 200000, pageId: 9999, pluginInternalName: 'APEX.FLOW.CHART.1', workspaceId: '123', owner: 'WKSP_MEETUP' });
    expect(sql).toMatch(/wwv_flow_imp\.import_begin/);
    expect(sql).toContain('p_default_application_id=>200000');
    expect(sql).toContain('p_default_workspace_id=>123');
    expect(sql).toContain(`p_default_owner=>'WKSP_MEETUP'`);
    expect(sql).toMatch(/wwv_flow_imp_page\.create_page\(/);
    expect(sql).toMatch(/wwv_flow_imp_page\.create_page_plug\(/);
    expect(sql).toContain(`p_plug_source_type=>'NATIVE_PLUGIN_APEX.FLOW.CHART.1'`);
    expect(sql).toContain('p_id=>9999');
    expect(sql).toMatch(/wwv_flow_imp\.import_end/);
  });

  it('ohne Attribute → keine p_attributes (Region nutzt Plugin-Defaults)', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X' });
    expect(sql).not.toContain('p_attributes=>');
  });

  it('mit Attributen → 24.x wwv_flow_t_plugin_attributes-Clob (benannt)', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', attributes: { '1': CFG } });
    expect(sql).toMatch(/p_attributes=>wwv_flow_t_plugin_attributes\(wwv_flow_t_varchar2\(/);
    expect(sql).toContain("'1'");
    expect(sql).toContain('refresh');
  });

  it('langer Attributwert (>800) → wwv_flow_string.join', () => {
    const big = '{"a":"' + 'x'.repeat(1200) + '"}';
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', attributes: { '1': big } });
    expect(sql).toMatch(/wwv_flow_string\.join\(wwv_flow_t_varchar2\(/);
  });

  it('sourceSql wird als Region-Quelle gesetzt', () => {
    const sql = buildTestPageSql({ appId: 1, pluginInternalName: 'X', sourceSql: 'select 1 id, 0 pid from dual' });
    expect(sql).toMatch(/p_plug_source=>'select 1 id/);
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
