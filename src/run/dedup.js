/**
 * T-26 — Lauf-Idempotenz & Offen-PR-Dedup: pro Artefakt/Lib höchstens ein offener Update-PR.
 *
 * Ein wöchentlicher Dienst darf ungemergte Aktualisierungen nicht jede Woche neu als PR
 * vorschlagen. Stabiler Branch-Name als Idempotenz-Schlüssel; offene PRs werden erkannt
 * (kein zweiter), abgelehnte gemerkt (Quittung), gemergte als erledigt. Crash/Neustart
 * nach dem Push erzeugt über den Schlüssel keinen Doppel-Push (knüpft an T-15).
 *
 * Resultat: src/run/dedup.js
 */

export const PR_STATE = Object.freeze({ OPEN: 'open', MERGED: 'merged', REJECTED: 'rejected' });

/** Stabiler Idempotenz-Schlüssel/Branch-Name für (Artefakt + Lib + Zielversion). */
export function branchKey(artifact, lib, targetVersion) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
  return `aisp/update/${slug(artifact)}/${slug(lib)}-${slug(targetVersion)}`;
}

export function createPrRegistry(initial = {}) {
  return { prs: { ...initial } }; // key -> {state, prRef?}
}

export function recordPr(registry, key, state, prRef) {
  registry.prs[key] = { state, prRef: prRef ?? registry.prs[key]?.prRef ?? null };
  return registry;
}

/**
 * Entscheidet, ob für einen Schlüssel ein neuer PR erzeugt werden soll.
 * @returns {{action:'create'|'skip', reason:string, existing?:object}}
 */
export function decidePr(registry, key) {
  const pr = registry.prs[key];
  if (!pr) return { action: 'create', reason: 'no existing PR' };
  switch (pr.state) {
    case PR_STATE.OPEN:
      return { action: 'skip', reason: 'open PR exists — update/skip', existing: pr };
    case PR_STATE.MERGED:
      return { action: 'skip', reason: 'already done (merged)', existing: pr };
    case PR_STATE.REJECTED:
      return { action: 'skip', reason: 'rejected — acknowledged, do not offer again', existing: pr };
    default:
      return { action: 'create', reason: 'unknown state' };
  }
}

/**
 * Idempotenter Push: erzeugt nur dann via push(), wenn decidePr 'create' sagt.
 * Schützt gegen Crash-Doppel-Push (vorhandener offener PR über Schlüssel erkannt).
 * @returns {Promise<{pushed:boolean, key:string, reason:string, prRef?:any}>}
 */
export async function idempotentPush(registry, { artifact, lib, targetVersion }, push) {
  const key = branchKey(artifact, lib, targetVersion);
  const decision = decidePr(registry, key);
  if (decision.action === 'skip') {
    return { pushed: false, key, reason: decision.reason, prRef: decision.existing?.prRef };
  }
  const prRef = await push({ artifact, lib, targetVersion, branch: key });
  recordPr(registry, key, PR_STATE.OPEN, prRef);
  return { pushed: true, key, reason: 'new PR created', prRef };
}
