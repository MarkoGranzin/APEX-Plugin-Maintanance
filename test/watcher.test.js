import { describe, it, expect } from 'vitest';
import { branchKey, createPrRegistry, recordPr, decidePr, idempotentPush, PR_STATE } from '../src/run/dedup.js';
import { renderReport, sendReport, redact } from '../src/report/mail.js';
import { createHistory, recordRun, listRuns, getRun } from '../src/report/history.js';

describe('T-26 PR-Dedup & Idempotenz', () => {
  it('stabiler Branch-Key je (Artefakt, Lib, Zielversion)', () => {
    expect(branchKey('My Plugin', 'jQuery', '3.7.1')).toBe('aisp/update/my-plugin/jquery-3.7.1');
  });

  it('kein zweiter PR, wenn schon einer offen ist', async () => {
    const reg = createPrRegistry();
    recordPr(reg, branchKey('A', 'X', '2.1'), PR_STATE.OPEN, 'PR-1');
    let pushed = false;
    const res = await idempotentPush(reg, { artifact: 'A', lib: 'X', targetVersion: '2.1' }, () => { pushed = true; return 'PR-2'; });
    expect(res.pushed).toBe(false);
    expect(pushed).toBe(false);
    expect(res.reason).toMatch(/open PR/);
  });

  it('abgelehnter PR wird nicht erneut vorgeschlagen', () => {
    const reg = createPrRegistry();
    recordPr(reg, branchKey('A', 'X', '2.1'), PR_STATE.REJECTED);
    expect(decidePr(reg, branchKey('A', 'X', '2.1')).action).toBe('skip');
  });

  it('Crash nach Push: vorhandener offener PR wird über Schlüssel erkannt → kein Doppel-Push', async () => {
    const reg = createPrRegistry();
    // erster Lauf pusht
    let pushes = 0;
    const push = () => { pushes += 1; return `PR-${pushes}`; };
    await idempotentPush(reg, { artifact: 'A', lib: 'X', targetVersion: '2.1' }, push);
    // "Neustart" mit derselben Registry → kein zweiter Push
    await idempotentPush(reg, { artifact: 'A', lib: 'X', targetVersion: '2.1' }, push);
    expect(pushes).toBe(1);
  });
});

describe('T-9 Report-Mail', () => {
  const run = {
    updated: [
      { artifact: 'cardComp', gitLink: 'https://git/x/pr/1', change: 'jquery 3.4.1→3.7.1', testResult: 'grün' },
      { artifact: 'slider', gitLink: 'https://git/x/pr/2', change: 'chart 2.9.3→2.9.4', testResult: 'grün' },
    ],
  };

  it('Report enthält alle aktualisierten Artefakte mit Git-Link, an alle Empfänger', async () => {
    const report = renderReport(run);
    expect(report.body).toContain('cardComp');
    expect(report.body).toContain('slider');
    expect(report.body).toContain('https://git/x/pr/1');

    const sentTo = [];
    const res = await sendReport(report, {
      recipients: ['a@b.de', 'c@d.com'],
      transport: ({ to }) => { sentTo.push(to); },
    });
    expect(res.sent).toEqual(['a@b.de', 'c@d.com']);
    expect(sentTo).toHaveLength(2);
  });

  it('keine Secrets im Body', () => {
    const report = renderReport(
      { updated: [{ artifact: 'x', gitLink: 'g', change: 'c', testResult: 'grün' }] },
      { secrets: ['ghp_TOKEN123', 'sk-APIKEY'] },
    );
    expect(report.body).not.toContain('ghp_TOKEN123');
    expect(report.body).not.toContain('sk-APIKEY');
    expect(redact('x ghp_TOKEN123 y', ['ghp_TOKEN123'])).toBe('x *** y');
  });

  it('ohne Empfänger wird ein Fehler geworfen', async () => {
    await expect(sendReport(renderReport(run), { recipients: [], transport: () => {} })).rejects.toThrow(/Empfänger/);
  });
});

describe('T-10 Lauf-History', () => {
  it('persistiert Läufe und erlaubt Filter/Detail', () => {
    const h = createHistory();
    recordRun(h, { id: 'run-1', status: 'green', updated: [{ artifact: 'a' }] });
    recordRun(h, { id: 'run-2', status: 'red', failures: [{ artifact: 'b', reason: 'rot' }] });
    expect(h.runs).toHaveLength(2);
    expect(listRuns(h, { status: 'red' }).map((r) => r.id)).toEqual(['run-2']);
    expect(listRuns(h, { artifact: 'a' }).map((r) => r.id)).toEqual(['run-1']);
    expect(getRun(h, 'run-2').failures[0].reason).toBe('rot');
  });

  it('idempotent: derselbe Lauf wird nicht doppelt gespeichert', () => {
    const h = createHistory();
    recordRun(h, { id: 'run-1', status: 'green' });
    recordRun(h, { id: 'run-1', status: 'green' });
    expect(h.runs).toHaveLength(1);
  });
});
