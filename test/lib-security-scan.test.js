import { describe, it, expect } from 'vitest';
import { securityScanLib } from '../src/service/lib-security-scan.js';

describe('T-123 dedizierte Sicherheitsbewertung je Lib', () => {
  it('veraltet OHNE bekanntes Advisory → code-only (nur Code, kein Risiko)', () => {
    const s = securityScanLib({ name: 'lz-string', version: '1.0.2', latest: '1.5.0', status: 'veraltet' });
    expect(s.scanned).toBe(true);
    expect(s.verdict).toBe('code-only');
    expect(s.securityRisk).toBe(false);
    expect(s.fixAvailable).toBe(true);
  });

  it('veraltet MIT Advisory in DB → security-risk + Fix verfügbar', () => {
    const db = { 'lz-string': [{ below: '1.4.0', id: 'CVE-TEST-1', severity: 'high' }] };
    const s = securityScanLib({ name: 'lz-string', version: '1.0.2', status: 'veraltet' }, { vulnDb: db });
    expect(s.verdict).toBe('security-risk');
    expect(s.securityRisk).toBe(true);
    expect(s.fixAvailable).toBe(true); // fixedFrom vorhanden
    expect(s.advisory).toBe('CVE-TEST-1');
  });

  it('Advisory OHNE fixedFrom → security-risk, KEIN Fix', () => {
    const s = securityScanLib({ name: 'oldlib', version: '1.0.0', status: 'verwundbar', vuln: 'CVE-X', severity: 'critical' });
    expect(s.verdict).toBe('security-risk');
    expect(s.fixAvailable).toBe(false);
    expect(s.severity).toBe('critical');
  });

  it('nicht gepflegt/EOL → security-risk (keine Fixes mehr)', () => {
    const s = securityScanLib({ name: 'mxgraph', version: '4.2.2', status: 'nicht gepflegt' });
    expect(s.verdict).toBe('security-risk');
    expect(s.securityRisk).toBe(true);
    expect(s.fixAvailable).toBe(false);
    expect(s.reason).toMatch(/EOL|nicht gepflegt/i);
  });

  it('unbekannte Version → unknown (nicht bewertbar)', () => {
    const s = securityScanLib({ name: 'x', version: 'unbekannt', status: 'unbekannt' });
    expect(s.scanned).toBe(false);
    expect(s.verdict).toBe('unknown');
  });

  it('Advisory-Quelle injizierbar (kein Netz)', () => {
    const lookup = (name) => name === 'foo' ? { vuln: 'GHSA-foo', severity: 'medium', fixedFrom: '2.0.0' } : null;
    const s = securityScanLib({ name: 'foo', version: '1.0.0', status: 'veraltet' }, { vulnerabilityFor: lookup });
    expect(s.advisory).toBe('GHSA-foo');
    expect(s.severity).toBe('medium');
  });
});
