/**
 * T-1 — Repo per URL/Pfad hinzufügen + Auth (Token/SSH), klonen/fetchen, Verbindung testen.
 *
 * Leitplanke (Wissen #503): Secrets niemals im Klartext in serialisierten/loggbaren Formen.
 * Auth-Werte (Token/SSH-Key) werden hier nur transient zum Bau der Git-URL/Env benutzt und
 * NICHT in das persistierbare Repo-Objekt (toJSON) übernommen — dort steht nur eine
 * `secretRef` (Name der Connection, aus der das Secret später via get_connection kommt).
 *
 * Resultat: src/repo/repository.js
 */

import { simpleGit } from 'simple-git';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {'local'|'https'|'ssh'} RepoKind */

/**
 * Bestimmt aus URL/Pfad die Art des Repos.
 * @param {string} source URL oder lokaler Pfad
 * @returns {RepoKind}
 */
export function detectRepoKind(source) {
  if (!source || typeof source !== 'string') {
    throw new Error('Repo-Quelle (URL oder Pfad) fehlt');
  }
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) return 'https';
  if (/^git@|^ssh:\/\//i.test(s)) return 'ssh';
  // alles andere als lokaler Pfad behandeln
  return 'local';
}

/**
 * Legt ein Repo-Objekt an. Auth-Daten werden NICHT im Objekt gespeichert (nur secretRef).
 *
 * @param {object} cfg
 * @param {string} cfg.name        eindeutiger Name des Repos
 * @param {string} cfg.source      URL oder lokaler Pfad
 * @param {object} [cfg.auth]      transiente Auth (wird nicht persistiert)
 * @param {string} [cfg.auth.token]   PAT für https
 * @param {string} [cfg.auth.sshKeyPath] Pfad zum privaten SSH-Key
 * @param {string} [cfg.secretRef] Name der Connection, aus der das Secret stammt
 * @returns {Repo}
 */
export function addRepo(cfg) {
  if (!cfg?.name) throw new Error('Repo-Name fehlt');
  const kind = detectRepoKind(cfg.source);
  return new Repo({
    name: cfg.name,
    source: cfg.source.trim(),
    kind,
    secretRef: cfg.secretRef ?? null,
    auth: cfg.auth ?? null,
  });
}

export class Repo {
  constructor({ name, source, kind, secretRef, auth }) {
    this.name = name;
    this.source = source;
    this.kind = kind;
    this.secretRef = secretRef ?? null;
    // auth ist transient & non-enumerable, damit es nicht in JSON/Logs landet
    Object.defineProperty(this, '_auth', {
      value: auth ?? null,
      enumerable: false,
      writable: true,
    });
    this.lastProcessedCommit = null; // Eingang für T-3 (Diff)
  }

  /** Baut die für Git nutzbare URL (Token eingebettet) — nur transient verwenden, nie loggen. */
  authenticatedSource() {
    if (this.kind === 'https' && this._auth?.token) {
      const u = new URL(this.source);
      // x-access-token ist das von GitHub akzeptierte Schema für PATs
      u.username = 'x-access-token';
      u.password = this._auth.token;
      return u.toString();
    }
    return this.source;
  }

  /** Git-Env für SSH-Key (GIT_SSH_COMMAND), sonst leer. */
  gitEnv() {
    if (this.kind === 'ssh' && this._auth?.sshKeyPath) {
      return {
        GIT_SSH_COMMAND: `ssh -i "${this._auth.sshKeyPath}" -o IdentitiesOnly=yes`,
      };
    }
    return {};
  }

  /** Persistierbare Sicht — bewusst OHNE Auth-Geheimnisse. */
  toJSON() {
    return {
      name: this.name,
      source: this.source,
      kind: this.kind,
      secretRef: this.secretRef,
      lastProcessedCommit: this.lastProcessedCommit,
    };
  }
}

/**
 * Klont das Repo nach targetDir, oder fetcht, wenn dort schon ein Klon liegt.
 * @param {Repo} repo
 * @param {string} targetDir Zielverzeichnis des Arbeits-Klons
 * @param {object} [opts]
 * @param {(dir?:string, env?:object)=>import('simple-git').SimpleGit} [opts.gitFactory] für Tests injizierbar
 * @returns {Promise<{action:'clone'|'fetch', dir:string}>}
 */
export async function cloneOrFetch(repo, targetDir, opts = {}) {
  const gitFactory = opts.gitFactory ?? ((dir, env) => simpleGit({ baseDir: dir, ...(env ? { env } : {}) }));
  const env = repo.gitEnv();
  const alreadyCloned = fs.existsSync(path.join(targetDir, '.git'));

  if (alreadyCloned) {
    const git = gitFactory(targetDir, env);
    await git.fetch(['--all', '--prune']);
    return { action: 'fetch', dir: targetDir };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const git = gitFactory(undefined, env);
  await git.clone(repo.authenticatedSource(), targetDir);
  return { action: 'clone', dir: targetDir };
}

/**
 * Testet die Verbindung ohne vollständigen Klon: `git ls-remote`.
 * @param {Repo} repo
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, refs?:number, error?:string}>}
 */
export async function testConnection(repo, opts = {}) {
  const gitFactory = opts.gitFactory ?? ((dir, env) => simpleGit(dir ? { baseDir: dir, env } : { env }));
  const env = repo.gitEnv();
  try {
    const git = gitFactory(undefined, env);
    const out = await git.listRemote([repo.authenticatedSource()]);
    const refs = String(out).trim().split('\n').filter(Boolean).length;
    return { ok: refs > 0, refs };
  } catch (err) {
    // Fehlermeldung bereinigen, damit kein Token im Text durchsickert
    const msg = redactSecrets(String(err?.message ?? err), repo);
    return { ok: false, error: msg };
  }
}

/** Entfernt eingebettete Token aus einem String (Defense-in-Depth fürs Logging). */
export function redactSecrets(text, repo) {
  let out = text;
  if (repo?._auth?.token) out = out.split(repo._auth.token).join('***');
  return out;
}
