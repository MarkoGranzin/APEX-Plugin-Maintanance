import { describe, it, expect } from 'vitest';
import { analyzeDeep } from '../src/test/analyze-deep.js';
import { buildDeepTestPlan, combineDeepPlans } from '../src/ai/testplan-deep.js';

describe('T-63 Umfassender Testplan', () => {
  const deep = analyzeDeep('function calc(a, b){ if(a > b){ return a; } else { return b; } }');

  it('Positiv- und Negativtests je Parameter', () => {
    const { feature } = buildDeepTestPlan('Calc', deep);
    expect(feature).toMatch(/calc mit gültigen Eingaben \(Positiv\)/);
    expect(feature).toMatch(/ungültiger Parameter <param> \(Negativ\)/);
    // je Parameter die Negativformen
    expect(feature).toContain('| a | null |');
    expect(feature).toContain('| b | falscher Typ |');
  });

  it('Branch-Abdeckung wahr/falsch', () => {
    const { feature } = buildDeepTestPlan('Calc', deep);
    expect(feature).toMatch(/Pfadabdeckung Verzweigung <nr>/);
    expect(feature).toContain('| 1 | wahr |');
    expect(feature).toContain('| 1 | falsch |');
  });

  it('Coverage-Kennzahl nennt Funktionen/Branches/Parameter', () => {
    const { coverage } = buildDeepTestPlan('Calc', deep);
    expect(coverage.functionsCovered).toBeGreaterThanOrEqual(1);
    expect(coverage.branchesCovered).toBeGreaterThanOrEqual(1);
    expect(coverage.paramsCovered).toBe(2);
    expect(coverage.scenarios).toBeGreaterThan(5);
  });

  it('deutlich mehr Szenarien als der alte Flach-Plan', () => {
    const { scenarioCount } = buildDeepTestPlan('Calc', deep);
    expect(scenarioCount).toBeGreaterThan(8);
  });

  it('combineDeepPlans summiert Coverage', () => {
    const p1 = buildDeepTestPlan('A', deep);
    const p2 = buildDeepTestPlan('B', deep);
    const { coverage } = combineDeepPlans([p1, p2]);
    expect(coverage.functionsCovered).toBe(p1.coverage.functionsCovered + p2.coverage.functionsCovered);
  });
});
