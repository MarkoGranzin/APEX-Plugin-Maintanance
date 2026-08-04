import { describe, it, expect } from 'vitest';
import { dualReviewFix } from '../src/service/dual-review-fix.js';

// evalGate/applyFix injiziert → kein echtes Repo/KI nötig.
function gateState(sequence) {
  // sequence: Array von {security:boolean, quality:boolean} je Auswertung
  let i = 0;
  return () => {
    const s = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { assets: [], gate: {
      security: { pass: s.security, blocking: s.security ? [] : [{ rule: 'xss', message: 'unsafe html', asset: 'a.js' }] },
      quality: { pass: s.quality, blocking: s.quality ? [] : [{ rule: 'complexity', message: 'too complex', asset: 'a.js' }] },
    } };
  };
}

describe('T-119/2 dualReviewFix (Doppel-Review + Rework als reviewFix)', () => {
  it('beide Dimensionen grün → pass ohne Fix', async () => {
    let fixes = 0;
    const r = await dualReviewFix({ addReview() {} }, { id: '1', path: 'x' }, {
      evalGate: gateState([{ security: true, quality: true }]),
      applyFix: async () => { fixes++; return true; },
    });
    expect(r.pass).toBe(true);
    expect(fixes).toBe(0);
  });

  it('Code-Dimension erst rot → Fix → grün (2 unabhängige Voten, Rework greift)', async () => {
    let fixes = 0;
    const r = await dualReviewFix({ addReview() {} }, { id: '1', path: 'x' }, {
      evalGate: gateState([{ security: true, quality: false }, { security: true, quality: true }]),
      applyFix: async () => { fixes++; return true; },
      limit: 3,
    });
    expect(r.pass).toBe(true);
    expect(fixes).toBe(1);
  });

  it('bleibt rot bis Limit → pass:false (Rollback-Signal an den Aufrufer)', async () => {
    const r = await dualReviewFix({ addReview() {} }, { id: '1', path: 'x' }, {
      evalGate: gateState([{ security: false, quality: true }]),
      applyFix: async () => true,
      limit: 2,
    });
    expect(r.pass).toBe(false);
    expect(r.votes.security.ok).toBe(false);
  });

  it('Security-Scan rot blockt trotz grüner Reviews', async () => {
    const r = await dualReviewFix({ addReview() {} }, { id: '1', path: 'x' }, {
      evalGate: gateState([{ security: true, quality: true }]),
      securityScan: async () => ({ ok: false, issues: ['CVE-x'] }),
      applyFix: async () => true,
      limit: 1,
    });
    expect(r.pass).toBe(false);
  });
});
