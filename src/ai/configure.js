/**
 * KI-Backend aus den Einstellungen auflösen (für Fixen/Reviewen/Testgenerierung).
 *
 * settings.aiBackend = { kind:'cli'|'provider'|'stub', command?, endpoint?, model?, secretRef? }.
 * Der API-Key (Provider) liegt verschlüsselt im SecretStore (T-12) unter secretRef und wird NUR
 * zur Laufzeit aufgelöst — nie persistiert/geloggt. So gibt es EINE Stelle, an der das KI-Backend
 * konfiguriert wird; alle Konsumenten (selfHeal, autoReviewFix, Testgenerierung) nutzen diesen Resolver.
 *
 * Resultat: src/ai/configure.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from './backend.js';

/**
 * Login-/Auth-Zustand des CLI-Backends (claude) für die GUI — OHNE Secrets zu lesen/auszugeben.
 * Prüft NUR die Ablauf-Zeitstempel in ~/.claude/.credentials.json (claudeAiOauth.expiresAt /
 * refreshTokenExpiresAt). Ist ein API-Key hinterlegt (B-62), ist das Login egal → headless ok.
 * Alle Zugriffe injizierbar → deterministisch testbar.
 * @returns {{method:'api-key'|'oauth', loggedIn:boolean, validUntil:string|null, reason:string|null}}
 */
export function cliAuthState({ hasApiKey = false, readFile, exists, home, now } = {}) {
  if (hasApiKey) return { method: 'api-key', loggedIn: true, validUntil: null, reason: null };
  const nowMs = now ? now() : Date.now();
  const file = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  const ex = exists ?? ((f) => fs.existsSync(f));
  const rd = readFile ?? ((f) => fs.readFileSync(f, 'utf8'));
  if (!ex(file)) return { method: 'oauth', loggedIn: false, validUntil: null, reason: 'never logged in (no credentials file)' };
  let o;
  try { o = JSON.parse(rd(file)).claudeAiOauth || {}; }
  catch { return { method: 'oauth', loggedIn: false, validUntil: null, reason: 'Credentials file not readable' }; }
  // eingeloggt, solange Access ODER Refresh noch gültig ist (Access wird per Refresh erneuert)
  const best = Math.max(Number(o.expiresAt) || 0, Number(o.refreshTokenExpiresAt) || 0);
  if (best > nowMs) return { method: 'oauth', loggedIn: true, validUntil: new Date(best).toISOString(), reason: null };
  return { method: 'oauth', loggedIn: false, validUntil: null, reason: best ? `Login expired on ${new Date(best).toISOString()}` : 'no token' };
}

export function resolveAiBackend(settings, secretStore, deps = {}) {
  const cfg = { ...(settings?.aiBackend ?? { kind: 'stub' }) };
  // B-62: Key aus dem SecretStore auch für 'cli' auflösen (optionaler headless-Key) — nicht nur 'provider'.
  if ((cfg.kind === 'provider' || cfg.kind === 'cli') && cfg.secretRef && secretStore) {
    try { cfg.apiKey = secretStore.get(cfg.secretRef) ?? undefined; } catch { /* kein Key */ }
  }
  return createBackend(cfg, deps);
}

/** Sicht aufs konfigurierte Backend OHNE Geheimnis (für GUI/Status). */
export function aiBackendView(settings) {
  const cfg = settings?.aiBackend ?? { kind: 'stub' };
  return {
    kind: cfg.kind,
    command: cfg.command ?? null,
    endpoint: cfg.endpoint ?? null,
    model: cfg.model ?? null,
    hasKey: !!cfg.secretRef,
  };
}
