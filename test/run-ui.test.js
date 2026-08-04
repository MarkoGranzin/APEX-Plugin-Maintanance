import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUiTests, parsePlaywrightOutput } from '../src/test/run-ui.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const comp = (extra = {}) => ({ name: 'P', codedTests: [{ name: 'p.ui.spec.js', content: "import {test} from '@playwright/test';" }, { name: 'p.unit.test.js', content: '//' }], ...extra });

describe('T-73 runUiTests', () => {
  it('parsePlaywrightOutput zählt passed/failed', () => {
    expect(parsePlaywrightOutput('  3 passed (2s)')).toEqual({ passed: 3, failed: 0 });
    expect(parsePlaywrightOutput('1 failed\n2 passed')).toEqual({ passed: 2, failed: 1 });
  });

  it('führt aus und liefert Ergebnis (gestubbtes Playwright)', async () => {
    const exec = async (cmd, args, opts) => {
      expect(cmd).toBe('npx'); expect(args).toContain('playwright');
      expect(opts.env.PLUGIN_URL).toBe('http://x/test');
      return { code: 0, stdout: 'Running 2 tests\n  ✓ a\n  ✓ b\n\n  2 passed (1s)', stderr: '' };
    };
    const r = await runUiTests(comp(), { pluginUrl: 'http://x/test', specsDir: path.join(tmp, 'a'), hasPlaywright: true, exec });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(2);
    // nur die .ui.spec.js wird geschrieben
    expect(fs.existsSync(path.join(tmp, 'a', 'p.ui.spec.js'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'a', 'p.unit.test.js'))).toBe(false);
  });

  it('rotes Ergebnis bei Fehlern', async () => {
    const exec = async () => ({ code: 1, stdout: '  ✓ a\n  ✘ b\n\n  1 failed\n  1 passed', stderr: '' });
    const r = await runUiTests(comp(), { pluginUrl: 'http://x', specsDir: path.join(tmp, 'b'), hasPlaywright: true, exec });
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(1);
  });

  it('ohne Test-URL → ran:false mit Hinweis', async () => {
    const r = await runUiTests(comp(), { specsDir: path.join(tmp, 'c'), hasPlaywright: true });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/URL/);
  });

  it('ohne Playwright → ran:false mit Anleitung', async () => {
    const r = await runUiTests(comp(), { pluginUrl: 'http://x', specsDir: path.join(tmp, 'd'), hasPlaywright: false });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/Playwright not installed/);
  });

  it('ohne Specs → ran:false', async () => {
    const r = await runUiTests({ name: 'P', codedTests: [] }, { pluginUrl: 'http://x', specsDir: path.join(tmp, 'e'), hasPlaywright: true });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/coded UI tests/i);
  });
});
