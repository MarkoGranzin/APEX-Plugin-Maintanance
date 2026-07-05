import { describe, it, expect } from 'vitest';
import { deployAndTest, findPluginExport } from '../src/service/apex-live.js';

const target = { baseUrl: 'https://host/ords', workspace: 'WS', user: 'u', pass: 'p', appId: 100, alias: 'test', workspaceId: '1', owner: 'WKSP_WS' };

// Fakes für alle injizierbaren Bausteine — kein echter Browser/keine echte Instanz.
function fakeDeps(over = {}) {
  const fakePage = { on() {}, async goto() {} };
  return {
    exists: () => true,
    readFile: () => `wwv_flow_api.create_plugin(\n p_name=>'MY.PLUGIN.1'\n,p_display_name=>'My Plugin'\n,p_api_version=>1\n,p_ajax_function=>'F_AJAX'\n,p_standard_attributes=>'SOURCE_SQL:AJAX_ITEMS_TO_SUBMIT'\n);\ncreate_plugin_attribute(\n p_attribute_sequence=>1\n,p_prompt=>'ConfigJSON'\n,p_default_value=>'{"a":1}'\n);`,
    writeTmp: (name, content) => `/tmp/${name}`,
    now: () => 't0',
    loadChromium: async () => ({ launch: async () => ({ async newPage() { return fakePage; }, async close() {} }) }),
    uiLogin: async () => ({ ok: true, url: 'app-builder/apps' }),
    uiImportFile: async (_p, file) => ({ ok: true, steps: ['Next', 'Install'], oraError: null, _file: file }),
    uiSetPluginFileUrls: async () => ({ ok: true, js: { set: true, count: 2 }, css: { skipped: 'keine Dateien' }, applied: true }),
    smokeCheckPage: async () => ({ ok: true, rendered: true, graphics: 3, apexError: null, jsErrors: [] }),
    ...over,
  };
}

describe('T-135 apex-live: Einspielen + Testseite + Render-Verify (orchestriert)', () => {
  it('voller Ablauf grün → install + fileUrls + testPage + render, ok=true', async () => {
    const captured = [];
    const deps = fakeDeps({ uiImportFile: async (_p, file, o) => { captured.push({ file, o }); return { ok: true, oraError: null }; } });
    const r = await deployAndTest({ exportFile: 'plugin.sql', target, sourceSql: 'select 1 from dual' }, deps);
    expect(r.ok).toBe(true);
    expect(r.plugin).toBe('MY.PLUGIN.1');
    expect(r.analysis.sourceTypePrefix).toBe('PLUGIN_'); // api_version 1
    expect(r.analysis.usesAjaxItemsToSubmit).toBe(true);
    expect(r.install.ok).toBe(true);
    expect(r.fileUrls.js.set).toBe(true);
    expect(r.render.rendered).toBe(true);
    // Plugin-Import via Plug-ins, Seiten-Import ohne viaPlugins
    expect(captured[0].o.viaPlugins).toBe(true);
    expect(captured[1].o.viaPlugins).toBeFalsy();
  });

  it('Render schlägt fehl (APEX-Fehlerseite) → ok=false, ehrlich gemeldet', async () => {
    const deps = fakeDeps({ smokeCheckPage: async () => ({ ok: false, rendered: false, apexError: 'ORA-01403: no data found', jsErrors: [] }) });
    const r = await deployAndTest({ exportFile: 'plugin.sql', target }, deps);
    expect(r.ok).toBe(false);
    expect(r.render.apexError).toMatch(/ORA-01403/);
  });

  it('unvollständige Verbindung → klarer Fehler, kein Browser', async () => {
    const r = await deployAndTest({ exportFile: 'plugin.sql', target: { baseUrl: 'x', workspace: 'w', appId: 1 } }, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Verbindung|Passwort|pass/i);
  });

  it('Login scheitert → Abbruch mit Login-Fehler', async () => {
    const deps = fakeDeps({ uiLogin: async () => ({ ok: false, error: 'Login nicht erfolgreich' }) });
    const r = await deployAndTest({ exportFile: 'plugin.sql', target }, deps);
    expect(r.ok).toBe(false);
    expect(r.login.ok).toBe(false);
  });

  it('findPluginExport: bevorzugt region_type_plugin, meidet APEX_5.1', () => {
    const f = findPluginExport('/repo', { listFiles: () => ['readme.md', 'region_type_plugin_x_APEX_5.1.sql', 'region_type_plugin_x.sql'] });
    expect(f).toMatch(/region_type_plugin_x\.sql$/);
    expect(f).not.toMatch(/5\.1/);
  });
});
