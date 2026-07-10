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
 * Baut aus einer Remote-URL + Token eine authentifizierte HTTPS-Push-URL.
 * GitHub akzeptiert `x-access-token:<PAT>` (classic UND fine-grained); für andere Hoster `oauth2:<token>`.
 * @returns {string|null} authentifizierte URL oder null (kein Token / keine brauchbare https-URL)
 */
export function authenticatedPushUrl(remoteUrl, token) {
  if (!token || !remoteUrl) return null;
  const web = repoWebUrl(remoteUrl); // normalisiert git@/ssh/git:// → https://host/owner/repo (ohne .git)
  if (!web) return null;
  const m = web.match(/^https:\/\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  const host = m[1];
  const repoPath = m[2].replace(/\/$/, '');
  const user = /github\.com/i.test(host) ? 'x-access-token' : 'oauth2';
  return `https://${user}:${encodeURIComponent(token)}@${host}/${repoPath}.git`;
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
