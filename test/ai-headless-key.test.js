import { describe, it, expect } from 'vitest';
import { cliBackend } from '../src/ai/backend.js';

// B-62: das CLI-Backend darf einen OPTIONALEN API-Key headless ins Child-Env injizieren (ANTHROPIC_API_KEY),
// damit claude ohne interaktives Login läuft (Scheduler/Dienst/headless). Ohne Key bleibt das Env unverändert.
const PRINT_KEY = ['-e', 'process.stdout.write(String(process.env.ANTHROPIC_API_KEY||""))'];

describe('B-62 CLI-Backend: optionaler headless-API-Key', () => {
  it('mit apiKey → ANTHROPIC_API_KEY landet im Child-Env', async () => {
    const be = cliBackend({ command: process.execPath, args: PRINT_KEY, apiKey: 'SECRET-b62-xyz' });
    expect(be.usesApiKey).toBe(true);
    expect(await be.complete('')).toBe('SECRET-b62-xyz');
  });

  it('ohne apiKey → unser Key wird NICHT injiziert (interaktives Login/Env bleibt)', async () => {
    const be = cliBackend({ command: process.execPath, args: PRINT_KEY });
    expect(be.usesApiKey).toBe(false);
    // ambient env könnte einen eigenen Key haben — entscheidend: NICHT unser injizierter Wert
    expect(await be.complete('')).not.toBe('SECRET-b62-xyz');
  });
});

import { cliAuthState } from '../src/ai/configure.js';

describe('GUI-Login-Check: cliAuthState (nur Ablaufdaten, keine Secrets)', () => {
  const NOW = 1800000000000;
  const deps = (creds) => ({ now: () => NOW, home: '/h', exists: () => creds !== undefined, readFile: () => JSON.stringify({ claudeAiOauth: creds }) });

  it('API-Key hinterlegt → headless ok, Login egal', () => {
    expect(cliAuthState({ hasApiKey: true })).toMatchObject({ method: 'api-key', loggedIn: true });
  });
  it('gültiger Refresh-Token → eingeloggt (mit validUntil)', () => {
    const r = cliAuthState(deps({ expiresAt: NOW - 1000, refreshTokenExpiresAt: NOW + 86400000 }));
    expect(r).toMatchObject({ method: 'oauth', loggedIn: true });
    expect(r.validUntil).toBe(new Date(NOW + 86400000).toISOString());
  });
  it('beide Tokens abgelaufen → NICHT eingeloggt mit Ablauf-Grund', () => {
    const r = cliAuthState(deps({ expiresAt: 0, refreshTokenExpiresAt: NOW - 5000 }));
    expect(r.loggedIn).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
  it('keine Credentials-Datei → nie eingeloggt', () => {
    const r = cliAuthState({ now: () => NOW, home: '/h', exists: () => false });
    expect(r.loggedIn).toBe(false);
    expect(r.reason).toMatch(/never logged in/);
  });
});
