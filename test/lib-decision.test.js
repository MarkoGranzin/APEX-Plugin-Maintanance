import { describe, it, expect } from 'vitest';
import { decideLibAction, decideForLibs } from '../src/service/lib-decision.js';

describe('T-114 Security-Entscheid Update vs. Ersatz', () => {
  it('aktuell → ok', () => {
    expect(decideLibAction({ name: 'three', status: 'aktuell' }).action).toBe('ok');
  });

  it('veraltet mit neuerer Version → update', () => {
    const d = decideLibAction({ name: 'lz-string', version: '1.0.2', latest: '1.5.0', status: 'veraltet' });
    expect(d.action).toBe('update');
    expect(d.severity).toBe('medium');
  });

  it('verwundbar mit verfügbarem Fix → update (priorisiert)', () => {
    const d = decideLibAction({ name: 'jquery', status: 'verwundbar', version: '1.12.4', latest: '4.0.0' }, { cve: { vulnerable: true, fixAvailable: true } });
    expect(d.action).toBe('update');
    expect(d.severity).toBe('critical');
  });

  it('verwundbar OHNE Fix → Ersatz erzwungen', () => {
    const d = decideLibAction({ name: 'oldlib', status: 'verwundbar' }, { cve: { vulnerable: true, fixAvailable: false } });
    expect(d.action).toBe('replace');
    expect(d.mustReplace).toBe(true);
  });

  it('veraltet + CVE ohne Fix → Ersatz (outdated kann zum Muss-Ersatz werden)', () => {
    const d = decideLibAction({ name: 'lz-string', status: 'veraltet', version: '1.0.2', latest: '1.5.0' }, { cve: { vulnerable: true, fixAvailable: false } });
    expect(d.action).toBe('replace');
  });

  it('nicht gepflegt mit sauberem Nachfolger → replace/successor', () => {
    const d = decideLibAction({ name: 'mxgraph', status: 'nicht gepflegt' });
    expect(d.action).toBe('replace');
    expect(d.path).toBe('successor'); // @maxgraph/core (Apache-2.0)
  });

  it('nicht gepflegt OHNE Nachfolger → replace/redevelop (Dead-Lib-Neuentwicklung F-30)', () => {
    const d = decideLibAction({ name: 'irgendein-totes-lib-xyz', status: 'nicht gepflegt' }, { replacement: null });
    expect(d.action).toBe('replace');
    expect(d.path).toBe('redevelop');
  });

  it('unbekannte Version → review', () => {
    expect(decideLibAction({ name: 'x', status: 'unbekannt' }).action).toBe('review');
  });

  it('decideForLibs: Entscheidung je Lib, cveFor injizierbar', () => {
    const libs = [{ name: 'three', status: 'aktuell' }, { name: 'oldlib', status: 'verwundbar' }];
    const out = decideForLibs(libs, { cveFor: (l) => l.name === 'oldlib' ? { vulnerable: true, fixAvailable: false } : null });
    expect(out.find((x) => x.name === 'three').action).toBe('ok');
    expect(out.find((x) => x.name === 'oldlib').action).toBe('replace');
  });
});
