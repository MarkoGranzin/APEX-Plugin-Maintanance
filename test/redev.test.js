import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redevelopComponent, breakingNotes, buildMigrationPrompt } from '../src/service/redev.js';
import { createComponentStore } from '../src/gui/store.js';

const mkStore = () => createComponentStore({ now: () => 't', idGen: () => 'c1' });
const withBaseline = (store, scenarios) => {
  const id = store.add({ name: 'P', path: '/repo', uiTestUrl: 'http://x', codedTests: [{ name: 'p.ui.spec.js', content: 'x' }] }).id;
  store.update(id, { baseline: { mode: 'ui', specHash: 'h', scenarios } });
  return id;
};

describe('F-28 T-93 redevelopComponent (Spec-gesicherte Migration)', () => {
  it('kein Regress → uebernommen + Upload angeboten', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let uploaded = false; let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, applied: [{ name: 'jquery', to: '4.0.0' }], summary: 'migrated', backups: new Map(), rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }] }),
      upload: async () => { uploaded = true; return { ok: true, branch: 'b' }; },
    });
    expect(r.adopted).toBe(true);
    expect(r.gate.pass).toBe(true);
    expect(uploaded).toBe(true);
    expect(rolledBack).toBe(false);
    // T-94: Komponente ist als neu gebaut markiert
    const after = store.get(id);
    expect(after.rebuilt).toBe(true);
    expect(after.verifiedAsBefore).toBe(true);
    expect(after.rebuiltAt).toBeTruthy();
  });

  it('Review+Rework-Loop laeuft VOR dem UI-Gate; Ergebnis im Resultat (T-100)', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    const order = [];
    const r = await redevelopComponent(store, store.get(id), {
      ai: { kind: 'cli' },
      migrate: async () => { order.push('migrate'); return { changed: true, applied: [{ name: 'jquery', to: '4.0.0' }], summary: 'm', backups: new Map(), rollback: () => {} }; },
      reviewFix: async () => { order.push('review'); return { pass: true, attempts: 2 }; },
      runDetailed: async () => { order.push('ui'); return { ran: true, scenarios: [{ scenario: 'A', status: 'passed' }] }; },
      upload: async () => ({ ok: true }),
    });
    expect(order).toEqual(['migrate', 'review', 'ui']); // Loop vor dem UI-Gate
    expect(r.review).toMatchObject({ pass: true, attempts: 2 });
    expect(r.adopted).toBe(true);
  });

  it('Regress (vorher gruen, jetzt rot) → verworfen + Rollback + Bericht', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let uploaded = false; let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, summary: 'migrated', backups: new Map(), rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: true, ok: false, scenarios: [{ scenario: 'A', status: 'failed' }] }),
      upload: async () => { uploaded = true; return { ok: true }; },
    });
    expect(r.adopted).toBe(false);
    expect(r.regressions[0]).toMatchObject({ scenario: 'A' });
    expect(rolledBack).toBe(true);
    expect(uploaded).toBe(false);
  });

  it('ohne Baseline UND ohne Akzeptanz-Vertrag → klarer Fehler', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo' }).id;
    const r = await redevelopComponent(store, store.get(id), { migrate: async () => ({ changed: true }) });
    expect(r.error).toMatch(/Baseline|Akzeptanz/);
  });

  // T-122: Akzeptanz-Vertrag-Gate — Plugin OHNE Playwright-Baseline migrierbar (gegatet am Mock-Selbsttest)
  it('T-122: Akzeptanz-Gate, kein Regress → übernommen (ohne Baseline)', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo', mockUrl: 'http://x/mock' }).id; // KEINE baseline
    const contract = { criteria: [{ view: 'v', feature: 'renders' }], renderedRequired: true };
    const r = await redevelopComponent(store, store.get(id), {
      acceptanceContract: contract,
      migrate: async () => ({ changed: true, applied: [{ name: 'mxgraph', to: '4.2.2' }], summary: 'm', rollback() {} }),
      runMockSelfTests: async () => ({ ran: true, rendered: true, features: [{ view: 'v', feature: 'renders', ok: true }] }),
    });
    expect(r.adopted).toBe(true);
    expect(r.gate.pass).toBe(true);
    expect(r.gate.acceptance).toBeTruthy();
    expect(store.get(id).verifiedAsBefore).toBe(true);
  });

  it('T-122: Akzeptanz-Gate, Regress (Kriterium rot) → Rollback, nicht übernommen', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo', mockUrl: 'http://x/mock' }).id;
    const contract = { criteria: [{ view: 'v', feature: 'renders' }], renderedRequired: true };
    let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      acceptanceContract: contract,
      migrate: async () => ({ changed: true, summary: 'm', rollback: () => { rolledBack = true; } }),
      runMockSelfTests: async () => ({ ran: true, rendered: true, features: [{ view: 'v', feature: 'renders', ok: false }] }),
    });
    expect(r.adopted).toBe(false);
    expect(rolledBack).toBe(true);
    expect(r.regressions.some((x) => /renders/.test(x.scenario))).toBe(true);
  });

  it('T-122: Akzeptanz-Gate, Mock-Selbsttest nicht ausführbar → Rollback', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo', mockUrl: 'http://x/mock' }).id;
    let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      acceptanceContract: { criteria: [{ view: 'v', feature: 'renders' }] },
      migrate: async () => ({ changed: true, summary: 'm', rollback: () => { rolledBack = true; } }),
      runMockSelfTests: async () => ({ ran: false, reason: 'no playwright' }),
    });
    expect(r.adopted).toBe(false);
    expect(rolledBack).toBe(true);
    expect(r.reason).toMatch(/Akzeptanz-Gate nicht ausführbar/);
  });

  it('B-25: grünes Gate aber KEIN realer Lib-Tausch → nicht adopted, als notRepairable markiert + stale rebuilt geräumt', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo', mockUrl: 'http://x/mock' }).id;
    store.update(id, { rebuilt: true, rebuiltTo: 'jquery@4.0.0' }); // altes (stale) Flag aus früherem Lauf
    const r = await redevelopComponent(store, store.get(id), {
      acceptanceContract: { criteria: [{ view: 'v', feature: 'renders' }], renderedRequired: true },
      migrate: async () => ({ changed: true, applied: [], summary: 'nur Code, keine Lib getauscht', rollback() {} }),
      runMockSelfTests: async () => ({ ran: true, rendered: true, features: [{ view: 'v', feature: 'renders', ok: true }] }),
    });
    expect(r.adopted).toBe(false);
    expect(r.notRepairable).toBe(true);
    const after = store.get(id);
    expect(after.notRepairable).toBeTruthy();
    expect(after.notRepairable.reason).toMatch(/real aktualisieren|manuelle/i);
    expect(after.rebuilt).toBe(false);   // irreführendes Flag geräumt
    expect(after.rebuiltTo).toBeNull();
  });

  it('B-25: realer Tausch + grünes Gate → adopted, notRepairable geräumt', async () => {
    const store = mkStore();
    const id = store.add({ name: 'P', path: '/repo', mockUrl: 'http://x/mock' }).id;
    store.update(id, { notRepairable: { at: 't', reason: 'alt' } });
    const r = await redevelopComponent(store, store.get(id), {
      acceptanceContract: { criteria: [{ view: 'v', feature: 'renders' }], renderedRequired: true },
      migrate: async () => ({ changed: true, applied: [{ name: 'jquery', to: '4.0.0' }], summary: 'getauscht', rollback() {} }),
      runMockSelfTests: async () => ({ ran: true, rendered: true, features: [{ view: 'v', feature: 'renders', ok: true }] }),
    });
    expect(r.adopted).toBe(true);
    expect(r.rebuiltTo).toBe('jquery@4.0.0');
    expect(store.get(id).notRepairable).toBeNull(); // wieder reparierbar
  });

  it('Migration ohne Änderung → nicht uebernommen', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    const r = await redevelopComponent(store, store.get(id), { migrate: async () => ({ changed: false, summary: 'nichts' }) });
    expect(r.adopted).toBe(false);
    expect(r.reason).toMatch(/nichts|keine/i);
  });

  it('UI-Tests nicht lauffaehig → Rollback, nicht uebernommen', async () => {
    const store = mkStore();
    const id = withBaseline(store, [{ scenario: 'A', status: 'passed' }]);
    let rolledBack = false;
    const r = await redevelopComponent(store, store.get(id), {
      migrate: async () => ({ changed: true, summary: 'm', rollback: () => { rolledBack = true; } }),
      runDetailed: async () => ({ ran: false, reason: 'Keine Test-URL' }),
    });
    expect(r.adopted).toBe(false);
    expect(rolledBack).toBe(true);
  });

  // B-17: die echte defaultMigrate muss die vendored Lib WIRKLICH tauschen (nicht nur Code anpassen)
  const mkRepo = (jqContent) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redev-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.maintenance', 'mock', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), jqContent);
    fs.writeFileSync(path.join(dir, '.maintenance', 'mock', 'lib', 'jquery.min.js'), jqContent);
    return dir;
  };
  const fakeSwap = async (d) => {
    const abs = path.join(d, 'lib', 'jquery.min.js');
    const backups = new Map([[abs, fs.readFileSync(abs, 'utf8')]]);
    fs.writeFileSync(abs, '/*! jQuery v4.0.0 */');
    return { results: [{ name: 'jquery', from: '1.12.4', to: '4.0.0', applied: true, file: 'lib/jquery.min.js' }], backups };
  };
  const repoComp = (store, dir) => {
    const id = store.add({ name: 'P', path: dir, uiTestUrl: 'http://x', codedTests: [{ name: 'p.ui.spec.js', content: 'x' }], libs: [{ name: 'jquery', version: '1.12.4', latest: '4.0.0', outdated: true }] }).id;
    store.update(id, { baseline: { mode: 'ui', specHash: 'h', scenarios: [{ scenario: 'A', status: 'passed' }] } });
    return id;
  };

  it('B-17: tauscht die vendored Lib real, spiegelt sie in den Mock, rebuiltTo = real getauscht', async () => {
    const dir = mkRepo('/*! jQuery v1.12.4 */');
    const store = mkStore();
    const id = repoComp(store, dir);
    const r = await redevelopComponent(store, store.get(id), {
      ai: { kind: 'cli', complete: async () => '' }, // keine Code-Änderung nötig
      applyVendoredUpdates: fakeSwap,
      runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }] }),
    });
    expect(r.adopted).toBe(true);
    expect(r.rebuiltTo).toContain('jquery@4.0.0');
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toContain('v4.0.0');                              // echte Lib getauscht
    expect(fs.readFileSync(path.join(dir, '.maintenance', 'mock', 'lib', 'jquery.min.js'), 'utf8')).toContain('v4.0.0');     // in den Mock gespiegelt
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('B-17: Regress → Rollback stellt Lib UND Mock wieder her', async () => {
    const dir = mkRepo('OLD');
    const store = mkStore();
    const id = repoComp(store, dir);
    const r = await redevelopComponent(store, store.get(id), {
      ai: { kind: 'cli', complete: async () => '' },
      applyVendoredUpdates: fakeSwap,
      runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'failed' }] }), // Regress
    });
    expect(r.adopted).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toBe('OLD');                              // Lib zurückgerollt
    expect(fs.readFileSync(path.join(dir, '.maintenance', 'mock', 'lib', 'jquery.min.js'), 'utf8')).toBe('OLD');      // Mock zurückgerollt
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // T-103: der KI besser vermitteln — konkrete Breaking-Changes + Feature-Erhalt im Prompt
  it('breakingNotes liefert lib-spezifische Hinweise (jQuery-APIs, Bootstrap-Klassen/Attribute)', () => {
    const notes = breakingNotes([{ name: 'jquery', version: '1.12.4', latest: '4.0.0' }, { name: 'bootstrap', version: '3.3.7', latest: '5.3.8' }]);
    expect(notes).toMatch(/\.on\(\)/);              // jQuery: Event-API portieren
    expect(notes).toMatch(/data-bs-toggle/);        // Bootstrap: Attribut-Rename
    expect(notes).toMatch(/col-xs-\*→col-\*/);      // Bootstrap: Grid-Klassen
    expect(notes).toMatch(/jQuery plugin API .*REMOVED/i);
  });

  it('buildMigrationPrompt verlangt Optik + ALLE Interaktionen (Drag&Drop) und enthält Breaking-Notes + Inventar', () => {
    const p = buildMigrationPrompt({ name: 'js/script.js', code: 'function f(){}' }, {
      target: 'jquery@4.0.0, bootstrap@5.3.8',
      breaking: breakingNotes([{ name: 'bootstrap', version: '3.3.7', latest: '5.3.8' }]),
      inventory: { events: ['drop→#board', 'click→.card'], fns: ['initBoard(opts)'], apexCalls: ['apex.server.process'] },
    });
    expect(p).toMatch(/drag & drop/i);
    expect(p).toMatch(/VISUAL appearance/);
    expect(p).toMatch(/PRESERVE/);
    expect(p).toMatch(/data-bs-toggle/);            // Breaking-Notes eingebettet
    expect(p).toMatch(/drop→#board/);               // Inventar (Events) eingebettet
    expect(p).toMatch(/js\/script\.js/);            // Datei
  });

  it('buildMigrationPrompt: unmaintained → SELBST neu entwickeln (kein API-Mapping vorgegeben), permissiv/MIT, nie Copyleft', () => {
    const p = buildMigrationPrompt({ name: 'js/script.js', code: 'x' }, {
      replacements: [
        { from: 'moment', to: 'dayjs', license: 'MIT', cdn: 'https://cdn/dayjs.js', attribution: false, strategy: 'replace' },
        { from: 'yui', to: null, strategy: 'self-build' },
      ],
    });
    expect(p).toMatch(/RE-DEVELOP/);                          // neu entwickeln, nicht portieren
    expect(p).toMatch(/RE-IMPLEMENT it from scratch/);
    expect(p).toMatch(/do not expect a 1:1 API mapping/);    // keine konkrete Mapping-Hilfe
    expect(p).toMatch(/YOU decide the approach/);            // KI entscheidet selbst
    expect(p).toMatch(/dayjs/);                               // permissiver Nachfolger nur als Option
    expect(p).toMatch(/NEVER GPL\/AGPL\/LGPL\/other copyleft/); // Lizenz-Leitplanke
    expect(p).toMatch(/self-built under MIT/);               // Self-Build-Pfad
    expect(p).toMatch(/There is no drop-in successor; build your own/); // ohne Nachfolger
  });

  // T-104: optisches Abschluss-Gate (AI-UI-Prüfung „sieht aus wie zuvor")
  const withShotBaseline = (store) => {
    const id = store.add({ name: 'P', path: '/repo', uiTestUrl: 'http://x', codedTests: [{ name: 'p.ui.spec.js', content: 'x' }] }).id;
    store.update(id, { baseline: { mode: 'ui', specHash: 'h', scenarios: [{ scenario: 'A', status: 'passed' }], shot: '/tmp/before.png' } });
    return id;
  };
  const visualDeps = (visual) => ({
    ai: { kind: 'cli' },
    migrate: async () => ({ changed: true, applied: [{ name: 'jquery', to: '4.0.0' }], summary: 'm', backups: new Map(), rollback() { this._rb = true; }, _rb: false }),
    runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }] }),
    hasPlaywright: true,
    captureShot: async () => ({ ok: true, path: '/tmp/after.png' }),
    aiVisualCheck: async () => visual,
    upload: async () => ({ ok: true, branch: 'b' }),
  });

  it('T-104: optischer Regress (AI looksSame:false) → Rollback, NICHT uebernommen', async () => {
    const store = mkStore();
    const id = withShotBaseline(store);
    let rolledBack = false;
    const deps = visualDeps({ ran: true, looksSame: false, issues: ['layout broken'] });
    deps.migrate = async () => ({ changed: true, applied: [{ name: 'jquery', to: '4.0.0' }], summary: 'm', backups: new Map(), rollback: () => { rolledBack = true; } });
    const r = await redevelopComponent(store, store.get(id), deps);
    expect(r.adopted).toBe(false);
    expect(rolledBack).toBe(true);
    expect(r.visual).toMatchObject({ ran: true, looksSame: false });
    expect(store.get(id).rebuilt).toBeFalsy();
  });

  it('T-104: AI looksSame:true → uebernommen, visual im Ergebnis', async () => {
    const store = mkStore();
    const id = withShotBaseline(store);
    const r = await redevelopComponent(store, store.get(id), visualDeps({ ran: true, looksSame: true, issues: [] }));
    expect(r.adopted).toBe(true);
    expect(r.visual).toMatchObject({ ran: true, looksSame: true });
    expect(store.get(id).rebuilt).toBe(true);
  });

  it('Mock-Update: nach der Migration wird die Plugin-Code-Kopie des Mocks auf den migrierten Code aktualisiert', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redev-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.maintenance', 'mock', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'js', 'script.js'), 'function init(){ var x=1; /* OLDCODE */ return x; }');
    fs.writeFileSync(path.join(dir, '.maintenance', 'mock', 'plugin', 'script.js'), 'function init(){ var x=1; /* OLDCODE */ return x; }');
    const store = mkStore();
    const id = store.add({ name: 'P', path: dir, uiTestUrl: 'http://x', codedTests: [{ name: 'p.ui.spec.js', content: 'x' }], libs: [] }).id;
    store.update(id, { baseline: { mode: 'ui', specHash: 'h', scenarios: [{ scenario: 'A', status: 'passed' }] } });
    const r = await redevelopComponent(store, store.get(id), {
      ai: { kind: 'cli', complete: async () => 'function init(){ var x=2; /* MIGRATED */ return x; }' },
      applyVendoredUpdates: async () => ({ results: [{ name: 'lib', from: '1', to: '2', applied: true, file: 'js/script.js' }], backups: new Map() }), // echter Tausch → adopt; Fokus: Mock-Plugin-Code wird migriert
      runDetailed: async () => ({ ran: true, ok: true, scenarios: [{ scenario: 'A', status: 'passed' }] }),
      hasPlaywright: true,
    });
    expect(r.adopted).toBe(true);
    const mockCopy = fs.readFileSync(path.join(dir, '.maintenance', 'mock', 'plugin', 'script.js'), 'utf8');
    expect(mockCopy).toContain('MIGRATED');     // Mock-Kopie zeigt den migrierten Code
    expect(mockCopy).not.toContain('OLDCODE');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
