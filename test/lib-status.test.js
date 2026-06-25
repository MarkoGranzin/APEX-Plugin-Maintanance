import { describe, it, expect } from 'vitest';
import { libStatus } from '../src/service/lib-check.js';
import { collectLibraries } from '../src/service/libraries.js';
import { runComponentOnce } from '../src/service/run-component.js';
import { createComponentStore } from '../src/gui/store.js';

describe('B-3 Lib-Status korrekt & konsistent', () => {
  it('libStatus-Priorität: verwundbar > nicht gepflegt > veraltet > unbekannt > aktuell', () => {
    expect(libStatus({ vulnerable: true, version: '1.0.0' })).toBe('verwundbar');
    expect(libStatus({ unmaintained: true, version: '1.0.0' })).toBe('nicht gepflegt');
    expect(libStatus({ outdated: true, version: '1.0.0' })).toBe('veraltet');
    expect(libStatus({ version: 'unbekannt' })).toBe('unbekannt');
    expect(libStatus({ version: '1.0.0' })).toBe('aktuell');
  });

  it('collectLibraries aggregiert aus comp.libs inkl. vendored + outdated', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: '/x', libs: [
      { name: 'jsonpath', version: '0.8.0', status: 'aktuell', outdated: true, latest: '1.3.0' },
      { name: 'mxgraph', version: '3.9.12', status: 'nicht gepflegt', unmaintained: true },
      { name: 'jquery', version: '1.12.4', status: 'verwundbar', vulnerable: true },
    ] });
    const { libraries } = collectLibraries(store, { persist: false });
    const m = Object.fromEntries(libraries.map((l) => [l.name, l.status]));
    expect(m.jsonpath).toBe('veraltet'); // war fälschlich „aktuell"
    expect(m.mxgraph).toBe('nicht gepflegt');
    expect(m.jquery).toBe('verwundbar');
  });

  it('Re-Test überschreibt den veraltet-Status NICHT (Merge erhält Web-Felder)', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: '/x' });
    // Zustand nach Web-Check: jsonpath ist veraltet
    store.update('c1', { testPlan: 'X', libs: [{ name: 'jsonpath', version: '0.8.0', status: 'veraltet', outdated: true, latest: '1.3.0' }] });
    // Re-Test: Scan liefert die Lib ohne Web-Wissen (status aktuell)
    const scan = () => ({ log: [], libs: [{ name: 'jsonpath', version: '0.8.0', status: 'aktuell' }], artifacts: [], outdated: [], risks: [], failures: [] });
    runComponentOnce(store, store.get('c1'), { scan });
    const lib = store.get('c1').libs[0];
    expect(lib.outdated).toBe(true);
    expect(lib.status).toBe('veraltet');
    expect(lib.latest).toBe('1.3.0');
  });
});
