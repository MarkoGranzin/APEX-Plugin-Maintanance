import { describe, it, expect } from 'vitest';
import { setupFromManifest } from '../mcp-apex-deploy/lib/setup.js';
import { buildSetupManifest, stripAsyncBlocks } from '../mcp-apex-deploy/lib/apex.js';

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

  it('Dynamic-Action-Plugin (kind=dynamic-action) → baut DA-Testseite via uiCreateDynamicActionTestPage', async () => {
    const daManifest = {
      manifestVersion: 1,
      plugin: { internalName: 'RW.VANTA', displayName: 'APEX Vanta.js Plug-in', apiVersion: 1, kind: 'dynamic-action', pluginType: 'DYNAMIC ACTION' },
      standardAttributes: [],
      testPage: { id: 20052, name: 'Live-Test: RW.VANTA', setupKind: 'dynamic-action', dynamicAction: { event: 'Page Load', action: 'APEX Vanta.js Plug-in', selectionType: 'jQuery Selector', selector: 'body' } },
      attributes: [{ key: 'attribute_01', prompt: 'Animation Type', default: 'WAVES' }],
      fileUrls: { js: ['#PLUGIN_FILES#vanta.js'], css: [] },
    };
    let daArg, itemCalled = false, regionCalled = false;
    const deps = fakeDeps({
      uiCreateDynamicActionTestPage: async (_p, a) => { daArg = a; return { ok: true, mode: 'create', action: 'ok' }; },
      uiCreateItemTestPage: async () => { itemCalled = true; return { ok: true }; },
      uiCreateTestPage: async () => { regionCalled = true; return { ok: true }; },
    });
    const r = await setupFromManifest(daManifest, connection, {}, deps);
    expect(r.ok).toBe(true);
    expect(itemCalled).toBe(false);
    expect(regionCalled).toBe(false);
    expect(daArg.event).toBe('Page Load');
    expect(daArg.selectionType).toBe('jQuery Selector');
    expect(daArg.selector).toBe('body');
    expect(daArg.pluginDisplayName).toBe('APEX Vanta.js Plug-in');
    expect(daArg.attributes[0]).toMatchObject({ prompt: 'Animation Type', value: 'WAVES' });
  });

  it('Template-Component-Plugin (kind=template-component) → baut TC-Testseite via uiCreateTemplateComponentTestPage', async () => {
    const tcManifest = {
      manifestVersion: 1,
      plugin: { internalName: 'UC.FLIP', displayName: 'Flip Card', apiVersion: 1, kind: 'template-component', pluginType: 'TEMPLATE COMPONENT' },
      standardAttributes: ['REGION_TEMPLATE'],
      testPage: { id: 20053, name: 'Live-Test: UC.FLIP', setupKind: 'template-component', templateComponent: { region: { name: 'Test: UC.FLIP', plugin: 'Flip Card' }, source: { type: 'SQL Query', sql: 'select 1 id, 2 title from dual' }, columnMap: { Title: '&TITLE.' } } },
      attributes: [{ key: 'attribute_01', prompt: 'Layout', default: 'a-CardView--grid' }],
      fileUrls: { js: [], css: ['#PLUGIN_FILES#flip.css'] },
    };
    let tcArg;
    const deps = fakeDeps({ uiCreateTemplateComponentTestPage: async (_p, a) => { tcArg = a; return { ok: true, mode: 'create', sourceType: 'ok' }; } });
    const r = await setupFromManifest(tcManifest, connection, {}, deps);
    expect(r.ok).toBe(true);
    expect(tcArg.regionName).toBe('Test: UC.FLIP');
    expect(tcArg.sourceSql).toBe('select 1 id, 2 title from dual');
    expect(tcArg.columnMap).toMatchObject({ Title: '&TITLE.' });
    expect(tcArg.attributes[0]).toMatchObject({ prompt: 'Layout', value: 'a-CardView--grid' });
  });

  it('unbekannter Typ (kind=process) → ehrliche „nicht automatisiert"-Meldung, kein False-Green', async () => {
    const procManifest = {
      manifestVersion: 1,
      plugin: { internalName: 'X.PROC', displayName: 'Proc', apiVersion: 1, kind: 'process', pluginType: 'PROCESS TYPE' },
      standardAttributes: [], testPage: { id: 20099, setupKind: 'process' }, attributes: [], fileUrls: { js: [], css: [] },
    };
    const r = await setupFromManifest(procManifest, connection, {}, fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.testPage.error).toMatch(/nicht automatisiert/i);
    expect(r.render.rendered).toBe(false);
  });

  it('B-38: selbst-ladendes Plugin (ADD_LIBRARY) -> keine File-URLs, Altbestand wird geleert', async () => {
    const exp = `wwv_flow_api.create_plugin(
 p_name=>'SL.1'
,p_plugin_type=>'REGION TYPE'
,p_api_version=>1
,p_render_function=>'render'
);
-- render: APEX_JAVASCRIPT.ADD_LIBRARY(p_name=>'bida.pkgd.min');
APEX_JAVASCRIPT.ADD_LIBRARY
wwv_flow_api.create_plugin_file(
 p_file_name=>'bida.pkgd.min.js'
);`;
    const man = buildSetupManifest(exp, { pageId: 20000 });
    expect(man.plugin.selfLoadsFiles).toBe(true);
    expect(man.fileUrls.js).toEqual([]); // KEINE URLs -> keine Doppel-Ladung
    let cleared = null;
    const deps = fakeDeps({ uiSetPluginFileUrls: async (_p, a) => { cleared = a; return { ok: true, js: { cleared: true } }; } });
    await setupFromManifest({ ...man, plugin: { ...man.plugin, kind: 'region' }, testPage: { ...man.testPage, source: { sql: 'select 1 from dual' } } }, connection, {}, deps);
    expect(cleared.clear).toBe(true); // faelschlich gesetzte URLs werden entfernt
  });

  it('stripAsyncBlocks: ASYNC-markierte UNION-Bloecke fliegen aus der Testseiten-SQL', () => {
    const sql = ['SELECT 1 itemType FROM dual', 'UNION ALL', ' /*item is loaded ASYNC*/ SELECT 2 FROM dual', 'UNION ALL', 'SELECT 3 itemType FROM dual'].join('\n');
    const out = stripAsyncBlocks(sql);
    expect(out).not.toMatch(/ASYNC/i);
    expect(out.split(/union all/i)).toHaveLength(2); // 2 von 3 Bloecken bleiben
    expect(stripAsyncBlocks('SELECT 1 FROM dual')).toBe('SELECT 1 FROM dual'); // ohne UNION unveraendert
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
