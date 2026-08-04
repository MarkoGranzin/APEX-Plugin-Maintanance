import { describe, it, expect } from 'vitest';
import { dualReviewRework } from '../src/service/review-loop.js';

describe('T-115 Doppel-Review + Rework-Schleife', () => {
  it('beide Agenten + Scan grün in Runde 1 → pass, kein Rework', async () => {
    let fixes = 0;
    const r = await dualReviewRework({}, {
      securityScan: async () => ({ ok: true }),
      securityReview: async () => ({ ok: true }),
      codeReview: async () => ({ ok: true }),
      fix: async () => { fixes++; },
    });
    expect(r.pass).toBe(true);
    expect(r.rounds).toBe(1);
    expect(fixes).toBe(0);
  });

  it('ein Agent rot → Rework → danach grün → pass in Runde 2', async () => {
    let codeCalls = 0; let fixes = 0;
    const r = await dualReviewRework({}, {
      securityReview: async () => ({ ok: true }),
      codeReview: async () => { codeCalls++; return { ok: codeCalls > 1 }; }, // erst rot, nach Fix grün
      fix: async () => { fixes++; },
      maxRounds: 3,
    });
    expect(r.pass).toBe(true);
    expect(r.rounds).toBe(2);
    expect(fixes).toBe(1); // genau ein Rework
  });

  it('Security-Scan rot blockt, auch wenn beide Reviews grün sind', async () => {
    const r = await dualReviewRework({}, {
      securityScan: async () => ({ ok: false, issues: ['CVE-2024-x'] }),
      securityReview: async () => ({ ok: true }),
      codeReview: async () => ({ ok: true }),
      maxRounds: 1,
    });
    expect(r.pass).toBe(false);
    expect(r.votes.scan.ok).toBe(false);
  });

  it('bleibt rot bis zum Limit → pass:false (Aufrufer rollt zurück)', async () => {
    let fixes = 0;
    const r = await dualReviewRework({}, {
      securityReview: async () => ({ ok: true }),
      codeReview: async () => ({ ok: false, issues: ['lose Enden'] }),
      fix: async () => { fixes++; },
      maxRounds: 2,
    });
    expect(r.pass).toBe(false);
    expect(r.rounds).toBe(2);
    expect(fixes).toBe(1); // nur zwischen den Runden ein Fix (nach der letzten Runde keiner mehr)
  });

  it('zwei UNABHÄNGIGE Voten werden beide eingeholt', async () => {
    const seen = [];
    await dualReviewRework({}, {
      securityReview: async () => { seen.push('sec'); return { ok: true }; },
      codeReview: async () => { seen.push('code'); return { ok: true }; },
    });
    expect(seen).toEqual(['sec', 'code']);
  });

  it('fehlende Agenten → klarer Fehler', async () => {
    const r = await dualReviewRework({}, { securityReview: async () => ({ ok: true }) });
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/review agents/i);
  });
});
