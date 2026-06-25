import { describe, it, expect } from 'vitest';
import { manualReview } from '../src/gui/components.js';
import { createComponentStore } from '../src/gui/store.js';

describe('Review schreibt ins Protokoll (welcher Agent prüfte welche Datei)', () => {
  it('Security-Finding landet als Agent-Eintrag im lastLog', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    const gather = () => ({ assets: [{ name: 'x.js', code: 'el.innerHTML = a + b;' }] });
    const r = manualReview(store, 'c1', { gather, save: false });

    expect(r.gate.pass).toBe(false);
    const entries = store.get('c1').lastLog.entries;
    expect(entries.some((e) => e.agent === 'Security' && e.file === 'x.js')).toBe(true);
    expect(entries.some((e) => e.agent === 'Review-Gate' && /blockiert/.test(e.result))).toBe(true);
  });

  it('erneutes Review ersetzt alte Review-Einträge (kein Duplikat)', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    const gather = () => ({ assets: [{ name: 'x.js', code: 'el.innerHTML = a + b;' }] });
    manualReview(store, 'c1', { gather });
    manualReview(store, 'c1', { gather });
    const gateEntries = store.get('c1').lastLog.entries.filter((e) => e.agent === 'Review-Gate');
    expect(gateEntries).toHaveLength(1);
  });

  it('sauberer Code → Review-Gate bestanden im Protokoll', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    const gather = () => ({ assets: [{ name: 'ok.js', code: 'function f(){ return apex.item("X").getValue(); }' }] });
    manualReview(store, 'c1', { gather });
    expect(store.get('c1').lastLog.entries.some((e) => e.agent === 'Review-Gate' && /bestanden/.test(e.result))).toBe(true);
  });
});
