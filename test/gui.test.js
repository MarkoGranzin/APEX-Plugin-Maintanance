import { describe, it, expect } from 'vitest';
import { triageViewModel, correctFormat, needsDecision, artifactCard } from '../src/gui/triage.js';

describe('T-24 Triage & Steckbrief', () => {
  const arts = [
    { name: 'a', format: 'export', testPath: 'APEX-Instanz', noConvention: false },
    { name: 'b', format: 'source', testPath: 'utPLSQL+JS', noConvention: false },
    { name: 'c1', format: 'unclear', testPath: null },
    { name: 'c2', format: 'unclear', testPath: null },
    { name: 'c3', format: 'unclear', testPath: null },
    { name: 'd', format: 'source', testPath: 'utPLSQL+JS', noConvention: true },
  ];

  it('Triage-Liste zeigt unklare Artefakte oben', () => {
    const many = [...arts, ...Array.from({ length: 8 }, (_, i) => ({ name: 'x' + i, format: 'source', testPath: 't' }))];
    const vm = triageViewModel(many);
    expect(vm.triageList.map((c) => c.name)).toEqual(['c1', 'c2', 'c3']);
    // im kombinierten Kartenstrom stehen die unklaren vorne
    expect(vm.cards.slice(0, 3).every((c) => c.needsDecision)).toBe(true);
  });

  it('KI-Vorschlag mit einem Klick korrigieren → Test-Pfad neu, verlässt Triage', () => {
    const wrong = { name: 'card', format: 'source', testPath: 'utPLSQL+JS' };
    expect(needsDecision(wrong)).toBe(false);
    const fixed = correctFormat({ name: 'card', format: 'unclear', testPath: null }, 'export');
    expect(fixed.format).toBe('export');
    expect(fixed.testPath).toMatch(/APEX-Instanz/);
    expect(needsDecision(fixed)).toBe(false); // raus aus der Triage-Liste
  });

  it('Inkonsistenz-Kennzahl ist ruhig (kein Rot), Rot nur für Risiko', () => {
    const risks = [{ name: 'oldlib', label: '🟠 unmaintained' }];
    const vm = triageViewModel(arts, risks);
    expect(vm.inconsistency.tone).toBe('calm');
    expect(vm.inconsistency.noConvention).toBe(1);
    expect(vm.inconsistency.text).toContain('ohne Konvention');
    expect(vm.red).toEqual([{ name: 'oldlib', label: '🟠 unmaintained' }]); // nur Risiko ist rot
  });

  it('Steckbrief trägt Format-Badge, Test-Pfad und Reife', () => {
    const card = artifactCard({ name: 'a', format: 'export', testPath: 'APEX-Instanz', maturity: 'getestet·0 instabil' });
    expect(card).toMatchObject({ formatBadge: 'APEX-SQL-Export', testPath: 'APEX-Instanz', maturity: 'getestet·0 instabil' });
  });
});
