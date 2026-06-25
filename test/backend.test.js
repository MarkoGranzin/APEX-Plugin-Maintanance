import { describe, it, expect } from 'vitest';
import { createBackend } from '../src/ai/backend.js';

describe('T-11 CLI-Backend', () => {
  it('nutzt die CLI und braucht keinen API-Key', async () => {
    let calledWith = null;
    const spawn = async (cmd, args, { input }) => {
      calledWith = { cmd, args, input };
      return { stdout: 'CLI-ANTWORT' };
    };
    const be = createBackend({ kind: 'cli', command: 'mycli', args: ['gen'] }, { spawn });
    expect(be.requiresApiKey).toBe(false);
    const out = await be.complete('hallo');
    expect(out).toBe('CLI-ANTWORT');
    expect(calledWith.cmd).toBe('mycli');
    expect(calledWith.input).toBe('hallo');
  });

  it('testConnection ok wenn CLI aufrufbar', async () => {
    const spawn = async () => ({ stdout: 'v1.0' });
    const be = createBackend({ kind: 'cli', command: 'mycli' }, { spawn });
    expect(await be.testConnection()).toEqual({ ok: true });
  });

  it('testConnection meldet klaren Fehler wenn CLI fehlt', async () => {
    const spawn = async () => { throw new Error('ENOENT'); };
    const be = createBackend({ kind: 'cli', command: 'fehlt' }, { spawn });
    const r = await be.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nicht aufrufbar/);
  });
});

describe('T-11 Provider + API-Key', () => {
  const http = (key) => async (url, init) => {
    const ok = init.headers.Authorization === 'Bearer GUT';
    return ok ? { status: 200, body: { text: 'PROVIDER-ANTWORT' } } : { status: 401, body: 'unauthorized' };
  };

  it('Verbindung testen meldet Erfolg bei gültigem Key', async () => {
    const be = createBackend({ kind: 'provider', endpoint: 'https://api/x', apiKey: 'GUT' }, { http: http() });
    expect(await be.testConnection()).toMatchObject({ ok: true });
  });

  it('ungültiger Key: testConnection meldet Fehler UND blockiert produktive Läufe', async () => {
    const be = createBackend({ kind: 'provider', endpoint: 'https://api/x', apiKey: 'SCHLECHT' }, { http: http() });
    expect(await be.testConnection()).toMatchObject({ ok: false, error: 'Ungültiger API-Key' });
    await expect(be.complete('x')).rejects.toThrow(/Ungültiger API-Key|blockiert/);
  });

  it('fehlender Key blockiert produktiven Lauf', async () => {
    const be = createBackend({ kind: 'provider', endpoint: 'https://api/x' }, { http: http() });
    await expect(be.complete('x')).rejects.toThrow(/Kein API-Key|blockiert/);
  });

  it('gültiger Key liefert Antwort', async () => {
    const be = createBackend({ kind: 'provider', endpoint: 'https://api/x', apiKey: 'GUT' }, { http: http() });
    expect(await be.complete('frage')).toBe('PROVIDER-ANTWORT');
  });
});

describe('T-11 Umschalten', () => {
  it('createBackend wählt das konfigurierte Backend', () => {
    expect(createBackend({ kind: 'cli', command: 'c' }).kind).toBe('cli');
    expect(createBackend({ kind: 'provider', endpoint: 'e' }).kind).toBe('provider');
    expect(() => createBackend({ kind: 'unbekannt' })).toThrow(/Unbekanntes KI-Backend/);
  });
});
