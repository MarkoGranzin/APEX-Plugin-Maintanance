/**
 * Einheitliche KI-Aufruf-Abstraktion (Wissen #503): ein Backend bietet complete(prompt, opts).
 *
 * Hier in Slice 23 (MVP) wird ein deterministisches Stub-Backend verwendet, damit die
 * Test-Generierungs-Pipeline (T-4/T-5) und der Selbstheilungs-Loop (T-15) verifizierbar sind.
 * Die ECHTEN Backends (lokale CLI ODER Provider+API-Key) inkl. Verbindungstest werden in
 * Slice 26 (T-11) verdrahtet und an dieselbe Schnittstelle gehängt. Secrets kommen
 * ausschließlich über get_connection (T-12) — niemals hier im Klartext.
 *
 * Resultat: src/ai/backend.js
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * @typedef {Object} AiBackend
 * @property {(prompt:string, opts?:object)=>Promise<string>} complete
 * @property {string} kind
 */

/**
 * Deterministisches Stub-Backend für Tests/MVP. Erzeugt aus opts.targets eine lauffähige
 * Vitest-Testdatei mit einem it() je Ziel. Optional über opts.respond steuerbar
 * (z.B. für den Selbstheilungs-Loop, der eine Korrektur liefern soll).
 * @returns {AiBackend}
 */
export function stubBackend(behavior = {}) {
  return {
    kind: 'stub',
    async complete(prompt, opts = {}) {
      if (behavior.respond) return behavior.respond(prompt, opts);
      const targets = opts.targets ?? [];
      const artifact = opts.artifact ?? 'artifact';
      const its = targets
        .map((t) => `  it(${JSON.stringify(t + ' funktioniert')}, () => {\n    expect(typeof ${safeId(t)}).not.toBe('undefined');\n  });`)
        .join('\n');
      return `import { describe, it, expect } from 'vitest';\n\ndescribe(${JSON.stringify(artifact)}, () => {\n${its || "  it('rendert', () => { expect(1).toBe(1); });"}\n});\n`;
    },
  };
}

function safeId(name) {
  return String(name).replace(/[^a-zA-Z0-9_$]/g, '_');
}

/**
 * T-11 — Backend-Fabrik: schaltet zwischen lokaler CLI und Provider+API-Key um.
 * Einheitliche Schnittstelle: { kind, complete(prompt,opts), testConnection(), requiresApiKey }.
 * Deps sind injizierbar (spawn/http) → testbar ohne echte CLI/Netz.
 *
 * @param {{kind:'cli'|'provider'|'stub', command?:string, args?:string[], endpoint?:string, model?:string, apiKey?:string, behavior?:object}} config
 * @param {{spawn?:Function, http?:Function}} [deps]
 */
export function createBackend(config = {}, deps = {}) {
  switch (config.kind) {
    case 'cli':
      return cliBackend(config, deps);
    case 'provider':
      return providerBackend(config, deps);
    case 'stub':
      return stubBackend(config.behavior);
    default:
      throw new Error(`Unbekanntes KI-Backend: ${config.kind}`);
  }
}

/**
 * Sinnvolle Default-Argumente je CLI. Claude Code ist OHNE Flag interaktiv und kehrt nie zurück —
 * der Print-Modus `-p` liest den Prompt von stdin und gibt die Antwort auf stdout aus.
 */
export function cliArgsFor(command) {
  const base = String(command || '').replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe|bat|ps1)$/i, '');
  if (/^claude/i.test(base)) return ['-p'];
  return [];
}

/**
 * Findet die gebündelte Claude-Desktop-Binary (claude.exe), wenn `claude` nicht auf dem PATH liegt.
 * Die Desktop-App installiert nach %APPDATA%/%LOCALAPPDATA%\Claude\claude-code\<version>\claude.exe und
 * legt KEINEN PATH-Eintrag an — bare `claude` führt sonst zu ENOENT. Wählt die höchste Version.
 * @param {object} [env] für Tests injizierbar (default process.env)
 */
export function findBundledClaude(env = process.env) {
  if (process.platform !== 'win32') return null;
  // env-Variablen (APPDATA/LOCALAPPDATA/USERPROFILE) sind in manchen Start-Umgebungen NICHT gesetzt →
  // zusätzlich os.homedir() nutzen UND notfalls alle Benutzerprofile unter C:\Users scannen.
  let home = env.USERPROFILE || ((env.HOMEDRIVE && env.HOMEPATH) ? env.HOMEDRIVE + env.HOMEPATH : null);
  if (!home) { try { home = os.homedir(); } catch { /* egal */ } }
  const bases = new Set();
  for (const b of [env.APPDATA, env.LOCALAPPDATA, home && path.join(home, 'AppData', 'Roaming'), home && path.join(home, 'AppData', 'Local')].filter(Boolean)) bases.add(b);
  // Fallback: alle Profile durchsuchen (C:\Users\<user>\AppData\{Roaming,Local})
  try {
    const usersRoot = home ? path.dirname(home) : (env.SystemDrive ? env.SystemDrive + '\\Users' : 'C:\\Users');
    for (const u of fs.readdirSync(usersRoot)) { bases.add(path.join(usersRoot, u, 'AppData', 'Roaming')); bases.add(path.join(usersRoot, u, 'AppData', 'Local')); }
  } catch { /* egal */ }
  const roots = [...new Set([...bases].map((b) => path.join(b, 'Claude', 'claude-code')))];
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  let best = null, bestV = null;
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const exe = path.join(root, d, 'claude.exe');
      try { if (!fs.statSync(exe).isFile()) continue; } catch { continue; }
      const v = d.split('.').map((n) => parseInt(n, 10) || 0);
      if (!bestV || cmp(v, bestV) > 0) { best = exe; bestV = v; }
    }
  }
  return best;
}

/** Löst den CLI-Befehl auf: absoluter Pfad → direkt; bares `claude` (win32) → gebündelte Desktop-Binary, falls vorhanden. */
export function resolveCliCommand(command, env = process.env) {
  try { if (path.isAbsolute(command) && fs.existsSync(command)) return command; } catch { /* egal */ }
  const base = String(command || '').replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe|bat|ps1)$/i, '');
  if (/^claude$/i.test(base)) return findBundledClaude(env) ?? command; // sonst PATH-Auflösung via shell:true
  return command;
}

/** Lokale CLI: kein API-Key nötig; Prompt geht an den Befehl, Antwort kommt aus stdout. */
export function cliBackend(config, deps = {}) {
  const run = deps.spawn ?? defaultSpawn;
  const resolve = deps.resolveCommand ?? resolveCliCommand;
  const cmd = resolve(config.command); // bares `claude` (win32) → gebündelte Desktop-Binary, falls vorhanden
  const args = config.args ?? cliArgsFor(config.command); // z.B. claude → ['-p'] (Print-Modus)
  return {
    kind: 'cli',
    requiresApiKey: false,
    resolvedCommand: cmd,
    async complete(prompt, opts = {}) {
      const { stdout } = await run(cmd, args, { input: prompt });
      return String(stdout).trim();
    },
    async testConnection() {
      try {
        await run(cmd, ['--version'], {});
        return { ok: true, command: cmd };
      } catch (err) {
        const hint = /ENOENT/i.test(String(err?.message ?? err)) ? ' — not found on PATH (install it or set the full path in settings)' : '';
        return { ok: false, error: `CLI "${cmd}" not callable: ${err?.message ?? err}${hint}` };
      }
    },
  };
}

/** Provider+API-Key: braucht gültigen Key; ungültiger Key blockiert produktive Läufe. */
export function providerBackend(config, deps = {}) {
  const http = deps.http ?? defaultHttp;
  const auth = () => {
    if (!config.apiKey) throw new Error('Kein API-Key gesetzt — produktiver Lauf blockiert');
    return { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  };
  return {
    kind: 'provider',
    requiresApiKey: true,
    async complete(prompt, opts = {}) {
      const res = await http(config.endpoint, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ model: config.model, prompt, ...(opts.params ?? {}) }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Ungültiger API-Key — produktiver Lauf blockiert');
      }
      if (res.status >= 400) throw new Error(`Provider-Fehler ${res.status}`);
      return String(res.body?.text ?? res.body ?? '').trim();
    },
    async testConnection() {
      try {
        if (!config.apiKey) return { ok: false, error: 'Kein API-Key gesetzt' };
        const res = await http(config.endpoint, { method: 'GET', headers: auth() });
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'Ungültiger API-Key' };
        if (res.status >= 400) return { ok: false, error: `Provider-Fehler ${res.status}` };
        return { ok: true, model: config.model };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  };
}

async function defaultSpawn(command, args, { input } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    // Windows: für Shims (.cmd/.bat/.ps1) oder bare Namen braucht spawn shell:true, sonst ENOENT.
    // Eine direkt startbare .exe (z.B. aufgelöste Desktop-Binary) wird OHNE shell gestartet — das
    // vermeidet die DEP0190-Warnung und das Arg-Quoting-Risiko. Der Prompt geht ohnehin über stdin.
    const isExe = /\.exe$/i.test(command);
    const p = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && !isExe });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`))));
    if (input != null) p.stdin.end(input);
  });
}

async function defaultHttp(url, init) {
  const res = await fetch(url, init);
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}
