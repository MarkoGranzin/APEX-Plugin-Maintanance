import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { repoCheckoutDir, addRepoToWorkspace, repoComponent, syncRepo } from '../src/service/workspace.js';
import { createComponentStore } from '../src/gui/store.js';
import { createSettings, setWorkDir } from '../src/config/settings.js';
import { metaApiHandler } from '../src/gui/api.js';

let tmp, sourceDir, workDir, cpSource;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-ws-'));
  sourceDir = path.join(tmp, 'source');
  workDir = path.join(tmp, 'work');
  fs.mkdirSync(sourceDir, { recursive: true });

  const g = simpleGit({ baseDir: sourceDir });
  await g.init();
  await g.addConfig('user.email', 't@e.x');
  await g.addConfig('user.name', 'T');
  const w = (rel, c) => { const pth = path.join(sourceDir, rel); fs.mkdirSync(path.dirname(pth), { recursive: true }); fs.writeFileSync(pth, c); };
  w('colorpicker/colorpicker.sql', `begin wwv_flow_api.create_plugin(p_id=>1,p_name=>'CP'); end;`);
  w('slider/slider.js', `(function(){ function init(){} window.s=init; })();`);
  w('slider/slider.css', `.s{}`);
  await g.add('.');
  await g.commit('init');

  // Ein-Plugin-Repo (Modell „repo je plugin")
  cpSource = path.join(tmp, 'cpSource');
  fs.mkdirSync(cpSource, { recursive: true });
  const g2 = simpleGit({ baseDir: cpSource });
  await g2.init();
  await g2.addConfig('user.email', 't@e.x');
  await g2.addConfig('user.name', 'T');
  fs.writeFileSync(path.join(cpSource, 'colorpicker.sql'), `begin wwv_flow_api.create_plugin(p_id=>1,p_name=>'CP'); end;`);
  await g2.add('.');
  await g2.commit('init');
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('T-35 Arbeitsverzeichnis & Checkout', () => {
  it('Arbeitsverzeichnis konfigurierbar', () => {
    const s = createSettings();
    setWorkDir(s, 'D:/arbeit');
    expect(s.workDir).toBe('D:/arbeit');
    expect(() => setWorkDir(s, '')).toThrow();
  });

  it('klont in workDir/<name>, dann fetch', async () => {
    const first = await addRepoToWorkspace({ name: 'myrepo', source: sourceDir }, { workDir });
    expect(first.action).toBe('clone');
    expect(fs.existsSync(repoCheckoutDir(workDir, 'myrepo'))).toBe(true);
    const second = await addRepoToWorkspace({ name: 'myrepo', source: sourceDir }, { workDir });
    expect(second.action).toBe('fetch');
  });
});

describe('T-36 Ein Repo = eine Komponente', () => {
  it('Repo wird als EINE Komponente erkannt (Typ/Format aus Inhalt, Pfad = Repo-Wurzel)', async () => {
    const store = createComponentStore();
    const res = await syncRepo({ name: 'apex-colorpicker', source: cpSource }, { workDir: path.join(tmp, 'w1'), store });
    expect(res.added).toBe(1);
    expect(store.list()).toHaveLength(1);
    const c = store.list()[0];
    expect(c.name).toBe('apex-colorpicker');
    expect(c.repo).toBe('apex-colorpicker');
    expect(c.type).toBe('plugin');
    expect(c.format).toBe('export');
    expect(c.path).toBe(repoCheckoutDir(path.join(tmp, 'w1'), 'apex-colorpicker'));
  });

  it('mehrere Artefakte im Repo → Format des echten Plugin-Artefakts (Export), genau EINE Komponente', () => {
    const comp = repoComponent(sourceDir, 'multi');
    // colorpicker.sql ist ein APEX-Export → das eigentliche Plugin bestimmt das Format (nicht „mixed/unklar")
    expect(comp.format).toBe('export');
    expect(comp.type).toBe('plugin');
    expect(comp.artifactCount).toBeGreaterThanOrEqual(2);
  });

  it('Re-Scan erzeugt kein Duplikat, aktualisiert die Komponente', async () => {
    const store = createComponentStore();
    const w = path.join(tmp, 'w2');
    await syncRepo({ name: 'r2', source: cpSource }, { workDir: w, store });
    const res2 = await syncRepo({ name: 'r2', source: cpSource }, { workDir: w, store });
    expect(store.list()).toHaveLength(1);
    expect(res2.added).toBe(0);
    expect(res2.updated).toBe(1);
  });
});

describe('T-37 Settings/Repos-API', () => {
  it('Arbeitsverzeichnis über die API setzen/lesen', async () => {
    const ctx = { settings: createSettings(), syncRepo: async () => ({ added: 0, updated: 0 }) };
    await metaApiHandler('PUT', '/api/settings', { workDir: 'C:/ws' }, ctx);
    const get = await metaApiHandler('GET', '/api/settings', null, ctx);
    expect(get.body.workDir).toBe('C:/ws');
  });

  it('POST /api/repos bindet an und meldet added/updated', async () => {
    const calls = [];
    const ctx = { settings: createSettings(), syncRepo: async (cfg) => { calls.push(cfg); return { added: 3, updated: 0 }; } };
    const res = await metaApiHandler('POST', '/api/repos', { name: 'r', source: '/src' }, ctx);
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(3);
    expect(ctx.settings.repos).toHaveLength(1); // Repo gemerkt
  });

  it('POST /api/repos/rescan nutzt gemerkte Repos', async () => {
    let n = 0;
    const ctx = { settings: createSettings({ repos: [{ name: 'r', source: '/src' }] }), syncRepo: async () => { n++; return { added: 0, updated: 2 }; } };
    const res = await metaApiHandler('POST', '/api/repos/rescan', {}, ctx);
    expect(n).toBe(1);
    expect(res.body[0].updated).toBe(2);
  });

  it('unbekannte Meta-Route → 404', async () => {
    const res = await metaApiHandler('GET', '/api/unbekannt', null, { settings: createSettings() });
    expect(res.status).toBe(404);
  });
});
