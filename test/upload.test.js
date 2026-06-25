import { describe, it, expect } from 'vitest';
import { prUrlFor, repoWebUrl } from '../src/run/pr-url.js';
import { uploadFix } from '../src/service/upload.js';
import { renderReport } from '../src/report/mail.js';

describe('T-76 Review-Link in der Report-Mail', () => {
  it('Mail enthält PR/Review-Link, wenn reviewUrl gesetzt', () => {
    const { body } = renderReport({ updated: [{ artifact: 'P', change: 'jquery 1→3', testResult: 'ok', reviewUrl: 'https://github.com/o/r/compare/aisp%2Fx?expand=1' }], risks: [], failures: [] });
    expect(body).toMatch(/Open review\/PR: https:\/\/github\.com\/o\/r\/compare/);
  });
});

describe('T-76 PR-URL', () => {
  it('GitHub compare-Link aus https + git@', () => {
    expect(prUrlFor('https://github.com/o/r', 'aisp/x')).toBe('https://github.com/o/r/compare/aisp%2Fx?expand=1');
    expect(prUrlFor('git@github.com:o/r.git', 'b')).toBe('https://github.com/o/r/compare/b?expand=1');
  });
  it('repoWebUrl normalisiert', () => {
    expect(repoWebUrl('git+https://github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(repoWebUrl('lokal/pfad')).toBe(null);
  });
});

describe('T-76 uploadFix', () => {
  const mkGit = (changes, pushImpl) => {
    const calls = {};
    return { calls, git: {
      status: async () => changes,
      branchCommit: async (b, m) => { calls.branch = b; calls.msg = m; },
      push: pushImpl || (async (b) => { calls.pushed = b; }),
    } };
  };

  it('neuer Branch + Commit + Push + PR-Link bei Änderungen', async () => {
    const { calls, git } = mkGit(['js/widget.js']);
    const r = await uploadFix({ path: '/x', source: 'https://github.com/o/r' }, { git, push: true, stamp: '20260625' });
    expect(r.ok).toBe(true);
    expect(calls.branch).toBe('aisp/pflege-20260625');
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toMatch(/github\.com\/o\/r\/compare\/aisp/);
  });

  it('keine Änderungen → nichts hochladen', async () => {
    const { git } = mkGit([]);
    const r = await uploadFix({ path: '/x', source: 'https://github.com/o/r' }, { git, push: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Keine Änderungen/);
  });

  it('Push-Fehler wird gemeldet, Commit bleibt (pushed=false)', async () => {
    const { git } = mkGit(['a.js'], async () => { throw new Error('auth required'); });
    const r = await uploadFix({ path: '/x', source: 'https://github.com/o/r' }, { git, push: true, stamp: 's' });
    expect(r.ok).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.pushError).toMatch(/auth/);
    expect(r.prUrl).toMatch(/compare/);
  });

  it('ohne push nur lokaler Commit', async () => {
    const { calls, git } = mkGit(['a.js']);
    const r = await uploadFix({ path: '/x', source: 'https://github.com/o/r' }, { git, push: false, stamp: 's' });
    expect(r.ok).toBe(true);
    expect(r.pushed).toBe(false);
    expect(calls.pushed).toBeUndefined();
  });
});
