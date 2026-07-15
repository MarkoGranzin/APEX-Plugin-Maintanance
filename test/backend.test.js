import { describe, it, expect } from 'vitest';
import { createBackend, findBundledClaude, resolveCliCommand, highestClaudeExe } from '../src/ai/backend.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

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
    expect(await be.testConnection()).toMatchObject({ ok: true });
  });

  it('testConnection meldet klaren Fehler wenn CLI fehlt', async () => {
    const spawn = async () => { throw new Error('ENOENT'); };
    const be = createBackend({ kind: 'cli', command: 'fehlt' }, { spawn });
    const r = await be.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not callable/);
  });

  it('claude → Print-Modus (-p) als Default-Args, sonst keine', async () => {
    let argsClaude = null, argsOther = null;
    const be1 = createBackend({ kind: 'cli', command: 'claude' }, { spawn: async (_c, a) => { argsClaude = a; return { stdout: 'x' }; } });
    await be1.complete('hi');
    const be2 = createBackend({ kind: 'cli', command: 'mycli' }, { spawn: async (_c, a) => { argsOther = a; return { stdout: 'x' }; } });
    await be2.complete('hi');
    expect(argsClaude).toEqual(['-p']);
    expect(argsOther).toEqual([]);
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
    expect(await be.testConnection()).toMatchObject({ ok: false, error: 'Invalid API key' });
    await expect(be.complete('x')).rejects.toThrow(/Invalid API key|blocked/);
  });

  it('fehlender Key blockiert produktiven Lauf', async () => {
    const be = createBackend({ kind: 'provider', endpoint: 'https://api/x' }, { http: http() });
    await expect(be.complete('x')).rejects.toThrow(/No API key|blocked/);
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
    expect(() => createBackend({ kind: 'unbekannt' })).toThrow(/Unknown AI backend/);
  });
});

describe('findBundledClaude: robuste Auflösung (kein Pinnen)', () => {
  it('findet claude im npm-Global-Bin, wenn keine Desktop-App vorhanden (win32)', () => {
    if (process.platform !== 'win32') return; // Pfadlogik ist win32-spezifisch
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-npm-'));
    const roaming = path.join(root, 'Roaming');
    fs.mkdirSync(path.join(roaming, 'npm'), { recursive: true });
    fs.writeFileSync(path.join(roaming, 'npm', 'claude.cmd'), '@echo claude');
    const env = { APPDATA: roaming, LOCALAPPDATA: path.join(root, 'Local'), USERPROFILE: root, SystemDrive: root };
    const found = findBundledClaude(env);
    expect(found).toBe(path.join(roaming, 'npm', 'claude.cmd'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('B-33 cliBackend: handlungsfaehige Meldung bei nicht auffindbarer CLI', () => {
  it('wirft eine klare Meldung statt rohem Shell-Text (ENOENT/nicht gefunden)', async () => {
    const spawn = async () => { throw new Error('Der Befehl "claude" ist entweder falsch geschrieben oder konnte nicht gefunden werden.'); };
    const be = createBackend({ kind: 'cli', command: 'nixgibtsda' }, { spawn, resolveCommand: (c) => c });
    await expect(be.complete('hi')).rejects.toThrow(/not callable|environment/i);
  });
});

describe('resolveCliCommand: stabiler Ordner statt fixer .exe (kein Pinnen)', () => {
  it('Ordner mit Versions-Unterordnern -> hoechste claude.exe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    for (const v of ['2.1.99', '2.1.197', '2.0.5']) { fs.mkdirSync(path.join(root, v), { recursive: true }); fs.writeFileSync(path.join(root, v, 'claude.exe'), 'x'); }
    expect(highestClaudeExe(root)).toBe(path.join(root, '2.1.197', 'claude.exe'));
    expect(resolveCliCommand(root)).toBe(path.join(root, '2.1.197', 'claude.exe'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('voller .exe-Pfad wird direkt genutzt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc2-'));
    const exe = path.join(root, 'claude.exe'); fs.writeFileSync(exe, 'x');
    expect(resolveCliCommand(exe)).toBe(exe);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
