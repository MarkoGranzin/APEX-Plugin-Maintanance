import { describe, it, expect } from 'vitest';
import { classifyLicense, licenseWarningFrom, licenseChange } from '../src/sbom/licenses.js';
import { licenseAtVersion } from '../src/sbom/registry.js';

describe('F-23 T-95 Lizenz-Bewertung', () => {
  it('permissiv & pflichtenarm → ok', () => {
    for (const id of ['MIT', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0']) {
      const c = classifyLicense(id);
      expect(c.level).toBe('clean');
      expect(c.ok).toBe(true);
      expect(c.commercialOk).toBe(true);
      expect(c.obligations).toBe('none');
    }
  });

  it('Apache-2.0 / BSD → kommerziell ok, aber Attributionspflicht', () => {
    for (const id of ['Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause']) {
      const c = classifyLicense(id);
      expect(c.level).toBe('attribution');
      expect(c.commercialOk).toBe(true);
      expect(c.obligations).toBe('attribution');
      expect(c.ok).toBe(false); // hat eine Pflicht → nicht „pflichtenfrei"
    }
  });

  it('Copyleft → Warnung, kommerziell heikel', () => {
    for (const id of ['GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'MPL-2.0']) {
      const c = classifyLicense(id);
      expect(c.level).toBe('warn');
      expect(c.commercialOk).toBe(false);
      expect(c.obligations).toBe('copyleft');
    }
  });

  it('unbekannt/leer → Warnung (nicht still ok)', () => {
    expect(classifyLicense('').level).toBe('warn');
    expect(classifyLicense('SEHR-EIGEN').obligations).toBe('unknown');
    expect(classifyLicense(undefined).ok).toBe(false);
  });

  it('OR-Ausdruck nimmt die sauberste Variante', () => {
    expect(classifyLicense('(MIT OR Apache-2.0)').level).toBe('clean');
    expect(classifyLicense('(GPL-3.0 OR MIT)').level).toBe('clean');
  });

  it('akzeptiert npm-Lizenz-Objekt', () => {
    expect(classifyLicense({ type: 'MIT' }).ok).toBe(true);
  });

  it('licenseWarningFrom zaehlt copyleft/unknown/attribution', () => {
    const libs = [{ license: 'MIT' }, { license: 'Apache-2.0' }, { license: 'GPL-3.0' }, { license: '' }];
    expect(licenseWarningFrom(libs)).toEqual({ copyleft: 1, unknown: 1, attribution: 1 });
    expect(licenseWarningFrom([{ license: 'MIT' }])).toBeNull();
  });
});

describe('T-156 Lizenzwechsel installiert→neu', () => {
  it('gleiche Lizenz → null', () => {
    expect(licenseChange('MIT', 'MIT')).toBeNull();
  });
  it('MIT → GPL-3.0 → riskier (permissive → copyleft)', () => {
    const c = licenseChange('MIT', 'GPL-3.0');
    expect(c).toMatchObject({ from: 'MIT', to: 'GPL-3.0', riskier: true });
    expect(c.toClass).toBe('copyleft');
  });
  it('MIT → Apache-2.0 → geändert + riskier (permissive → attribution)', () => {
    const c = licenseChange('MIT', 'Apache-2.0');
    expect(c.riskier).toBe(true); // Pflichten kommen dazu (Attribution)
  });
  it('GPL-3.0 → MIT → geändert, NICHT riskier (Klasse wird besser)', () => {
    const c = licenseChange('GPL-3.0', 'MIT');
    expect(c).toMatchObject({ from: 'GPL-3.0', to: 'MIT', riskier: false });
  });
  it('MIT → ISC → geändert (SPDX), nicht riskier (beide permissive)', () => {
    const c = licenseChange('MIT', 'ISC');
    expect(c).toMatchObject({ riskier: false });
  });
  it('licenseAtVersion liest die Lizenz einer konkreten Version', () => {
    const doc = { 'dist-tags': { latest: '2.0.0' }, license: 'GPL-3.0', versions: { '1.0.0': { license: 'MIT' }, '2.0.0': { license: { type: 'GPL-3.0' } } } };
    expect(licenseAtVersion(doc, '1.0.0')).toBe('MIT');
    expect(licenseAtVersion(doc, '2.0.0')).toBe('GPL-3.0'); // Objektform → String
  });
});
