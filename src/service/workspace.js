/**
 * F-18 (T-35/T-36) — Arbeitsverzeichnis & Auto-Discovery.
 *
 * Primärer Flow: ein globales Arbeitsverzeichnis; Repos werden vom Tool selbst hinein geklont/
 * gefetcht (T-1) und die enthaltenen Plugins/Template-Komponenten automatisch erkannt (T-2/T-18)
 * und in die Komponenten-Registry (F-17) übernommen — je (repo+name) upsert, Re-Scan ohne Duplikate.
 *
 * Resultat: src/service/workspace.js
 */

import path from 'node:path';
import { addRepo, cloneOrFetch } from '../repo/repository.js';
import { detectArtifacts } from '../inventory/inventory.js';
import { enrichWithFormat, componentMeta } from '../inventory/format.js';

/** Checkout-Verzeichnis eines Repos im Arbeitsverzeichnis. */
export function repoCheckoutDir(workDir, repoName) {
  return path.join(workDir, repoName);
}

/**
 * Klont/fetcht ein Repo in workDir/<name>.
 * @param {{name:string, source:string, auth?:object, secretRef?:string}} repoConfig
 * @param {{workDir:string, gitFactory?:Function}} opts
 * @returns {Promise<{dir:string, action:'clone'|'fetch'}>}
 */
export async function addRepoToWorkspace(repoConfig, opts) {
  const dir = repoCheckoutDir(opts.workDir, repoConfig.name);
  const repo = addRepo(repoConfig);
  const res = await cloneOrFetch(repo, dir, { gitFactory: opts.gitFactory });
  return { dir, action: res.action };
}

/**
 * Modell: EIN Repo = EIN Plugin/Template-Komponente. Aus dem Checkout wird genau ein
 * Komponenten-Datensatz abgeleitet (Typ/Format aus der Erkennung, Pfad = Repo-Wurzel).
 * @param {string} checkoutDir
 * @param {string} repoName
 */
export function repoComponent(checkoutDir, repoName) {
  const artifacts = enrichWithFormat(detectArtifacts(checkoutDir));
  const meta = componentMeta(artifacts);
  return {
    name: repoName,
    repo: repoName,
    type: meta.type,
    format: artifacts.length === 0 ? 'unclear' : meta.format,
    status: artifacts.length === 0 ? 'zu klären' : 'erkannt',
    path: checkoutDir,
    artifactCount: artifacts.length,
  };
}

/**
 * Bindet ein Repo an (= ein Plugin) und upsertet die EINE Komponente je Repo (kein Duplikat).
 * @param {object} repoConfig {name, source, ...}
 * @param {{workDir:string, store:object, gitFactory?:Function}} opts
 * @returns {Promise<{repo:string, dir:string, added:number, updated:number, component:object}>}
 */
export async function syncRepo(repoConfig, opts) {
  const { dir } = await addRepoToWorkspace(repoConfig, opts);
  const comp = repoComponent(dir, repoConfig.name);

  const existing = opts.store.list().find((c) => c.repo === repoConfig.name);
  if (existing) {
    opts.store.update(existing.id, { name: comp.name, type: comp.type, format: comp.format, path: comp.path });
    return { repo: repoConfig.name, dir, added: 0, updated: 1, component: comp };
  }
  opts.store.add(comp);
  return { repo: repoConfig.name, dir, added: 1, updated: 0, component: comp };
}
