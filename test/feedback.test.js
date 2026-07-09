import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveFeedback, buildFeedbackTestPrompt, createFeedbackTest } from '../src/service/feedback.js';
import { runComponentOnce } from '../src/service/run-component.js';
import { createComponentStore } from '../src/gui/store.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'); // PNG-Header als Mini-Bild
const SPEC = `const { test, expect } = require('@playwright/test');\ntest('Karte bleibt in der Zielspalte', async ({ page }) => {\n  await page.goto(process.env.PLUGIN_URL);\n  await expect(page.locator('.card')).toBeVisible();\n});`;
const mkStore = () => createComponentStore({ now: () => '2026-07-09T12:00:00Z', idGen: (() => { let n = 0; return () => `c${++n}`; })() });

describe('T-147 Fehler-Report → Regressionstest → Rework', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisp-fb-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ } });

  it('saveFeedback: schreibt report.md + Screenshots ins Repo (.maintenance/feedback/<stamp>)', () => {
    const fb = saveFeedback(dir, { text: 'Drag&Drop kaputt', images: [{ name: 'shot-1.png', data: PNG }] }, { now: () => '2026-07-09T12:00:00Z' });
    expect(fb.error).toBeUndefined();
    expect(fs.readFileSync(fb.reportPath, 'utf8')).toContain('Drag&Drop kaputt');
    expect(fs.existsSync(fb.imagePaths[0])).toBe(true);
    expect(fb.imagePaths[0]).toContain('.maintenance');
  });

  it('saveFeedback: lehnt Traversal/fremde Endung/leeren Text/leeres Bild ab', () => {
    expect(saveFeedback(dir, { text: '' }).error).toMatch(/Fehlerbeschreibung/);
    expect(saveFeedback(dir, { text: 'x', images: [{ name: '../evil.png', data: PNG }] }).error).toMatch(/Screenshot-Name/);
    expect(saveFeedback(dir, { text: 'x', images: [{ name: 'x.exe', data: PNG }] }).error).toMatch(/Screenshot-Name/);
    expect(saveFeedback(dir, { text: 'x', images: [{ name: 'x.png', data: '' }] }).error).toMatch(/leer/);
  });

  it('Prompt enthält Report-Text, Screenshot-Pfade und vorhandene Spec-Namen (keine Duplikate)', () => {
    const p = buildFeedbackTestPrompt('Kanban', { text: 'Karten springen zurück', imagePaths: ['/repo/.maintenance/feedback/x/shot.png'] }, { mockUrl: 'http://x/mock', existing: ['a.ui.spec.js'] });
    expect(p).toContain('Karten springen zurück');
    expect(p).toContain('shot.png');
    expect(p).toContain('a.ui.spec.js');
    expect(p).toMatch(/FAIL while the reported bug exists/);
  });

  it('createFeedbackTest: Spec wird ins Repo geschrieben, in codedTests übernommen + Notiz angelegt', async () => {
    const store = mkStore();
    const c = store.add({ name: 'Kanban', path: dir, codedTests: [{ name: 'a.ui.spec.js', content: 'x' }] });
    const fb = { text: 'Drag&Drop kaputt', stamp: '20260709120000', imagePaths: [] };
    const r = await createFeedbackTest(store, store.get(c.id), fb, { ai: { kind: 'cli', complete: async () => '```js\n' + SPEC + '\n```' } });
    expect(r.ok).toBe(true);
    expect(r.spec.name).toBe('feedback-20260709120000.ui.spec.js');
    expect(fs.existsSync(path.join(dir, '.maintenance', 'tests', r.spec.name))).toBe(true); // im Repo (mitversioniert)
    const cur = store.get(c.id);
    expect(cur.codedTests.map((t) => t.name)).toContain(r.spec.name); // läuft ab jetzt mit
    expect(cur.notes.some((n) => n.kind === 'feedback')).toBe(true);
  });

  it('createFeedbackTest: Müll-Antwort oder Stub-Backend → ehrlicher Fehler, nichts persistiert', async () => {
    const store = mkStore();
    const c = store.add({ name: 'K', path: dir });
    const fb = { text: 'x', stamp: 's', imagePaths: [] };
    expect((await createFeedbackTest(store, store.get(c.id), fb, { ai: { kind: 'cli', complete: async () => 'keine ahnung' } })).error).toMatch(/brauchbaren/);
    expect((await createFeedbackTest(store, store.get(c.id), fb, { ai: { kind: 'stub', complete: async () => SPEC } })).error).toMatch(/KI-Backend/);
    expect(store.get(c.id).codedTests ?? []).toHaveLength(0);
  });

  it('feedback-Tests überleben das Neu-Erzeugen der Testplan-Baseline (dauerhaft mitgepflegt)', () => {
    const store = mkStore();
    const c = store.add({ name: 'K', path: dir, codedTests: [{ name: 'feedback-1.ui.spec.js', content: 'f' }, { name: 'alt.ui.spec.js', content: 'a' }] });
    const scan = () => ({ artifacts: [{ status: 'ok' }], outdated: [], risks: [], failures: [], libs: [], testPlan: 'neu', codedTests: [{ name: 'neu.ui.spec.js', content: 'n' }] });
    runComponentOnce(store, store.get(c.id), { scan, now: () => 't1', regenerateTestPlan: true });
    const names = store.get(c.id).codedTests.map((t) => t.name);
    expect(names).toContain('neu.ui.spec.js');        // neue Baseline da
    expect(names).toContain('feedback-1.ui.spec.js'); // Feedback-Regressionstest bleibt
    expect(names).not.toContain('alt.ui.spec.js');    // alte generierte Baseline ersetzt
  });
});
