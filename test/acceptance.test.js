import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptanceFromSelfTest, compareAcceptance, criterionKey, writeAcceptance, readAcceptance } from '../src/service/acceptance.js';

describe('F-30 T-116 Akzeptanz-Vertrag aus der Mock-Charakterisierung', () => {
  const stGreen = {
    ran: true, rendered: true, views: 2, total: 3,
    features: [
      { view: 'default', feature: 'renders 12 nodes', ok: true, detail: '12 nodes' },
      { view: 'default', feature: 'select stores value', ok: true },
      { view: 'mode-2', feature: 'multi select', ok: true },
    ],
    problems: [],
  };

  it('leitet nur GRÜNE, technologieunabhängige Kriterien ab (keine roten/falsch-grünen)', () => {
    const st = {
      ran: true, rendered: true, views: 2, total: 4,
      features: [
        { view: 'default', feature: 'renders 12 nodes', ok: true },
        { view: 'default', feature: 'broken dep', ok: true, detail: 'jsonpath is not defined; empty SVG' }, // falsch-grün
        { view: 'default', feature: 'red check', ok: false },
        { view: 'mode-2', feature: 'multi select', ok: true },
      ],
      problems: [{ view: 'default', feature: 'broken dep', detail: 'jsonpath is not defined' }],
    };
    const c = acceptanceFromSelfTest(st);
    expect(c.error).toBeUndefined();
    expect(c.renderedRequired).toBe(true);
    const keys = c.criteria.map((x) => criterionKey(x.view, x.feature));
    expect(keys).toContain(criterionKey('default', 'renders 12 nodes'));
    expect(keys).toContain(criterionKey('mode-2', 'multi select'));
    expect(keys).not.toContain(criterionKey('default', 'broken dep')); // falsch-grün ausgeschlossen
    expect(keys).not.toContain(criterionKey('default', 'red check'));  // rot ausgeschlossen
    expect(c.total).toBe(2);
  });

  it('ohne lauffähiges Self-Test-Ergebnis → error', () => {
    expect(acceptanceFromSelfTest({ ran: false }).error).toBeTruthy();
    expect(acceptanceFromSelfTest(null).error).toBeTruthy();
  });

  it('compareAcceptance: neuer Stand erfüllt alle Kriterien → pass', () => {
    const c = acceptanceFromSelfTest(stGreen);
    const res = compareAcceptance(c, stGreen);
    expect(res.pass).toBe(true);
    expect(res.satisfied).toBe(3);
    expect(res.missing.length).toBe(0);
    expect(res.broken.length).toBe(0);
  });

  it('compareAcceptance: fehlendes Kriterium ODER rotes Kriterium → fail (Regress)', () => {
    const c = acceptanceFromSelfTest(stGreen);
    const stRegress = {
      ran: true, rendered: true, views: 2,
      features: [
        { view: 'default', feature: 'renders 12 nodes', ok: false }, // jetzt rot
        { view: 'default', feature: 'select stores value', ok: true },
        // 'mode-2 / multi select' fehlt ganz
      ],
    };
    const res = compareAcceptance(c, stRegress);
    expect(res.pass).toBe(false);
    expect(res.broken.map((x) => x.feature)).toContain('renders 12 nodes');
    expect(res.missing.map((x) => x.feature)).toContain('multi select');
  });

  it('compareAcceptance: technologie egal — anderer Stand, gleiche Kriterien erfüllt → pass (works as before)', () => {
    const c = acceptanceFromSelfTest(stGreen);
    // „neu implementiert mit anderer Technologie": dieselben beobachtbaren Checks, zusätzliche interne sind egal
    const stRebuilt = {
      ran: true, rendered: true, views: 2,
      features: [
        { view: 'default', feature: 'renders 12 nodes', ok: true },
        { view: 'default', feature: 'select stores value', ok: true },
        { view: 'mode-2', feature: 'multi select', ok: true },
        { view: 'default', feature: 'extra internal check', ok: true },
      ],
    };
    expect(compareAcceptance(c, stRebuilt).pass).toBe(true);
  });

  it('compareAcceptance: renderedRequired & Plugin rendert nicht → fail', () => {
    const c = acceptanceFromSelfTest(stGreen);
    expect(compareAcceptance(c, { ran: true, rendered: false, features: stGreen.features }).pass).toBe(false);
  });

  it('write/readAcceptance: Roundtrip neben dem Mock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
    try {
      const c = acceptanceFromSelfTest(stGreen, { name: 'Widget', at: '2026-06-27T00:00:00Z' });
      const p = writeAcceptance(dir, c);
      expect(p && fs.existsSync(p)).toBeTruthy();
      const back = readAcceptance(dir);
      expect(back.total).toBe(3);
      expect(back.name).toBe('Widget');
      expect(readAcceptance(fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')))).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
