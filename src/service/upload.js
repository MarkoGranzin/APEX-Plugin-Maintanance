/**
 * T-76 — Fix-Upload: Änderungen auf einem NEUEN Branch committen, optional pushen, PR-Link bauen.
 *
 * Lädt nur hoch, wenn es tatsächlich Änderungen gibt. Erstellt einen neuen Branch, committet die
 * Änderung und pusht (nur wenn push=true UND ein Remote/Token vorhanden ist). Liefert den PR/Review-
 * Link (für Mail/GUI). git-Operationen sind injizierbar → deterministisch testbar ohne echtes Remote.
 *
 * Resultat: src/service/upload.js
 */

import { prUrlFor } from '../run/pr-url.js';

/**
 * @param {object} comp  Komponente (path, source)
 * @param {object} [deps] git:{status,branchCommit,push}, push:bool, branch?, message?, stamp?
 */
export async function uploadFix(comp, deps = {}) {
  if (!comp?.path) return { ok: false, reason: 'No repo assigned.' };
  const git = deps.git;
  if (!git) return { ok: false, reason: 'no git available' };

  const changes = await git.status(); // string[] geänderter Dateien
  if (!changes || !changes.length) return { ok: false, reason: 'No changes to upload — run "Fix everything automatically"/"Auto-update" first.' };

  const branch = deps.branch || `aisp/pflege-${deps.stamp || 'run'}`;
  const message = deps.message || 'chore(aisp): automatische Pflege (Lib-Update/Fix)';
  await git.branchCommit(branch, message);

  let pushed = false;
  let pushError = null;
  if (deps.push) {
    try { await git.push(branch); pushed = true; }
    catch (e) { pushError = String(e?.message ?? e); }
  }
  const prUrl = prUrlFor(comp.source, branch);
  return { ok: true, branch, changes: changes.length, pushed, pushError, prUrl };
}
