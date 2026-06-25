import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoFixComponent, quickFix } from '../src/service/autofix.js';
import { createComponentStore } from '../src/gui/store.js';

describe('T-61 Auto-Fix', () => {
  let dir, store, id;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), 'function f(){ console.log("x"); debugger; return 1; }\n');
    store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: dir, libs: [{ name: 'jquery', version: '3.4.1', status: 'verwundbar' }] });
    id = 'c1';
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('quickFix entfernt console.log und debugger, bleibt gültig', () => {
    const out = quickFix('function f(){ console.log(1); debugger; return 2; }');
    expect(out).not.toMatch(/console\.log/);
    expect(out).not.toMatch(/debugger/);
  });

  it('deterministische Fixes ohne KI + Lib-Update + Rest gemeldet; alles im Protokoll', async () => {
    let updated = null;
    const update = async (_s, c) => { updated = c.name; return { summary: 'jquery 3.4.1 → 3.7.1 (PR)' }; };
    const r = await autoFixComponent(store, store.get(id), { ai: { kind: 'stub' }, update });

    // Quick-Fix hat die Datei bereinigt
    const code = fs.readFileSync(path.join(dir, 'js', 'widget.js'), 'utf8');
    expect(code).not.toMatch(/console\.log/);
    expect(code).not.toMatch(/debugger/);
    expect(r.quickFixes).toBeGreaterThanOrEqual(1);

    // Lib-Update wurde ausgelöst
    expect(updated).toBe('P');
    expect(r.libUpdate.summary).toMatch(/3.7.1/);

    // Protokoll enthält alle drei Stufen
    const log = store.get(id).lastLog.entries;
    expect(log.some((e) => e.agent === 'Quick-Fix' && /entfernt/.test(e.result))).toBe(true);
    expect(log.some((e) => e.agent === 'Lib-Update' && /Update ausgelöst/.test(e.result))).toBe(true);
    expect(log.some((e) => e.agent === 'Auto-Fix' && /KI-Backend/.test(e.result))).toBe(true);
  });

  it('ohne Repo → klarer Fehler', async () => {
    store.update(id, { path: '' });
    const r = await autoFixComponent(store, store.get(id), { ai: { kind: 'stub' } });
    expect(r.error).toMatch(/Repo/);
  });
});
