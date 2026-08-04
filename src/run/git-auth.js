/**
 * T-148 — Push-Authentifizierung per Personal Access Token (Alternative zum Git Credential Manager).
 *
 * Ablauf des Fixes bleibt: Auto-Fix/Update schreiben in den Klon → uploadFix legt einen NEUEN Branch an,
 * committet und pusht. Der Push geht an das Remote (origin = der Fork des Nutzers). Zwei Auth-Wege:
 *   1) Git Credential Manager (kein Token nötig — push an `origin` reicht, System liefert Credentials).
 *   2) Personal Access Token (dieses Modul): der Token wird NUR zur Push-Zeit in eine Einmal-URL
 *      eingesetzt (https://x-access-token:<token>@host/owner/repo.git). So landet der Token NIE in
 *      der .git/config des Klons und nie in einem persistenten Remote.
 *
 * Der Token liegt verschlüsselt im SecretStore ('git-token') — hier wird nur die URL gebaut bzw. für
 * Logs/Fehlermeldungen wieder herausredigiert. NIEMALS den Token loggen oder in Klartext zurückgeben.
 *
 * Resultat: src/run/git-auth.js
 */

import { repoWebUrl } from './pr-url.js';

/**
 * Pseudo-Benutzername für die Token-Auth je Git-Hoster (wenn der Nutzer keinen expliziten Namen setzt).
 * Die gängigen Hoster erwarten unterschiedliche „Benutzer" vor dem Token in der HTTPS-URL:
 *   GitHub → x-access-token · GitLab → oauth2 · Bitbucket Cloud → x-token-auth ·
 *   Azure DevOps → pat · sonst (Gitea/Forgejo/Gogs/self-hosted) → der Token selbst als Benutzer.
 * Rein hostbasiert (Substring), damit es auch für self-hosted GitLab/Gitea greift.
 */
export function defaultTokenUser(host, token) {
  const h = String(host || '').toLowerCase();
  if (/github\./.test(h)) return 'x-access-token';
  if (/gitlab\./.test(h)) return 'oauth2';
  if (/bitbucket\./.test(h)) return 'x-token-auth';
  if (/dev\.azure\.com|visualstudio\.com/.test(h)) return 'pat';
  return token; // universeller Fallback: Token als Benutzer (funktioniert bei GitHub, Gitea, vielen self-hosted)
}

/**
 * Baut aus einer Remote-URL + Token eine authentifizierte HTTPS-Push-URL — hoster-unabhängig.
 * Optionaler `user` überschreibt den hostbasierten Default (z.B. Bitbucket-App-Passwörter, Azure).
 * @returns {string|null} authentifizierte URL oder null (kein Token / keine brauchbare https-URL)
 */
export function authenticatedPushUrl(remoteUrl, token, user) {
  if (!token || !remoteUrl) return null;
  const web = repoWebUrl(remoteUrl); // normalisiert git@/ssh/git:// → https://host/pfad (ohne .git)
  if (!web) return null;
  const m = web.match(/^https:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const host = m[1];
  const repoPath = m[2].replace(/\/$/, '');
  const u = (user && String(user).trim()) || defaultTokenUser(host, token);
  return `https://${encodeURIComponent(u)}:${encodeURIComponent(token)}@${host}/${repoPath}.git`;
}

/** Entfernt den Token (roh UND URL-encodiert) aus einem String — für sichere Logs/Fehlertexte. */
export function redactToken(str, token) {
  let s = String(str ?? '');
  if (!token) return s;
  for (const form of [token, encodeURIComponent(token)]) {
    if (form) s = s.split(form).join('***');
  }
  // zusätzlich generisch: „user:<secret>@" nie durchlassen
  return s.replace(/(https:\/\/[^/:@\s]+:)[^@\s]+(@)/gi, '$1***$2');
}
