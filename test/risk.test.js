import { describe, it, expect } from 'vitest';
import {
  riskFor, assessRisks, createAck, acknowledge, activeRisks, acknowledgedList, isSuppressed, LEVEL,
} from '../src/sbom/risk.js';

describe('T-16 Risiko-Score', () => {
  it('archiviertes Repo → unmaintained mit Begründung + Git-Link', () => {
    const r = riskFor({ name: 'oldlib', version: '1.0.0' }, { archived: true, gitLink: 'https://github.com/x/oldlib' });
    expect(r.level).toBe(LEVEL.UNMAINTAINED);
    expect(r.label).toBe('🟠 unmaintained');
    expect(r.reasons).toContain('Repo archiviert');
    expect(r.gitLink).toBe('https://github.com/x/oldlib');
  });

  it('CVE ohne Fix → vulnerable; langes Schweigen → stale', () => {
    expect(riskFor({ name: 'a' }, { cveUnfixed: true }).level).toBe(LEVEL.VULNERABLE);
    expect(riskFor({ name: 'b' }, { lastReleaseMonths: 24 }).level).toBe(LEVEL.STALE);
    expect(riskFor({ name: 'c' }, { lastReleaseMonths: 3 }).level).toBe(LEVEL.NONE);
  });
});

describe('T-16 Risiko blockiert Update-Gate nicht', () => {
  it('Risiko-Eintrag ist informativ (blocksGate=false), getrennt vom Update', () => {
    const risks = assessRisks([{ name: 'oldlib', version: '1.0.0' }], { oldlib: { archived: true } });
    expect(risks).toHaveLength(1);
    expect(risks[0].blocksGate).toBe(false);
    // ein reguläres Update derselben Lib liefe unabhängig (separate Auswertung der SBOM)
  });
});

describe('T-16 Quittierung', () => {
  it('quittierte stale-Warnung erscheint nicht erneut, bleibt aber einsehbar', () => {
    const risks = assessRisks([{ name: 'b', version: '1.0.0' }], { b: { lastReleaseMonths: 24 } });
    const ack = createAck();
    acknowledge(ack, 'b', LEVEL.STALE);
    expect(activeRisks(risks, ack)).toHaveLength(0);
    expect(acknowledgedList(ack)).toContainEqual(expect.objectContaining({ name: 'b', level: LEVEL.STALE }));
  });

  it('Verschärfung 🟡→🔴 hebt Quittierung auf', () => {
    const ack = createAck();
    acknowledge(ack, 'b', LEVEL.STALE);
    expect(isSuppressed(ack, 'b', LEVEL.STALE)).toBe(true);
    expect(isSuppressed(ack, 'b', LEVEL.VULNERABLE)).toBe(false); // wieder aktiv
    const escalated = assessRisks([{ name: 'b', version: '1.0.0' }], { b: { cveUnfixed: true } });
    expect(activeRisks(escalated, ack)).toHaveLength(1);
  });
});
