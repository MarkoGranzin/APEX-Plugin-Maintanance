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

/** Lokale CLI: kein API-Key nötig; Prompt geht an den Befehl, Antwort kommt aus stdout. */
export function cliBackend(config, deps = {}) {
  const run = deps.spawn ?? defaultSpawn;
  return {
    kind: 'cli',
    requiresApiKey: false,
    async complete(prompt, opts = {}) {
      const { stdout } = await run(config.command, config.args ?? [], { input: prompt });
      return String(stdout).trim();
    },
    async testConnection() {
      try {
        await run(config.command, ['--version'], {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `CLI "${config.command}" nicht aufrufbar: ${err?.message ?? err}` };
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
    const p = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
