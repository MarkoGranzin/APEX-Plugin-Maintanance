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

import { createBackend } from './backend.js';

export function resolveAiBackend(settings, secretStore, deps = {}) {
  const cfg = { ...(settings?.aiBackend ?? { kind: 'stub' }) };
  if (cfg.kind === 'provider' && cfg.secretRef && secretStore) {
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
