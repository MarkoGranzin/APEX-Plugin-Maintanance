import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visualComparePrompt, aiVisualCheck } from '../src/test/visual.js';

describe('T-104 optisches Gate: AI-UI-Prüfung „sieht aus wie zuvor"', () => {
  let before, after, dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
    before = path.join(dir, 'before.png'); after = path.join(dir, 'after.png');
    fs.writeFileSync(before, 'PNGDATA-before'); fs.writeFileSync(after, 'PNGDATA-after');
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('visualComparePrompt bindet beide Screenshot-Pfade + JSON-Vertrag ein', () => {
    const p = visualComparePrompt('/a/before.png', '/b/after.png');
    expect(p).toContain('/a/before.png');
    expect(p).toContain('/b/after.png');
    expect(p).toMatch(/looksSame/);
    expect(p).toMatch(/LOOKS LIKE BEFORE/i);
  });

  it('aiVisualCheck: KI sagt „sieht gleich aus" → ran:true, looksSame:true', async () => {
    const ai = { kind: 'cli', complete: async () => 'Here: {"looksSame": true, "issues": []}' };
    const r = await aiVisualCheck({ ai, before, after });
    expect(r).toMatchObject({ ran: true, looksSame: true });
  });

  it('aiVisualCheck: KI erkennt optischen Regress → ran:true, looksSame:false + issues', async () => {
    const ai = { kind: 'cli', complete: async () => '{"looksSame": false, "issues": ["columns collapsed", "cards unstyled"]}' };
    const r = await aiVisualCheck({ ai, before, after });
    expect(r.ran).toBe(true);
    expect(r.looksSame).toBe(false);
    expect(r.issues).toContain('columns collapsed');
  });

  it('aiVisualCheck: kein KI-Backend / fehlende Screenshots → ran:false (nicht still „grün")', async () => {
    expect((await aiVisualCheck({ ai: null, before, after })).ran).toBe(false);
    expect((await aiVisualCheck({ ai: { kind: 'stub' }, before, after })).ran).toBe(false);
    expect((await aiVisualCheck({ ai: { kind: 'cli', complete: async () => '{}' }, before: '/nope.png', after })).ran).toBe(false);
  });

  it('aiVisualCheck: unbrauchbare KI-Antwort → ran:false (kein Verdikt)', async () => {
    const ai = { kind: 'cli', complete: async () => 'I cannot tell.' };
    const r = await aiVisualCheck({ ai, before, after });
    expect(r.ran).toBe(false);
  });
});
