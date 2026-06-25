import { describe, it, expect } from 'vitest';
import { defaultGather, manualReview } from '../src/gui/components.js';
import { createComponentStore } from '../src/gui/store.js';
import { scanRepo } from '../src/service/run-repo.js';

describe('B-1 Robustheit ohne zugeordnetes Repo', () => {
  it('defaultGather liefert leere Assets statt zu werfen', () => {
    expect(defaultGather({ path: '' })).toEqual({ assets: [], cve: [] });
    expect(defaultGather({ path: '/gibtsnicht/xyz' })).toEqual({ assets: [], cve: [] });
  });

  it('manualReview ohne Repo → klare Meldung statt Crash', () => {
    const store = createComponentStore();
    const id = store.add({ name: 'ohne-repo', path: '' }).id;
    const r = manualReview(store, id, {});
    expect(r.gate).toBeNull();
    expect(r.empty).toBe(true);
    expect(r.message).toMatch(/Repo/);
  });

  it('scanRepo auf leerem/ungültigem Pfad → valides leeres Ergebnis', () => {
    const r = scanRepo('');
    expect(r.artifacts).toEqual([]);
    expect(r.log).toEqual([]);
    expect(scanRepo('/gibtsnicht/xyz').artifacts).toEqual([]);
  });
});
