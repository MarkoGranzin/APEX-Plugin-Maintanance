import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoReviewFix } from '../src/service/autoreview.js';
import { createComponentStore } from '../src/gui/store.js';
import { acceptanceToScenarios } from '../src/service/acceptance.js';

// Eingebauter Security-Befund: eval() → 'code-injection-eval' (high) → blockiert das Gate.
const VULN = 'function f(x){ return eval(x); }\n';
const SAFE = 'function f(x){ return Number(x); }\n';

describe('T-124 Native-Guard + T-125 kritischer Code im Selbst-Fix', () => {
  let dir, store, id;
  const aiFix = { kind: 'cli', complete: async () => SAFE };       // KI behebt den Befund
  const aiNoFix = { kind: 'cli', complete: async () => 'not valid ((' }; // KI liefert keinen brauchbaren Fix

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arnative-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), VULN);
    store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: dir });
    id = 'c1';
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const code = () => fs.readFileSync(path.join(dir, 'js', 'widget.js'), 'utf8');

  it('statisch grün, aber nativ kaputt → ALLES zurückgerollt, pass=false, kritischer Befund bleibt', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: aiFix, verifyNative: async () => ({ pass: false, broken: [{ view: 'default', feature: 'rendert' }], missing: [], ran: true }) });
    expect(r.pass).toBe(false);
    expect(code()).toContain('eval'); // Rollback: Originaldatei wieder da
    expect(r.criticalFindings.some((f) => f.rule === 'code-injection-eval')).toBe(true);
    const log = store.get(id).lastLog.entries;
    expect(log.some((e) => /brach natives Funktionieren/i.test(e.result))).toBe(true);
  });

  it('statisch grün UND nativ ok → Fix bleibt, pass=true, keine kritischen Befunde offen', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: aiFix, verifyNative: async () => ({ pass: true, broken: [], missing: [], ran: true }) });
    expect(r.pass).toBe(true);
    expect(code()).not.toContain('eval');
    expect(r.criticalFindings.length).toBe(0);
  });

  it('ohne verifyNative-Guard → rückwärtskompatibel (nur statisches Gate)', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: aiFix });
    expect(r.pass).toBe(true);
    expect(code()).not.toContain('eval');
  });

  it('Guard, der nicht laufen kann (skipped), blockiert NICHT', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: aiFix, verifyNative: async () => ({ pass: true, skipped: true, reason: 'kein Mock' }) });
    expect(r.pass).toBe(true);
    expect(code()).not.toContain('eval');
  });

  it('T-125: nicht fixbarer kritischer Befund → pass=false und bleibt in criticalFindings', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: aiNoFix });
    expect(r.pass).toBe(false);
    expect(r.criticalFindings.some((f) => f.rule === 'code-injection-eval' && f.severity === 'high')).toBe(true);
    const log = store.get(id).lastLog.entries;
    expect(log.some((e) => e.agent === 'Security' && /KRITISCH/.test(e.result))).toBe(true);
  });

  it('T-124: „funktioniert nativ wie zuvor" ist Kopf-Akzeptanzkriterium der Anforderungen', () => {
    const scen = acceptanceToScenarios({ renderedRequired: true, criteria: [{ view: 'default', feature: 'rendert 12 Knoten' }] }, { name: 'P' });
    expect(scen[0].title).toMatch(/works natively as before/i);
    expect(scen[0].gherkin).toMatch(/without JS errors/i);
  });
});
