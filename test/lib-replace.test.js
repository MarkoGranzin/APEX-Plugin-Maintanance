import { describe, it, expect } from 'vitest';
import { REPLACEMENTS, suggestReplacement, planReplacements } from '../src/service/lib-replace.js';

describe('Unmaintained → permissiver Ersatz', () => {
  it('schlägt gepflegten Nachfolger nur bei kommerziell-OK-Lizenz vor', () => {
    const moment = suggestReplacement('moment');
    expect(moment.to).toBe('dayjs');
    expect(moment.license).toBe('MIT');
    expect(moment.licenseInfo.commercialOk).toBe(true);
    expect(moment.attribution).toBe(false); // MIT → keine Pflichten
    expect(moment.cdn).toMatch(/dayjs/);
  });

  it('Apache-Nachfolger ist erlaubt, aber als attribution markiert', () => {
    const mx = suggestReplacement('mxgraph');
    expect(mx.to).toBe('@maxgraph/core');
    expect(mx.licenseInfo.commercialOk).toBe(true);
    expect(mx.attribution).toBe(true); // Apache-2.0 → Attributionspflicht, aber kein Copyleft
  });

  it('case-insensitiv + unbekannte Lib → null', () => {
    expect(suggestReplacement('MXGRAPH').to).toBe('@maxgraph/core');
    expect(suggestReplacement('irgendwas-fremdes')).toBeNull();
    expect(suggestReplacement('')).toBeNull();
  });

  it('LEITPLANKE: ein Nachfolger mit Copyleft-Lizenz wird NICHT vorgeschlagen', () => {
    // klassifiziert "GPL-3.0" als copyleft → suggestReplacement muss null liefern
    const got = suggestReplacement('moment', { classify: () => ({ commercialOk: false, obligations: 'copyleft' }) });
    expect(got).toBeNull();
  });

  it('alle Registry-Einträge sind kommerziell nutzbar (kein Copyleft)', () => {
    for (const name of Object.keys(REPLACEMENTS)) {
      const r = suggestReplacement(name);
      expect(r, `${name} sollte vorschlagbar sein`).not.toBeNull();
      expect(r.licenseInfo.obligations).not.toBe('copyleft');
    }
  });

  it('planReplacements: unmaintained → replace; ohne Nachfolger → self-build; gepflegte ignoriert', () => {
    const plan = planReplacements([
      { name: 'moment', version: '2.29.0', unmaintained: true },
      { name: 'angularjs', version: '1.8.0', status: 'nicht gepflegt' }, // kein Nachfolger in Registry
      { name: 'three', version: '0.116.0' }, // gepflegt → ignoriert
    ]);
    expect(plan).toHaveLength(2);
    const moment = plan.find((p) => p.from === 'moment');
    expect(moment.strategy).toBe('replace');
    expect(moment.to).toBe('dayjs');
    const ng = plan.find((p) => p.from === 'angularjs');
    expect(ng.strategy).toBe('self-build');
    expect(ng.to).toBeNull();
  });
});
