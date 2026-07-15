import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { assignRepoToComponent } from '../src/service/assign-repo.js';
import { createComponentStore } from '../src/gui/store.js';
import { SecretStore } from '../src/config/secrets.js';

let tmp, cpSource, sliderSource, workDir;

async function mkRepo(dir, write) {
  fs.mkdirSync(dir, { recursive: true });
  const g = simpleGit({ baseDir: dir });
  await g.init();
  await g.addConfig('user.email', 't@e.x');
  await g.addConfig('user.name', 'T');
  write(dir);
  await g.add('.');
  await g.commit('init');
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-assign-'));
  cpSource = path.join(tmp, 'cpSrc');
  sliderSource = path.join(tmp, 'sliderSrc');
  workDir = path.join(tmp, 'work');
  await mkRepo(cpSource, (d) => fs.writeFileSync(path.join(d, 'colorpicker.sql'), `begin wwv_flow_api.create_plugin(p_id=>1,p_name=>'CP'); end;`));
  await mkRepo(sliderSource, (d) => { fs.writeFileSync(path.join(d, 'slider.js'), 'var s=1;'); });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('T-42 assignRepoToComponent', () => {
  it('ordnet Repo zu: klont in eigenes Verzeichnis, erkennt Format, aktualisiert Komponente', async () => {
    const store = createComponentStore();
    const id = store.add({ name: 'apex-colorpicker' }).id;
    const res = await assignRepoToComponent(store, id, { source: cpSource, visibility: 'öffentlich' }, { workDir });
    expect(res.source).toBe(cpSource);
    expect(res.format).toBe('export');
    expect(res.path).toBe(path.join(workDir, 'apex-colorpicker'));
    expect(fs.existsSync(path.join(workDir, 'apex-colorpicker', 'colorpicker.sql'))).toBe(true);
  });

  it('internes Repo: Token verschlüsselt im SecretStore, Komponente hält nur secretRef', async () => {
    const store = createComponentStore();
    const secretStore = new SecretStore('master');
    const id = store.add({ name: 'intern-plugin' }).id;
    const res = await assignRepoToComponent(store, id, { source: cpSource, visibility: 'intern', token: 'ghp_GEHEIM123456' }, { workDir, secretStore });
    expect(res.secretRef).toBe(`repo:${id}`);
    expect(JSON.stringify(res)).not.toContain('ghp_GEHEIM123456'); // kein Klartext an der Komponente
    expect(secretStore.get(`repo:${id}`)).toContain('ghp_GEHEIM123456'); // aber verschlüsselt abrufbar
    expect(JSON.stringify(secretStore)).not.toContain('ghp_GEHEIM123456'); // Persistenz nur Chiffrat
  });

  it('jedes Plugin erhält ein eigenes Verzeichnis', async () => {
    const store = createComponentStore();
    const a = store.add({ name: 'plugin-a' }).id;
    const b = store.add({ name: 'plugin-b' }).id;
    await assignRepoToComponent(store, a, { source: cpSource }, { workDir });
    await assignRepoToComponent(store, b, { source: sliderSource }, { workDir });
    expect(store.get(a).path).toBe(path.join(workDir, 'plugin-a'));
    expect(store.get(b).path).toBe(path.join(workDir, 'plugin-b'));
    expect(store.get(a).path).not.toBe(store.get(b).path);
  });

  it('fehlende Quelle → Fehler', async () => {
    const store = createComponentStore();
    const id = store.add({ name: 'x' }).id;
    expect((await assignRepoToComponent(store, id, {}, { workDir })).error).toMatch(/source/i);
  });
});
