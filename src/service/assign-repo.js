/**
 * F-21 (T-42) — Repo einem Plugin (Komponente) zuordnen.
 *
 * Plugin-zentrierter Flow: erst „+ Plugin", dann dem Plugin ein Repo zuordnen. Bei internem Repo
 * werden Zugangsdaten (PAT-Token / SSH-Key) verschlüsselt im SecretStore (T-12) abgelegt; die
 * Komponente hält NUR eine secretRef. Geklont wird in das (versteckte) Arbeitsverzeichnis, wobei
 * jedes Repo sein eigenes Unterverzeichnis erhält; Auth wird zur Laufzeit aufgelöst, nie persistiert.
 *
 * Resultat: src/service/assign-repo.js
 */

import { addRepo, cloneOrFetch } from '../repo/repository.js';
import { repoComponent, repoCheckoutDir } from './workspace.js';
import { slug } from '../util/slug.js';

/**
 * @param {object} store
 * @param {string} id  Komponenten-id
 * @param {{source:string, visibility?:string, token?:string, sshKeyPath?:string}} spec
 * @param {{workDir:string, secretStore?:object, gitFactory?:Function}} deps
 * @returns {Promise<object|{error:string}>} aktualisierte Komponente (ohne Secret)
 */
export async function assignRepoToComponent(store, id, spec, deps = {}) {
  const comp = store.get(id);
  if (!comp) return { error: 'Komponente nicht gefunden' };
  if (!spec?.source) return { error: 'Repo-Quelle (URL/Pfad) fehlt' };

  const workDir = deps.workDir ?? './workspace';
  const internal = spec.visibility === 'intern';

  // Zugangsdaten verschlüsselt ablegen (nur intern + vorhanden) → secretRef
  let secretRef = comp.secretRef ?? null;
  if (internal && (spec.token || spec.sshKeyPath) && deps.secretStore) {
    secretRef = `repo:${id}`;
    deps.secretStore.set(secretRef, JSON.stringify({ token: spec.token ?? null, sshKeyPath: spec.sshKeyPath ?? null }));
  }

  // Auth NUR zur Laufzeit aus dem SecretStore auflösen (nie persistieren/loggen)
  let auth;
  if (secretRef && deps.secretStore) {
    try {
      auth = JSON.parse(deps.secretStore.get(secretRef) ?? 'null') ?? undefined;
    } catch {
      auth = undefined;
    }
  }

  const name = slug(comp.name);
  const dir = repoCheckoutDir(workDir, name);
  await cloneOrFetch(addRepo({ name, source: spec.source, auth }), dir, { gitFactory: deps.gitFactory });

  const rc = repoComponent(dir, comp.name);
  return store.update(id, {
    source: spec.source,
    visibility: spec.visibility ?? 'öffentlich',
    secretRef,
    repo: comp.name,
    path: dir,
    type: rc.type,
    format: rc.format,
    status: rc.status,
  });
}
