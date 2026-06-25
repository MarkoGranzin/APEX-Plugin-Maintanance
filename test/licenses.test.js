import { describe, it, expect } from 'vitest';
import { classifyLicense, licenseWarningFrom } from '../src/sbom/licenses.js';

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
