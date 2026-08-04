import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, mask, SecretStore } from '../src/config/secrets.js';
import { createSettings, addRepo, removeRepo, setRecipients, setSchedule, setAiBackend } from '../src/config/settings.js';

describe('T-12 Secrets verschlüsselt', () => {
  it('legt Secret verschlüsselt ab — kein Klartext in der Persistenz', () => {
    const store = new SecretStore('master-pass');
    store.set('gh-token', 'ghp_SUPERSECRET');
    const json = JSON.stringify(store);
    expect(json).not.toContain('ghp_SUPERSECRET');
    expect(store.blobs['gh-token']).toHaveProperty('tag');
  });

  it('entschlüsselt mit korrektem Master-Key zum Originalwert', () => {
    const store = new SecretStore('master-pass');
    store.set('key', 'sk-12345');
    expect(store.get('key')).toBe('sk-12345');
  });

  it('falscher Master-Key schlägt fehl', () => {
    const blob = encryptSecret('geheim', 'richtig');
    expect(() => decryptSecret(blob, 'falsch')).toThrow(/failed/);
  });

  it('Anzeige ist maskiert', () => {
    const store = new SecretStore('m');
    store.set('k', 'ghp_abcdefgh1234');
    const shown = store.display().k;
    expect(shown).not.toBe('ghp_abcdefgh1234');
    expect(shown).toMatch(/^ghp\*+1234$/);
    expect(mask('xy')).toBe('****');
  });
});

describe('T-12 Einstellungen konfigurierbar', () => {
  it('Repos hinzufügen/entfernen (ohne Duplikate)', () => {
    const s = createSettings();
    addRepo(s, { name: 'r1', source: 'https://x/y.git', secretRef: 'gh-token' });
    expect(s.repos).toHaveLength(1);
    expect(() => addRepo(s, { name: 'r1', source: 'https://x/y.git' })).toThrow(/already exists/);
    removeRepo(s, 'r1');
    expect(s.repos).toHaveLength(0);
  });

  it('Empfänger validieren', () => {
    const s = createSettings();
    setRecipients(s, ['a@b.de', 'c@d.com']);
    expect(s.recipients).toHaveLength(2);
    expect(() => setRecipients(s, ['kaputt'])).toThrow(/invalid email/i);
  });

  it('Zeitplan validieren (Cron 5 Felder)', () => {
    const s = createSettings();
    setSchedule(s, '0 4 * * 1');
    expect(s.schedule).toBe('0 4 * * 1');
    expect(() => setSchedule(s, 'jeden tag')).toThrow(/Invalid cron/);
  });

  it('KI-Backend konfigurierbar, Repos referenzieren nur secretRef (kein Key)', () => {
    const s = createSettings();
    setAiBackend(s, { kind: 'provider', endpoint: 'https://api', model: 'claude-opus-4-8', secretRef: 'ai-key' });
    addRepo(s, { name: 'r', source: 'p', secretRef: 'gh' });
    expect(s.aiBackend.kind).toBe('provider');
    expect(JSON.stringify(s)).not.toMatch(/sk-|ghp_/);
    expect(s.repos[0].secretRef).toBe('gh');
  });
});
