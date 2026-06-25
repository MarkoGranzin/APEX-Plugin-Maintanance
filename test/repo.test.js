import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  addRepo,
  detectRepoKind,
  cloneOrFetch,
  testConnection,
  Repo,
} from '../src/repo/repository.js';

let tmp;
let remoteDir; // dient als "entferntes" Repo (lokaler Pfad)

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-repo-'));
  remoteDir = path.join(tmp, 'remote');
  fs.mkdirSync(remoteDir, { recursive: true });
  const g = simpleGit({ baseDir: remoteDir });
  await g.init();
  await g.addConfig('user.email', 'test@example.com');
  await g.addConfig('user.name', 'Test');
  fs.writeFileSync(path.join(remoteDir, 'plugin.js'), 'console.log("hi");');
  await g.add('.');
  await g.commit('init');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('T-1 Repo-Art-Erkennung', () => {
  it('erkennt https / ssh / lokal', () => {
    expect(detectRepoKind('https://github.com/x/y.git')).toBe('https');
    expect(detectRepoKind('git@github.com:x/y.git')).toBe('ssh');
    expect(detectRepoKind('D:/repos/x')).toBe('local');
  });
});

describe('T-1 Auth-Daten werden nicht persistiert', () => {
  it('toJSON enthält weder Token noch SSH-Key', () => {
    const repo = addRepo({
      name: 'geheim',
      source: 'https://github.com/x/y.git',
      auth: { token: 'ghp_SUPERSECRET' },
      secretRef: 'gh-token',
    });
    const json = JSON.stringify(repo);
    expect(json).not.toContain('ghp_SUPERSECRET');
    expect(repo.toJSON().secretRef).toBe('gh-token');
  });

  it('baut authentifizierte URL transient, ohne Token zu loggen/serialisieren', () => {
    const repo = addRepo({
      name: 'auth',
      source: 'https://github.com/x/y.git',
      auth: { token: 'ghp_ABC' },
    });
    expect(repo.authenticatedSource()).toContain('ghp_ABC');
    expect(JSON.stringify(repo.toJSON())).not.toContain('ghp_ABC');
  });
});

describe('T-1 Klonen, Fetchen, Verbindung testen', () => {
  it('klont ein (lokales) Repo und beim zweiten Mal wird gefetcht', async () => {
    const repo = addRepo({ name: 'r1', source: remoteDir });
    const work = path.join(tmp, 'work1');

    const first = await cloneOrFetch(repo, work);
    expect(first.action).toBe('clone');
    expect(fs.existsSync(path.join(work, 'plugin.js'))).toBe(true);

    const second = await cloneOrFetch(repo, work);
    expect(second.action).toBe('fetch');
  });

  it('testConnection meldet ok=true für erreichbares Repo', async () => {
    const repo = addRepo({ name: 'r2', source: remoteDir });
    const res = await testConnection(repo);
    expect(res.ok).toBe(true);
    expect(res.refs).toBeGreaterThan(0);
  });

  it('testConnection meldet ok=false für nicht existierendes Repo', async () => {
    const repo = addRepo({ name: 'r3', source: path.join(tmp, 'gibtsnicht') });
    const res = await testConnection(repo);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
