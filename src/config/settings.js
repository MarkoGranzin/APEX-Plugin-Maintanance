/**
 * T-12 — Einstellungen: Empfänger-Adressen, Zeitplan und Repos konfigurierbar.
 *
 * Hält die nicht-geheime Konfiguration. Secrets (API-Keys/Git-Tokens) werden NICHT hier,
 * sondern in der SecretStore (verschlüsselt) gehalten; hier stehen nur secretRefs (Namen).
 * Das KI-Backend (T-11) wird über aiBackend konfiguriert und der Key per secretRef aufgelöst.
 *
 * Resultat: src/config/settings.js
 */

export function createSettings(initial = {}) {
  return {
    workDir: initial.workDir ?? './workspace', // globales Arbeitsverzeichnis (F-18)
    repos: initial.repos ?? [], // [{name, source, secretRef}]
    recipients: initial.recipients ?? [], // E-Mail-Empfänger für Report (E-4)
    schedule: initial.schedule ?? '0 3 * * 1', // wann der automatische Check läuft (Cron, Default Mo 03:00)
    scheduleEnabled: initial.scheduleEnabled ?? false, // automatischer Lauf an/aus
    allowPush: initial.allowPush ?? false, // SICHERHEIT: Push zum Remote nur, wenn explizit erlaubt (T-76)
    autoRepair: initial.autoRepair ?? false, // nach Erkennung automatisch reparieren (Check → volle Pflege) (T-83)
    // T-163: Opt-in — unmaintained Libs im Lauf OHNE separate Approve-Aktion ersetzen/nachbauen (interface-
    // erhaltend, works-as-before-verifiziert). Default AUS: der Ersatz braucht sonst explizite Extra-Zustimmung.
    autoReplaceUnmaintained: initial.autoReplaceUnmaintained ?? false,
    smtp: initial.smtp ?? { host: '', port: 587, secure: false, user: '', from: '' }, // Mailversand
    aiBackend: initial.aiBackend ?? { kind: 'cli', command: 'claude' },
    // T-134: Ziel-APEX-App für „Live einspielen & testen" (F-31). Passwort NUR verschlüsselt im SecretStore
    // (secretRef 'apex-pass'), hier nur die nicht-geheime Konfig. workspaceId/owner aus einem App-Export.
    apexTarget: initial.apexTarget ?? { baseUrl: '', workspace: '', appId: '', alias: '', loginUser: '', workspaceId: '', owner: '', release: '24.2' },
  };
}

export function setApexTarget(settings, cfg = {}) {
  const cur = settings.apexTarget ?? {};
  settings.apexTarget = {
    baseUrl: (cfg.baseUrl ?? cur.baseUrl ?? '').trim().replace(/\/$/, ''),
    workspace: (cfg.workspace ?? cur.workspace ?? '').trim(),
    appId: String(cfg.appId ?? cur.appId ?? '').trim(),
    alias: (cfg.alias ?? cur.alias ?? '').trim(),
    loginUser: (cfg.loginUser ?? cur.loginUser ?? '').trim(),
    workspaceId: (cfg.workspaceId ?? cur.workspaceId ?? '').trim(),
    owner: (cfg.owner ?? cur.owner ?? '').trim(),
    release: (cfg.release ?? cur.release ?? '24.2').trim(),
  };
  return settings;
}

export function setSmtp(settings, cfg = {}) {
  settings.smtp = {
    host: cfg.host ?? settings.smtp?.host ?? '',
    port: Number(cfg.port ?? settings.smtp?.port ?? 587),
    secure: !!(cfg.secure ?? settings.smtp?.secure),
    user: cfg.user ?? settings.smtp?.user ?? '',
    from: cfg.from ?? settings.smtp?.from ?? '',
  };
  return settings;
}

export function setWorkDir(settings, dir) {
  if (!dir || typeof dir !== 'string') throw new Error('Working directory missing');
  settings.workDir = dir.trim();
  return settings;
}

export function addRepo(settings, repo) {
  if (!repo?.name || !repo?.source) throw new Error('Repo requires name and source');
  if (settings.repos.some((r) => r.name === repo.name)) {
    throw new Error(`Repo "${repo.name}" already exists`);
  }
  settings.repos.push({ name: repo.name, source: repo.source, secretRef: repo.secretRef ?? null });
  return settings;
}

export function removeRepo(settings, name) {
  settings.repos = settings.repos.filter((r) => r.name !== name);
  return settings;
}

export function setRecipients(settings, recipients) {
  const list = (recipients ?? []).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (list.length !== (recipients ?? []).length) {
    throw new Error('At least one invalid email address');
  }
  settings.recipients = list;
  return settings;
}

export function setSchedule(settings, cron) {
  if (!/^[\d*\/,\-\s]+$/.test(cron) || cron.trim().split(/\s+/).length !== 5) {
    throw new Error('Invalid cron expression (5 fields expected)');
  }
  settings.schedule = cron.trim();
  return settings;
}

export function setAiBackend(settings, cfg) {
  if (!['cli', 'provider', 'stub'].includes(cfg?.kind)) throw new Error('Invalid AI backend');
  settings.aiBackend = cfg;
  return settings;
}
