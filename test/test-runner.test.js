import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runComponentTests } from '../src/service/test-runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('T-57 runComponentTests — Plugin-Tests, nicht die App-Tests', () => {
  const scan = (p) => {
    if (p === '/red') return { testPlan: 'Szenario: a\nSzenario: b', log: [{ agent: 'Review-Gate', result: 'blockiert (security)' }], failures: [] };
    if (p === '/green') return { testPlan: 'Szenario: a', log: [{ agent: 'Security', file: 'x', result: 'keine Befunde' }], failures: [], format: 'export' };
    return { testPlan: '', log: [], failures: [] };
  };
  const exists = (p) => !!p; // jede Komponente mit Pfad „existiert"

  it('prüft alle Komponenten; zählt Szenarien; grün/rot/übersprungen', () => {
    const comps = [
      { name: 'Gut', path: '/green' },
      { name: 'Schlecht', path: '/red' },
      { name: 'OhneRepo', path: '' },
    ];
    const res = runComponentTests(comps, { scan, exists });
    expect(res.green).toBe(1);
    expect(res.red).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.ok).toBe(false); // mind. ein Rot → Exit-Code != 0
    expect(res.results.find((r) => r.name === 'Gut').scenarios).toBe(1);
    expect(res.results.find((r) => r.name === 'Schlecht').scenarios).toBe(2);
    expect(res.results.find((r) => r.name === 'OhneRepo').verdict).toBe('skipped');
  });

  it('alle grün → ok=true (Exit-Code 0)', () => {
    const res = runComponentTests([{ name: 'Gut', path: '/green' }], { scan, exists });
    expect(res.ok).toBe(true);
    expect(res.red).toBe(0);
  });
});

describe('T-57/T-58 CLI: node start.js test', () => {
  it('liest Komponenten aus AISPP_DATA_DIR, überspringt Repo-lose sauber, führt NICHT die App-Unit-Tests aus', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-cli-'));
    fs.writeFileSync(path.join(tmp, 'components.json'), JSON.stringify({ items: [{ id: '1', name: 'NurNameKeinRepo', path: '' }] }));
    const out = execFileSync('node', ['start.js', 'test'], { cwd: root, env: { ...process.env, AISPP_DATA_DIR: tmp }, encoding: 'utf8' });
    expect(out).toContain('NurNameKeinRepo'); // aus dem umgelenkten Datenverzeichnis gelesen
    expect(out).toContain('übersprungen'); // kein Repo → sauber übersprungen, kein Absturz
    expect(out).not.toMatch(/vitest|Test Files|RUN v/i); // ausdrücklich NICHT die App-Unit-Tests
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
