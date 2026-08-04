import { describe, it, expect } from 'vitest';
import { WORKSPACE_INFO_SQL, parseWorkspaceInfo, matchApp, detectApexTarget, pageRegisterResetPlan } from '../src/service/apex-detect.js';

const APPS = [
  { id: 100, name: 'Plugin Test' },
  { id: 105, name: 'teamworkonline.me' },
  { id: 200000, name: 'Demo Examples' },
];
const SQL_PAGE_TEXT = 'SQL Commands\nRun\nResults\nINFO\nAISPP|1234567890123456|WKSP_MEETUP|MEETUP\n1 row selected.';

const okDeps = (over = {}) => ({
  login: async () => ({ ok: true }),
  runSql: async (sql) => { expect(sql).toBe(WORKSPACE_INFO_SQL); return { ok: true, text: SQL_PAGE_TEXT }; },
  listApps: async () => APPS,
  ...over,
});

describe('T-165 apex-detect: IDs aus der Ziel-Instanz holen', () => {
  it('parseWorkspaceInfo liest den markierten String aus beliebigem Seitentext (markup-unabhängig)', () => {
    const i = parseWorkspaceInfo(SQL_PAGE_TEXT);
    expect(i).toMatchObject({ workspaceId: '1234567890123456', owner: 'WKSP_MEETUP', workspace: 'MEETUP' });
    expect(parseWorkspaceInfo('no marker here')).toBeNull();
    expect(parseWorkspaceInfo('')).toBeNull();
  });

  it('matchApp: ID exakt, Name case-insensitiv, eindeutiger Teilstring — uneindeutig/leer → null (keine Auto-Wahl)', () => {
    expect(matchApp(APPS, 100).id).toBe(100);
    expect(matchApp(APPS, '105').id).toBe(105);
    expect(matchApp(APPS, 'plugin test').id).toBe(100);
    expect(matchApp(APPS, 'teamwork').id).toBe(105); // eindeutiger Teilstring
    expect(matchApp(APPS, 'e')).toBeNull();          // mehrdeutig → Guardrail
    expect(matchApp(APPS, '')).toBeNull();
    expect(matchApp(APPS, 999)).toBeNull();
  });

  it('Happy path: Login → Workspace-Info → Apps → App per Hint aufgelöst', async () => {
    const r = await detectApexTarget({ baseUrl: 'https://x/ords', workspace: 'MEETUP', loginUser: 'u', pass: 'p', appHint: 'Plugin Test' }, okDeps());
    expect(r.ok).toBe(true);
    expect(r.workspaceId).toBe('1234567890123456');
    expect(r.owner).toBe('WKSP_MEETUP');
    expect(r.appId).toBe(100);
    expect(r.appName).toBe('Plugin Test');
    expect(r.needsAppChoice).toBe(false);
  });

  it('ohne eindeutigen App-Hint: workspaceId/owner trotzdem geliefert, Apps zur Auswahl, KEINE Auto-Wahl', async () => {
    const r = await detectApexTarget({ appHint: '' }, okDeps());
    expect(r.ok).toBe(true);
    expect(r.workspaceId).toBe('1234567890123456');
    expect(r.appId).toBeNull();
    expect(r.needsAppChoice).toBe(true);
    expect(r.apps).toHaveLength(3);
  });

  it('Login schlägt fehl → ehrlicher Fehler, kein SQL-Lauf', async () => {
    let sqlRan = false;
    const r = await detectApexTarget({}, okDeps({ login: async () => ({ ok: false, error: 'Login unsuccessful — check workspace/username/password.' }), runSql: async () => { sqlRan = true; return { ok: true, text: '' }; } }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Login/);
    expect(sqlRan).toBe(false);
  });

  it('SQL-Ergebnis nicht erkennbar → ehrlicher Fehler statt geratener Werte', async () => {
    const r = await detectApexTarget({}, okDeps({ runSql: async () => ({ ok: true, text: 'ORA-00942: table or view does not exist' }) }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not recognized/i);
  });

  it('pageRegisterResetPlan: nur bei ECHTEM App-Wechsel werden Register zurückgesetzt', () => {
    const comps = [
      { id: 'a', apexPageId: 20007 },
      { id: 'b', apexPageId: null },
      { id: 'c', apexPageId: 20001 },
    ];
    expect(pageRegisterResetPlan(comps, 200000, 200000).reset).toEqual([]); // gleiche App
    expect(pageRegisterResetPlan(comps, null, 100).reset).toEqual([]);      // vorher keine App → kein Wechsel
    expect(pageRegisterResetPlan(comps, 200000, null).reset).toEqual([]);   // keine neue App gewählt
    const plan = pageRegisterResetPlan(comps, 200000, 100);                 // echter Wechsel
    expect(plan.reset).toEqual(['a', 'c']);                                 // nur Komponenten MIT Register
    expect(plan.reason).toMatch(/200000 → 100/);
  });
});
