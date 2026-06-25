import { describe, it, expect } from 'vitest';
import { captureBaseline, compareToBaseline, specHashOf } from '../src/service/baseline.js';
import { parsePlaywrightJson } from '../src/test/run-ui.js';
import { createComponentStore } from '../src/gui/store.js';

const mkStore = () => createComponentStore({ now: () => 't', idGen: () => 'c1' });
const uiSpec = { name: 'p.ui.spec.js', content: "import {test} from '@playwright/test';" };

describe('F-28 T-92 Charakterisierungs-Baseline', () => {
  it('UI-Modus: nimmt Einzelergebnisse auf und persistiert sie + Spec-Hash', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', uiTestUrl: 'http://x', codedTests: [uiSpec] }).id;
    const runDetailed = async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }, { scenario: 'B', status: 'passed' }] });
    const onCalls = [];
    const b = await captureBaseline(store, store.get(id), { runDetailed, hasPlaywright: true, now: () => 't', onBaseline: (c, x) => onCalls.push(x) });
    expect(b.mode).toBe('ui');
    expect(b.scenarios).toHaveLength(2);
    expect(b.specHash).toBe(specHashOf([uiSpec]));
    expect(store.get(id).baseline.scenarios[0]).toMatchObject({ scenario: 'A', status: 'passed' });
    expect(onCalls).toHaveLength(1);
  });

  it('Fallback statisch: ohne URL → Baseline aus Protokoll-Test-Einträgen, klar markiert', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', codedTests: [uiSpec], lastLog: { entries: [
      { agent: 'Test', file: 'szenario 1', result: 'grün' },
      { agent: 'Test', file: 'szenario 2', result: 'rot: fehlgeschlagen' },
    ] } }).id;
    const b = await captureBaseline(store, store.get(id), { hasPlaywright: true }); // keine uiTestUrl → static
    expect(b.mode).toBe('static');
    expect(b.scenarios).toEqual([
      { scenario: 'szenario 1', status: 'passed' },
      { scenario: 'szenario 2', status: 'failed' },
    ]);
  });

  it('compareToBaseline: kein Regress → pass; Regress → fail', () => {
    const comp = { codedTests: [uiSpec], baseline: { mode: 'ui', specHash: specHashOf([uiSpec]), scenarios: [{ scenario: 'A', status: 'passed' }] } };
    expect(compareToBaseline(comp, [{ scenario: 'A', status: 'passed' }]).pass).toBe(true);
    const bad = compareToBaseline(comp, [{ scenario: 'A', status: 'failed' }]);
    expect(bad.pass).toBe(false);
    expect(bad.regressions[0]).toMatchObject({ scenario: 'A' });
  });

  it('compareToBaseline ohne Baseline → klare Meldung', () => {
    expect(compareToBaseline({}, []).noBaseline).toBe(true);
  });

  it('rote Baseline (0 grün) → Gate verweigert (kein stilles pass)', () => {
    const comp = { codedTests: [uiSpec], baseline: { mode: 'ui', specHash: specHashOf([uiSpec]), scenarios: [{ scenario: 'A', status: 'failed' }] } };
    const r = compareToBaseline(comp, [{ scenario: 'A', status: 'failed' }]);
    expect(r.pass).toBe(false);
    expect(r.noGreenBaseline).toBe(true);
  });

  it('parsePlaywrightJson liest Einzelergebnisse aus dem JSON-Reporter', () => {
    const json = JSON.stringify({ suites: [{ specs: [
      { title: 'A', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'B', ok: false, tests: [{ results: [{ status: 'failed' }] }] },
    ] }] });
    expect(parsePlaywrightJson(json)).toEqual([
      { scenario: 'A', status: 'passed' },
      { scenario: 'B', status: 'failed' },
    ]);
  });
});
