import { describe, it, expect } from 'vitest';
import { acceptanceFromSelfTest, acceptanceToScenarios, acceptanceFeatureFile, normalizeInterface } from '../src/service/acceptance.js';

const stGreen = {
  ran: true, rendered: true, views: 1, total: 1,
  features: [{ view: 'default', feature: 'rendert 12 Knoten', ok: true }],
  problems: [],
};

// Roh-Schnittstelle wie aus mock.pluginInterface ({prompt,type,values,def,help}); JSON-Default bewusst lang.
const JSON_DEFAULT = '{"modes":[{"id":"flow","label":"Flussdiagramm"},{"id":"org","label":"Orgchart"}],"theme":"dark","spacing":24}';
const rawInterface = {
  attributes: [
    { prompt: 'Diagramm-Typ', type: 'STRING', values: ['Flussdiagramm=flow', 'Orgchart=org'], def: 'flow', help: 'Welcher Diagrammtyp gerendert wird' },
    { prompt: 'Konfiguration (JSON)', type: 'TEXTAREA', values: [], def: JSON_DEFAULT, help: 'Vollständige JSON-Konfiguration' },
  ],
};

describe('T-126 Schnittstelle exakt im Akzeptanz-Vertrag/.feature', () => {
  it('normalizeInterface bildet name/type/allowedValues/default/help ab; Default ungekürzt', () => {
    const i = normalizeInterface(rawInterface);
    expect(i.count).toBe(2);
    expect(i.attributes[0]).toMatchObject({ name: 'Diagramm-Typ', type: 'STRING', allowedValues: ['Flussdiagramm=flow', 'Orgchart=org'], default: 'flow' });
    expect(i.attributes[1].default).toBe(JSON_DEFAULT); // vollständig
  });

  it('Vertrag hält die Schnittstelle strukturiert fest (contract.interface)', () => {
    const c = acceptanceFromSelfTest(stGreen, { name: 'ApexFlowChart', interface: rawInterface });
    expect(c.interface.count).toBe(2);
    expect(c.interface.attributes.map((a) => a.name)).toEqual(['Diagramm-Typ', 'Konfiguration (JSON)']);
    expect(c.interface.attributes[1].default).toBe(JSON_DEFAULT);
  });

  it('.feature beschreibt die Schnittstelle exakt (Abschnitt + Parameter + voller JSON-Default + Szenario)', () => {
    const c = acceptanceFromSelfTest(stGreen, { name: 'ApexFlowChart', interface: rawInterface });
    const f = acceptanceFeatureFile(c, { name: 'ApexFlowChart' });
    expect(f).toMatch(/Interface \(APEX plugin parameters/);
    expect(f).toContain('Diagramm-Typ [STRING]');
    expect(f).toContain('Flussdiagramm=flow | Orgchart=org');
    expect(f).toContain(JSON_DEFAULT);                 // JSON-Default ungekürzt in der .feature
    expect(f).toMatch(/interface \(parameters\/configuration\) is preserved exactly/);
  });

  it('acceptanceToScenarios enthält ein devhub-taugliches Schnittstellen-Szenario, das jeden Parameter aufzählt', () => {
    const c = acceptanceFromSelfTest(stGreen, { name: 'ApexFlowChart', interface: rawInterface });
    const scen = acceptanceToScenarios(c, { name: 'ApexFlowChart' });
    const s = scen.find((x) => /interface .* is preserved exactly/.test(x.title));
    expect(s).toBeTruthy();
    expect(s.gherkin).toMatch(/parameter "Diagramm-Typ" \[STRING\]/);
    expect(s.gherkin).toContain(JSON_DEFAULT);
  });

  it('entdoppelt identische Parameter-Deklarationen', () => {
    const dup = { attributes: [
      { prompt: 'ConfigJSON', type: 'JAVASCRIPT', values: [], def: '{"a":1}', help: 'x' },
      { prompt: 'ConfigJSON', type: 'JAVASCRIPT', values: [], def: '{"a":1}', help: 'x' },
    ] };
    expect(normalizeInterface(dup).count).toBe(1);
  });

  it('ohne interface → kein Schnittstellen-Abschnitt (rückwärtskompatibel)', () => {
    const c = acceptanceFromSelfTest(stGreen, { name: 'X' });
    expect(c.interface).toBe(null);
    expect(acceptanceFeatureFile(c, { name: 'X' })).not.toMatch(/Interface \(APEX/);
  });
});
