/**
 * T-76 — PR/Review-Link aus Repo-Quelle + Branch bauen.
 *
 * Aus der Repo-URL (https oder git@) und einem Branch eine „Pull Request öffnen"-URL erzeugen.
 * GitHub: .../compare/<branch>?expand=1 (Basis = Default-Branch automatisch). Für unbekannte Hoster
 * wird die normalisierte Repo-URL zurückgegeben (besser als nichts). Rein funktional → testbar.
 *
 * Resultat: src/run/pr-url.js
 */

/** Normalisiert eine git-Quelle auf https://host/owner/repo (ohne .git). */
export function repoWebUrl(source) {
  if (!source || typeof source !== 'string') return null;
  let s = source.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  if (!/^https?:\/\//i.test(s)) return null;
  return s.replace(/\/$/, '');
}

/** Baut einen „PR öffnen"-Link (GitHub compare) für den Branch; sonst die Repo-URL. */
export function prUrlFor(source, branch) {
  const web = repoWebUrl(source);
  if (!web) return null;
  if (!branch) return web;
  if (/github\.com/i.test(web)) return `${web}/compare/${encodeURIComponent(branch)}?expand=1`;
  if (/gitlab\./i.test(web)) return `${web}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
  if (/bitbucket\.org/i.test(web)) return `${web}/pull-requests/new?source=${encodeURIComponent(branch)}`;
  return web;
}
