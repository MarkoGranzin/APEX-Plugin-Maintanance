import { describe, it, expect } from 'vitest';
import { setupFromManifest } from '../mcp-apex-deploy/lib/setup.js';
import { buildSetupManifest } from '../mcp-apex-deploy/lib/apex.js';

const connection = { baseUrl: 'https://host/ords', workspace: 'WS', user: 'u', pass: 'p', appId: 100, alias: 'test' };

function fakeDeps(over = {}) {
  const fakePage = { on() {}, async goto() {}, async close() {} };
  return {
    loadChromium: async () => ({ launch: async () => ({ async newPage() { return fakePage; }, async close() {} }) }),
    uiLogin: async () => ({ ok: true }),
    uiImportFile: async (_p, file, o) => ({ ok: true, _file: file, _o: o }),
    uiSetPluginFileUrls: async () => ({ ok: true, js: { set: true, count: 1 } }),
    uiCreateTestPage: async (_p, arg) => ({ ok: true, mode: 'create', _arg: arg }),
    smokeCheckPage: async () => ({ ok: true, rendered: true, graphics: 2, jsErrors: [] }),
    ...over,
  };
}

describe('T-138 setupFromManifest: JSON → APEX (standalone/wiederverwendbar)', () => {
  const manifest = {
    manifestVersion: 1,
    plugin: { internalName: 'BAR.1', displayName: 'Bar Plugin', apiVersion: 1, kind: 'region', pluginType: 'REGION TYPE', regionSourceType: 'PLUGIN_BAR.1' },
    standardAttributes: ['SOURCE_SQL', 'AJAX_ITEMS_TO_SUBMIT'],
    testPage: { id: 20000, name: 'Live-Test: BAR.1', region: { name: 'Test: BAR.1', plugin: 'Bar Plugin' }, source: { type: 'SQL Query', sql: 'select 1 v from dual' } },
    attributes: [{ key: 'attribute_01', prompt: 'ConfigJSON', default: '{"a":1}' }],
    fileUrls: { js: ['#PLUGIN_FILES#bar.js'], css: [] },
  };

  it('richtet ALLES aus dem Manifest ein → uiCreateTestPage-Args stammen aus dem JSON', async () => {
    let pageArg, fileArg;
    const deps = fakeDeps({
      uiCreateTestPage: async (_p, a) => { pageArg = a; return { ok: true, mode: 'create' }; },
      uiSetPluginFileUrls: async (_p, a) => { fileArg = a; return { ok: true, js: { set: true, count: 1 } }; },
    });
    const r = await setupFromManifest(manifest, connection, {}, deps);
    expect(r.ok).toBe(true);
    expect(pageArg.pageId).toBe(20000);
    expect(pageArg.regionName).toBe('Test: BAR.1');
    expect(pageArg.pluginDisplayName).toBe('Bar Plugin');
    expect(pageArg.sourceSql).toBe('select 1 v from dual');
    expect(pageArg.attributes[0]).toMatchObject({ prompt: 'ConfigJSON', value: '{"a":1}' });
    expect(fileArg.jsUrls).toEqual(['#PLUGIN_FILES#bar.js']); // File-URLs aus dem Manifest
  });

  it('install-Option → Plugin wird zuerst installiert (viaPlugins)', async () => {
    let imp;
    const deps = fakeDeps({ uiImportFile: async (_p, file, o) => { imp = { file, o }; return { ok: true }; } });
    const r = await setupFromManifest(manifest, connection, { install: '/repo/plugin.sql' }, deps);
    expect(r.ok).toBe(true);
    expect(imp.file).toBe('/repo/plugin.sql');
    expect(imp.o.viaPlugins).toBe(true);
  });

  it('unvollständige Verbindung → klarer Fehler, kein Browser', async () => {
    const r = await setupFromManifest(manifest, { baseUrl: 'x', workspace: 'w' }, {}, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Verbindung|Passwort/i);
  });

  it('pageId-Override sticht manifest.testPage.id', async () => {
    let pageArg;
    const deps = fakeDeps({ uiCreateTestPage: async (_p, a) => { pageArg = a; return { ok: true }; } });
    await setupFromManifest(manifest, connection, { pageId: 20005 }, deps);
    expect(pageArg.pageId).toBe(20005);
  });

  it('Item-Plugin (kind=item) → baut Testseite via uiCreateItemTestPage aus dem Manifest', async () => {
    const itemManifest = {
      manifestVersion: 1,
      plugin: { internalName: 'APEX_COLOR_PALETTE', displayName: 'APEX Color Palette', apiVersion: 2, kind: 'item', pluginType: 'ITEM TYPE' },
      standardAttributes: [],
      testPage: { id: 20040, name: 'Live-Test: APEX_COLOR_PALETTE', setupKind: 'item', item: { name: 'P20040_ITEM', plugin: 'APEX Color Palette', hostRegion: 'Host' } },
      attributes: [{ key: 'attribute_04', prompt: 'Color Json', default: '{"c":"#fff"}' }],
      fileUrls: { js: ['#PLUGIN_FILES#cp.js'], css: [] },
    };
    let itemArg, regionCalled = false;
    const deps = fakeDeps({
      uiCreateItemTestPage: async (_p, a) => { itemArg = a; return { ok: true, mode: 'create', item: { name: 'ok' } }; },
      uiCreateTestPage: async () => { regionCalled = true; return { ok: true }; },
    });
    const r = await setupFromManifest(itemManifest, connection, {}, deps);
    expect(r.ok).toBe(true);
    expect(regionCalled).toBe(false); // Item-Plugin → NICHT der Region-Pfad
    expect(itemArg.pageId).toBe(20040);
    expect(itemArg.itemName).toBe('P20040_ITEM');
    expect(itemArg.hostRegionName).toBe('Host');
    expect(itemArg.pluginDisplayName).toBe('APEX Color Palette');
    expect(itemArg.attributes[0]).toMatchObject({ prompt: 'Color Json', value: '{"c":"#fff"}' });
  });

  it('buildSetupManifest + setupFromManifest zusammen (rundlauf ohne Browser)', async () => {
    const exp = `wwv_flow_api.create_plugin(\n p_name=>'X.Y'\n,p_plugin_type=>'REGION TYPE'\n,p_display_name=>'XY'\n,p_api_version=>1\n,p_standard_attributes=>'SOURCE_SQL'\n);\nwwv_flow_api.create_plugin_std_attribute(\n p_name=>'SOURCE_SQL'\n,p_default_value=>'select 9 v from dual'\n);`;
    const man = buildSetupManifest(exp, { pageId: 20000 });
    let pageArg;
    const r = await setupFromManifest(man, connection, {}, fakeDeps({ uiCreateTestPage: async (_p, a) => { pageArg = a; return { ok: true }; } }));
    expect(r.ok).toBe(true);
    expect(pageArg.sourceSql).toBe('select 9 v from dual');
    expect(pageArg.regionName).toBe('Test: X.Y');
  });
});
