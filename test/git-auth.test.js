import { describe, it, expect } from 'vitest';
import { authenticatedPushUrl, redactToken, defaultTokenUser } from '../src/run/git-auth.js';
import { SecretStore } from '../src/config/secrets.js';

describe('T-148 Push-Auth per Personal Access Token', () => {
  const TOK = 'ghp_ABC123secretDEF456';

  it('baut GitHub-Push-URL mit x-access-token (aus https-Remote)', () => {
    const u = authenticatedPushUrl('https://github.com/maras/APEX-Material-BI-Dashboard', TOK);
    expect(u).toBe(`https://x-access-token:${TOK}@github.com/maras/APEX-Material-BI-Dashboard.git`);
  });

  it('normalisiert git@- und .git-Remotes', () => {
    expect(authenticatedPushUrl('git@github.com:maras/repo.git', TOK)).toBe(`https://x-access-token:${TOK}@github.com/maras/repo.git`);
  });

  it('hoster-unabhängig: GitLab/Bitbucket/Azure/self-hosted-Gitea bekommen den passenden Pseudo-User', () => {
    expect(authenticatedPushUrl('https://gitlab.com/g/p', TOK)).toBe(`https://oauth2:${TOK}@gitlab.com/g/p.git`);
    expect(authenticatedPushUrl('https://gitlab.mycorp.internal/g/p', TOK)).toBe(`https://oauth2:${TOK}@gitlab.mycorp.internal/g/p.git`); // self-hosted GitLab
    expect(authenticatedPushUrl('https://bitbucket.org/g/p', TOK)).toBe(`https://x-token-auth:${TOK}@bitbucket.org/g/p.git`);
    expect(authenticatedPushUrl('https://dev.azure.com/org/proj/_git/repo', TOK)).toBe(`https://pat:${TOK}@dev.azure.com/org/proj/_git/repo.git`);
    // unbekannter/self-hosted Hoster (z.B. Gitea) → Token selbst als User
    expect(authenticatedPushUrl('https://git.example.com/g/p', TOK)).toBe(`https://${TOK}:${TOK}@git.example.com/g/p.git`);
  });

  it('expliziter Benutzername überschreibt den Host-Default (Bitbucket-App-Passwort/Azure)', () => {
    expect(authenticatedPushUrl('https://bitbucket.org/g/p', TOK, 'maras')).toBe(`https://maras:${TOK}@bitbucket.org/g/p.git`);
    expect(defaultTokenUser('github.com', TOK)).toBe('x-access-token');
    expect(defaultTokenUser('git.self.host', TOK)).toBe(TOK);
  });

  it('Sonderzeichen im Token werden URL-encodiert', () => {
    const u = authenticatedPushUrl('https://github.com/o/r', 'a/b:c@d');
    expect(u).toContain(encodeURIComponent('a/b:c@d'));
    expect(u).not.toContain('a/b:c@d'); // roh darf nicht drinstehen
  });

  it('kein Token oder unbrauchbare URL → null (Fallback: origin/Credential Manager)', () => {
    expect(authenticatedPushUrl('https://github.com/o/r', '')).toBeNull();
    expect(authenticatedPushUrl('', TOK)).toBeNull();
    expect(authenticatedPushUrl('not-a-url', TOK)).toBeNull();
  });

  it('redactToken entfernt den Token (roh, encodiert und aus user:secret@-URLs)', () => {
    const url = authenticatedPushUrl('https://github.com/o/r', TOK);
    const msg = `fatal: unable to access '${url}': 403`;
    const red = redactToken(msg, TOK);
    expect(red).not.toContain(TOK);
    expect(red).toContain('***');
    // auch encodierte Form eines Sonderzeichen-Tokens
    expect(redactToken('x '+encodeURIComponent('a/b@c'), 'a/b@c')).not.toContain(encodeURIComponent('a/b@c'));
  });
});

describe('T-148 SecretStore: delete/has (Token vergessen)', () => {
  it('has spiegelt gesetzt/gelöscht, delete ist idempotent, get liefert danach null', () => {
    const s = new SecretStore('master-key');
    expect(s.has('git-token')).toBe(false);
    s.set('git-token', 'ghp_x');
    expect(s.has('git-token')).toBe(true);
    expect(s.get('git-token')).toBe('ghp_x');
    s.delete('git-token'); s.delete('git-token'); // idempotent
    expect(s.has('git-token')).toBe(false);
    expect(s.get('git-token')).toBeNull();
  });

  it('toJSON enthält niemals Klartext des Tokens', () => {
    const s = new SecretStore('k'); s.set('git-token', 'ghp_TOPSECRET');
    expect(JSON.stringify(s.toJSON())).not.toContain('ghp_TOPSECRET');
  });
});
