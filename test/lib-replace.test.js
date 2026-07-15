import { describe, it, expect } from 'vitest';
import { REPLACEMENTS, suggestReplacement, planReplacements, replaceConsentGate } from '../src/service/lib-replace.js';

describe('Unmaintained → permissiver Ersatz', () => {
  it('T-164: pflichtenfreier, gleichwertiger Nachfolger → Adapter-Vorschlag', () => {
    const moment = suggestReplacement('moment');
    expect(moment.to).toBe('dayjs');
    expect(moment.license).toBe('MIT');
    expect(moment.licenseInfo.commercialOk).toBe(true);
    expect(moment.attribution).toBe(false); // MIT → keine Pflichten
    expect(moment.approach).toBe('adapter'); // nur der Adapter wird geschrieben
    expect(moment.cdn).toMatch(/dayjs/);
  });

  it('T-164: Attribution ist eine PFLICHT → Apache-Nachfolger ist KEINE zulässige Alternative (kein Adapter-Pfad)', () => {
    // Regel: Alternative nur wenn kommerziell frei UND pflichtenfrei UND gleichwertig.
    expect(suggestReplacement('mxgraph')).toBeNull();   // @maxgraph/core ist Apache-2.0 (Attributionspflicht)
    expect(suggestReplacement('protractor')).toBeNull(); // playwright ist Apache-2.0
  });

  it('case-insensitiv + unbekannte Lib → null', () => {
    expect(suggestReplacement('MOMENT').to).toBe('dayjs');
    expect(suggestReplacement('irgendwas-fremdes')).toBeNull();
    expect(suggestReplacement('')).toBeNull();
  });

  it('LEITPLANKE: ein Nachfolger mit Copyleft-Lizenz wird NICHT vorgeschlagen', () => {
    // klassifiziert "GPL-3.0" als copyleft → suggestReplacement muss null liefern
    const got = suggestReplacement('moment', { classify: () => ({ commercialOk: false, obligations: 'copyleft' }) });
    expect(got).toBeNull();
  });

  it('T-164: NUR pflichtenfreie + gleichwertige Registry-Einträge sind vorschlagbar', () => {
    for (const name of Object.keys(REPLACEMENTS)) {
      const r = suggestReplacement(name);
      if (r) {
        expect(r.licenseInfo.obligations, `${name}: Adapter-Pfad nur pflichtenfrei`).toBe('none');
        expect(REPLACEMENTS[name].equivalent, `${name}: Adapter-Pfad nur bei Gleichwertigkeit`).toBe(true);
      }
    }
    // Stichproben: MIT+equivalent vorschlagbar, Apache (Pflicht) nicht
    expect(suggestReplacement('jsonpath')).not.toBeNull();
    expect(suggestReplacement('mxclient')).toBeNull();
  });

  it('planReplacements: pflichtenfrei → Adapter; Pflichten-Nachfolger/kein Nachfolger → Interface-Neubau', () => {
    const plan = planReplacements([
      { name: 'moment', version: '2.29.0', unmaintained: true },
      { name: 'mxgraph', version: '3.9.12', status: 'nicht gepflegt' }, // Nachfolger existiert, aber Apache → Pflicht
      { name: 'angularjs', version: '1.8.0', status: 'nicht gepflegt' }, // kein Nachfolger in Registry
      { name: 'three', version: '0.116.0' }, // gepflegt → ignoriert
    ]);
    expect(plan).toHaveLength(3);
    const moment = plan.find((p) => p.from === 'moment');
    expect(moment.strategy).toBe('replace');
    expect(moment.approach).toBe('adapter');
    expect(moment.to).toBe('dayjs');
    const mx = plan.find((p) => p.from === 'mxgraph');
    expect(mx.strategy).toBe('self-build');
    expect(mx.approach).toBe('rewrite');
    expect(mx.to).toBeNull();
    expect(mx.rejected).toMatchObject({ to: '@maxgraph/core', license: 'Apache-2.0' }); // ehrlich benannt, warum kein Adapter
    const ng = plan.find((p) => p.from === 'angularjs');
    expect(ng.strategy).toBe('self-build');
    expect(ng.rejected).toBeNull();
  });
});

describe('T-163 replaceConsentGate — Extra-Zustimmung fürs Ersetzen/Nachbauen unmaintained Libs', () => {
  const steps = [
    { step: 'migrate', name: 'jquery', from: '1.12.4', to: '3.7.1', skipped: true }, // Major-Update, KEIN replace
    { step: 'migrate', name: 'mxgraph', to: '@maxgraph/core', replace: true, strategy: 'replace', skipped: true },
    { step: 'migrate', name: 'deadlib', to: null, replace: true, skipped: true }, // kein Nachfolger → self-build
    { step: 'lib-update', name: 'font-awesome' }, // kein migrate → irrelevant
  ];

  it('ohne Zustimmung → needsConsent + Vorschläge NUR für replace-Schritte (Major-Only bleibt außen vor)', () => {
    const g = replaceConsentGate(steps, { consent: false });
    expect(g.needsConsent).toBe(true);
    expect(g.proposals.map((p) => p.lib).sort()).toEqual(['deadlib', 'mxgraph']);
    expect(g.proposals.find((p) => p.lib === 'mxgraph')).toMatchObject({ strategy: 'replace', to: '@maxgraph/core', interfacePreserving: true });
    expect(g.proposals.find((p) => p.lib === 'deadlib')).toMatchObject({ strategy: 'self-build', to: null });
  });

  it('mit Zustimmung → kein Tor (needsConsent false), Vorschläge trotzdem gelistet', () => {
    const g = replaceConsentGate(steps, { consent: true });
    expect(g.needsConsent).toBe(false);
    expect(g.proposals).toHaveLength(2);
  });

  it('nur sichere Updates / keine replace-Schritte → nie Zustimmung nötig', () => {
    expect(replaceConsentGate([{ step: 'migrate', name: 'jquery', to: '3.7.1', skipped: true }], { consent: false }).needsConsent).toBe(false);
    expect(replaceConsentGate([], { consent: false }).needsConsent).toBe(false);
  });
});
