import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createComponentStore } from '../src/gui/store.js';
import { SecretStore } from '../src/config/secrets.js';
import { createSettings, setWorkDir } from '../src/config/settings.js';

describe('Persistenz über Neustart', () => {
  it('Komponenten bleiben über eine neue Store-Instanz erhalten', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-persist-'));
    const file = path.join(tmp, 'components.json');
    const s1 = createComponentStore({ file });
    s1.add({ name: 'mein-plugin', source: 'https://x/y.git', visibility: 'intern', secretRef: 'repo:1' });
    const s2 = createComponentStore({ file }); // „Neustart"
    expect(s2.list()).toHaveLength(1);
    expect(s2.list()[0]).toMatchObject({ name: 'mein-plugin', source: 'https://x/y.git', secretRef: 'repo:1' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('Secrets überstehen Neustart verschlüsselt und sind wieder entschlüsselbar', () => {
    const store1 = new SecretStore('master');
    store1.set('repo:1', 'ghp_TOKEN_persist');
    const persisted = JSON.stringify(store1.toJSON()); // → Datei
    expect(persisted).not.toContain('ghp_TOKEN_persist'); // nur Chiffrat

    const blobs = JSON.parse(persisted).blobs;
    const store2 = new SecretStore('master', blobs); // „Neustart"
    expect(store2.get('repo:1')).toBe('ghp_TOKEN_persist');
  });

  it('Einstellungen lassen sich serialisieren und wiederherstellen', () => {
    const s1 = createSettings();
    setWorkDir(s1, './mein-arbeitsordner');
    const saved = JSON.stringify(s1);
    const s2 = Object.assign(createSettings(), JSON.parse(saved)); // „Neustart"-Laden
    expect(s2.workDir).toBe('./mein-arbeitsordner');
  });
});
