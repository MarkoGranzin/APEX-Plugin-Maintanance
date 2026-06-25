/**
 * T-3 — Diff seit letztem Lauf je Artefakt bestimmen.
 *
 * Der zuletzt verarbeitete Commit wird je Repo gespeichert (Repo.lastProcessedCommit, T-1).
 * Bei einem Lauf wird der neue Stand (nach fetch/clone, T-1) mit dem alten verglichen und die
 * Liste der geänderten Artefakte als Trigger für Testpflege/Update (E-2/E-3) geliefert.
 * Erster Lauf (kein lastProcessedCommit) → alle Artefakte sind Trigger (Baseline).
 *
 * Resultat: src/diff/diff.js
 */

import { simpleGit } from 'simple-git';

function gitFor(repoDir, opts = {}) {
  return opts.gitFactory ? opts.gitFactory(repoDir) : simpleGit({ baseDir: repoDir });
}

/** Aktueller HEAD-Commit-Hash. */
export async function currentHead(repoDir, opts = {}) {
  const git = gitFor(repoDir, opts);
  return (await git.revparse(['HEAD'])).trim();
}

/**
 * Geänderte Dateien seit lastCommit (relativ, posix). Ohne lastCommit → alle versionierten Dateien.
 * @returns {Promise<string[]>}
 */
export async function changedFilesSince(repoDir, lastCommit, opts = {}) {
  const git = gitFor(repoDir, opts);
  if (!lastCommit) {
    const out = await git.raw(['ls-files']);
    return splitLines(out);
  }
  const out = await git.diff(['--name-only', `${lastCommit}..HEAD`]);
  return splitLines(out);
}

/**
 * Bildet die Trigger-Liste: Artefakte, von denen mindestens eine Datei geändert wurde.
 * @param {import('../inventory/inventory.js').Artifact[]} artifacts
 * @param {string[]} changedFiles
 * @returns {{artifact:import('../inventory/inventory.js').Artifact, changedFiles:string[]}[]}
 */
export function changedArtifacts(artifacts, changedFiles) {
  const changed = new Set(changedFiles.map((f) => f.split('\\').join('/')));
  const triggers = [];
  for (const a of artifacts) {
    const hits = (a.files ?? []).filter((f) => changed.has(f));
    if (hits.length > 0) triggers.push({ artifact: a, changedFiles: hits });
  }
  return triggers;
}

/**
 * Vollständiger Diff-Schritt: HEAD bestimmen, geänderte Artefakte ermitteln, neuen Stand zum Merken liefern.
 * Persistiert NICHT selbst — der Aufrufer setzt repo.lastProcessedCommit erst NACH erfolgreichem Lauf.
 * @returns {Promise<{head:string, triggers:object[], baseline:boolean}>}
 */
export async function diffStep(repoDir, repo, artifacts, opts = {}) {
  const head = await currentHead(repoDir, opts);
  const last = repo?.lastProcessedCommit ?? null;
  const files = await changedFilesSince(repoDir, last, opts);
  return {
    head,
    baseline: !last,
    triggers: changedArtifacts(artifacts, files),
  };
}

function splitLines(out) {
  return String(out)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
