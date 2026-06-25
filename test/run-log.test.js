import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/service/run-repo.js';
import { runComponentOnce, formatLog } from '../src/service/run-component.js';
import { createComponentStore } from '../src/gui/store.js';

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-log-'));
  const w = (rel, c) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  w('colorpicker/colorpicker.sql', `begin\nwwv_flow_api.create_plugin(p_id=>1,p_name=>'CP', p_file_urls=>'https://cdn.example.com/jquery-3.4.1.min.js');\nend;`);
  w('slider/slider.js', `(function(){ function init(){ apex.item('P1').setValue(1); } window.s=init; })();`);
  w('slider/slider.css', `.s{}`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('T-44 Protokoll im Scan', () => {
  it('erzeugt Agent/Datei-Einträge inkl. Erkennung', () => {
    const res = scanRepo(dir);
    expect(Array.isArray(res.log)).toBe(true);
    expect(res.log.some((e) => e.agent === 'Erkennung' && e.file && e.result)).toBe(true);
    expect(res.log.some((e) => e.agent === 'Snapshot')).toBe(true);
  });

  it('Schwachstelle erscheint mit retire.js-Agent', () => {
    const res = scanRepo(dir);
    const r = res.log.find((e) => e.agent === 'retire.js');
    expect(r).toBeTruthy();
    expect(r.file).toBe('jquery');
    expect(r.result).toMatch(/verwundbar/);
  });

  it('AST-Agent protokolliert Einstiegspunkte für JS', () => {
    const res = scanRepo(dir);
    expect(res.log.some((e) => e.agent === 'AST' && e.file === 'slider.js')).toBe(true);
  });
});

describe('T-44 lastLog + T-45 logSink/Format', () => {
  it('runComponentOnce persistiert lastLog und ruft logSink', () => {
    const store = createComponentStore({ now: () => '2026-06-24T00:00:00Z', idGen: () => 'c1' });
    const c = store.add({ name: 'apex-colorpicker', path: dir });
    let sinkText = null;
    runComponentOnce(store, c, { scan: scanRepo, now: () => '2026-06-24T00:00:00Z', logSink: (_comp, text) => { sinkText = text; } });

    const after = store.get('c1');
    expect(after.lastLog).toMatchObject({ at: '2026-06-24T00:00:00Z' });
    expect(after.lastLog.entries.length).toBeGreaterThan(0);
    expect(sinkText).toContain('[retire.js]');
    expect(sinkText).toContain('Prüfprotokoll');
  });

  it('formatLog rendert Agent → Datei → Ergebnis', () => {
    const txt = formatLog({ name: 'X' }, { at: 't', entries: [{ agent: 'Lint', file: 'a.js', result: 'ok' }] });
    expect(txt).toContain('[Lint] a.js → ok');
  });
});
