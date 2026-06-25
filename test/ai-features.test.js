import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gherkinForArtifact, buildTestPlan } from '../src/ai/testplan.js';
import { resolveAiBackend, aiBackendView } from '../src/ai/configure.js';
import { SecretStore } from '../src/config/secrets.js';
import { autoReviewFix } from '../src/service/autoreview.js';
import { createComponentStore } from '../src/gui/store.js';

describe('Testplan (Cucumber)', () => {
  it('erzeugt Gherkin-Szenarien aus Einstiegspunkten/apex/DOM', () => {
    const g = gherkinForArtifact('slider', { entryPoints: ['init', 'refresh'], apexCalls: ['apex.server.process'], domAccess: ['document.getElementById'] });
    expect(g).toMatch(/Funktionalität: slider/);
    expect(g).toMatch(/Szenario: Einstiegspunkt init funktioniert/);
    expect(g).toMatch(/Angenommen/); expect(g).toMatch(/Wenn/); expect(g).toMatch(/Dann/);
    expect(g).toMatch(/Server-Callback/);
  });
  it('ohne Einstiegspunkte → Basis-Szenario; buildTestPlan kombiniert', () => {
    expect(gherkinForArtifact('x', {})).toMatch(/lädt ohne Fehler/);
    expect(buildTestPlan([{ name: 'a', analysis: {} }, { name: 'b', analysis: {} }])).toMatch(/Funktionalität: a[\s\S]*Funktionalität: b/);
  });
});

describe('KI-Konfiguration', () => {
  it('Default ohne aiBackend → Stub', () => {
    expect(resolveAiBackend({}, null).kind).toBe('stub');
  });
  it('CLI-Backend aus Einstellungen', () => {
    expect(resolveAiBackend({ aiBackend: { kind: 'cli', command: 'claude' } }, null).kind).toBe('cli');
  });
  it('Provider löst Key aus dem SecretStore', () => {
    const ss = new SecretStore('m'); ss.set('ai-key', 'sk-LIVE');
    const be = resolveAiBackend({ aiBackend: { kind: 'provider', endpoint: 'e', secretRef: 'ai-key' } }, ss);
    expect(be.kind).toBe('provider');
    expect(aiBackendView({ aiBackend: { kind: 'provider', secretRef: 'ai-key', endpoint: 'e', model: 'm' } })).toMatchObject({ kind: 'provider', hasKey: true });
  });
});

describe('Autonomes Review & Fix', () => {
  let dir, store, id;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-ar-'));
    fs.mkdirSync(path.join(dir, 'plugin'));
    fs.writeFileSync(path.join(dir, 'plugin', 'widget.js'), 'el.innerHTML = a + b;');
    store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    id = store.add({ name: 'plugin', path: dir }).id;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ohne echtes Backend (Stub) → klare Meldung, kein Fix', async () => {
    const r = await autoReviewFix(store, store.get(id), { ai: { kind: 'stub' } });
    expect(r.error).toMatch(/KI-Backend/);
  });

  it('mit Backend, das einen sicheren Fix liefert → grün, Datei gepatcht', async () => {
    const ai = { kind: 'cli', complete: async () => 'el.textContent = String(a) + String(b);' };
    const r = await autoReviewFix(store, store.get(id), { ai });
    expect(r.pass).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'plugin', 'widget.js'), 'utf8')).toContain('textContent');
    const entries = store.get(id).lastLog.entries;
    expect(entries.some((e) => e.agent === 'Web-Dev')).toBe(true);
    expect(entries.some((e) => e.agent === 'Auto-Review' && /grün/.test(e.result))).toBe(true);
  });

  it('Backend ohne brauchbaren Fix → Rollback, nicht grün', async () => {
    const ai = { kind: 'cli', complete: async () => 'el.innerHTML = a + b;' }; // unverändert/unsicher
    const r = await autoReviewFix(store, store.get(id), { ai });
    expect(r.pass).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'plugin', 'widget.js'), 'utf8')).toContain('innerHTML'); // zurückgerollt/unverändert
  });
});
