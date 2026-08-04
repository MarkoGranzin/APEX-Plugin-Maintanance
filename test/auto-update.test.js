import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planLibUpdates, autoUpdateComponent } from '../src/service/update-component.js';
import { createComponentStore } from '../src/gui/store.js';
import { createPrRegistry, recordPr, branchKey, PR_STATE } from '../src/run/dedup.js';

let dir, store, comp;
const SQL = (v) => `begin\nwwv_flow_api.create_plugin(p_id=>1,p_name=>'CP', p_file_urls=>'https://cdn.example.com/jquery-${v}.min.js');\nend;`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-upd-'));
  fs.writeFileSync(path.join(dir, 'cp.sql'), SQL('3.4.1'));
  store = createComponentStore({ now: () => '2026-06-24T00:00:00Z', idGen: () => 'c1' });
  comp = store.add({ name: 'apex-colorpicker', path: dir, status: 'handlungsbedarf' });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('T-40 planLibUpdates', () => {
  it('plant Bump verwundbarer referenzierter Lib (jquery 3.4.1 → 3.5.0)', () => {
    const plans = planLibUpdates(dir);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ lib: 'jquery', from: '3.4.1', to: '3.5.0', file: 'cp.sql' });
    expect(plans[0].newUrl).toContain('jquery-3.5.0');
  });
});

describe('T-40 autoUpdateComponent', () => {
  it('Update grün → Datei gebumpt, PR gepusht, Store aktualisiert', async () => {
    const pushed = [];
    const res = await autoUpdateComponent(store, comp, { push: async (x) => { pushed.push(x); return { branch: x.branch }; } });
    expect(res.results[0].pushed).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'cp.sql'), 'utf8')).toContain('jquery-3.5.0');
    expect(pushed[0].branch).toBe(branchKey('apex-colorpicker', 'jquery', '3.5.0'));
    const after = store.get('c1');
    expect(after.lastChange.summary).toMatch(/update/i);
    expect(after.status).toBe('pr-offen');
    expect(after.reviews).toHaveLength(1);
  });

  it('Review-Block → kein Push, Datei zurückgerollt', async () => {
    let pushedCalled = false;
    const res = await autoUpdateComponent(store, comp, {
      reviewGate: () => ({ pass: false, stage: 'security' }),
      push: async () => { pushedCalled = true; return {}; },
    });
    expect(res.results[0].reviewBlocked).toBe(true);
    expect(pushedCalled).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'cp.sql'), 'utf8')).toContain('jquery-3.4.1'); // zurückgerollt
    expect(store.get('c1').status).toBe('review-blockiert');
  });

  it('kein zweiter PR für dieselbe Aktualisierung (Dedup)', async () => {
    const registry = createPrRegistry();
    recordPr(registry, branchKey('apex-colorpicker', 'jquery', '3.5.0'), PR_STATE.OPEN, 'PR-1');
    let pushedCalled = false;
    const res = await autoUpdateComponent(store, comp, { registry, push: async () => { pushedCalled = true; return {}; } });
    expect(res.results[0].pushed).toBe(false);
    expect(pushedCalled).toBe(false);
  });

  it('keine verwundbaren Libs → keine Updates', async () => {
    fs.writeFileSync(path.join(dir, 'cp.sql'), SQL('3.7.1'));
    const res = await autoUpdateComponent(store, comp, { push: async () => ({}) });
    expect(res.plans).toBe(0);
    expect(res.summary).toMatch(/no automatic updates/);
  });
});
