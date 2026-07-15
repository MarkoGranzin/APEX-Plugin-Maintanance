import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mask } from '../src/config/secrets.js';
import { resolveWithin, reinjectAsset } from '../src/extract/reinject.js';
import { findRepoSource } from '../mcp-apex-deploy/lib/plugin-assets.js';
import { buildInstallScript } from '../mcp-apex-deploy/lib/apex.js';
import { assertSafeEndpoint } from '../src/ai/backend.js';
import { isNonRuntimeAsset, autoFixComponent } from '../src/service/autofix.js';
import { scanSpecSafety, runUiTests } from '../src/test/run-ui.js';
import { createComponentStore } from '../src/gui/store.js';

describe('Security-Review-Fixes', () => {
  it('B-42: kurze Secrets werden vollständig maskiert (kein Head/Tail-Reveal)', () => {
    expect(mask('geheim')).toBe('****');        // 6 Zeichen → nichts sichtbar
    expect(mask('1234567')).toBe('****');       // 7 Zeichen (früher voll enthüllt)
    // lange Secrets weiterhin mit Head/Tail (kleiner Bruchteil)
    expect(mask('ghp_abcdefgh1234')).toMatch(/^ghp\*+1234$/);
  });

  it('B-43: resolveWithin verweigert Ausbruch aus rootDir', () => {
    const root = os.tmpdir();
    expect(() => resolveWithin(root, '../evil.js')).toThrow(/leaves/);
    expect(() => resolveWithin(root, '..')).toThrow(/leaves/);
    // absoluter Pfad auf anderem Laufwerk / Root
    expect(() => resolveWithin(root, process.platform === 'win32' ? 'Z:\\evil' : '/etc/passwd')).toThrow(/leaves/);
    // legitimer relativer Pfad bleibt erlaubt
    expect(() => resolveWithin(root, 'sub/dir/file.js')).not.toThrow();
  });

  it('B-43: reinjectAsset schreibt nicht außerhalb des Repos (Default-FS)', () => {
    expect(() => reinjectAsset({ type: 'file', path: '../../evil.js' }, 'x', { rootDir: os.tmpdir() })).toThrow(/leaves/);
  });

  it('B-68: Symlink im Repo, der nach außen zeigt, wird als Ausbruch erkannt (realpath)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b68-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'b68-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    let linked = false;
    try { fs.symlinkSync(outside, path.join(root, 'evil'), 'dir'); linked = true; } catch { /* Windows ohne Dev-Mode → Symlink nicht erstellbar */ }
    if (!linked) { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); return; }
    // lexisch wirkt 'evil/secret.txt' im Repo, real zeigt es nach außen → muss werfen
    expect(() => resolveWithin(root, 'evil/secret.txt')).toThrow(/verlässt/);
    expect(() => resolveWithin(root, 'inside/x.js')).not.toThrow(); // echter Pfad im Repo bleibt erlaubt
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  });

  it('B-50: findRepoSource ignoriert Traversal-Namen aus fremdem Plugin-SQL', () => {
    const deps = { exists: () => true, walk: () => [] };
    // ../ oder absoluter Name → NICHT der ausbrechende Pfad, sondern null (nichts Eindeutiges)
    expect(findRepoSource('/repo', '../../secret.js', deps)).toBeNull();
    // legitimer eingebetteter Pfad wird aufgelöst
    expect(findRepoSource('/repo', 'js/flipcard.min.js', deps)).toBe('js/flipcard.min.js');
  });

  it('B-49: buildInstallScript lehnt exportFile mit Quote/Zeilenumbruch ab', () => {
    expect(() => buildInstallScript({ exportFile: 'a" \n@/etc/evil.sql "', workspace: 'W' })).toThrow(/disallowed/);
    const script = buildInstallScript({ exportFile: '/tmp/x.sql', workspace: 'W' });
    expect(script).toContain('@"/tmp/x.sql"');
  });

  it('B-41: assertSafeEndpoint erzwingt gültige https-URL (localhost darf http)', () => {
    expect(() => assertSafeEndpoint('http://evil.example.com/v1')).toThrow(/https/);
    expect(() => assertSafeEndpoint('not-a-url')).toThrow(/URL/);
    expect(() => assertSafeEndpoint('https://api.provider.com/v1')).not.toThrow();
    expect(() => assertSafeEndpoint('http://localhost:11434/api')).not.toThrow();
  });

  it('B-39: Quick-Fix erkennt Build-Tooling & Demo/Daten als Nicht-Laufzeit', () => {
    expect(isNonRuntimeAsset({ origin: { type: 'file', path: 'gulpfile.js' } })).toBe(true);
    expect(isNonRuntimeAsset({ origin: { type: 'file', path: 'data/demo.js' } })).toBe(true);
    expect(isNonRuntimeAsset({ origin: { type: 'file', path: 'examples/sample/x.js' } })).toBe(true);
    expect(isNonRuntimeAsset({ origin: { type: 'file', path: 'vite.config.js' } })).toBe(true);
    // echtes Plugin-Asset bleibt fixbar
    expect(isNonRuntimeAsset({ origin: { type: 'file', path: 'js/widget.js' } })).toBe(false);
    expect(isNonRuntimeAsset({ name: 'render.js', origin: { type: 'plugin_file', sqlFile: 'plugin.sql', fileName: 'render.js' } })).toBe(false);
  });

  it('B-39: Quick-Fix lässt gulpfile.js & data/*.js unberührt, fixt aber js/widget.js', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b39-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const gulp = 'const x = require("gulp"); console.log("build");\n';
    const demo = 'export const rows = [1,2]; console.log("demo");\n';
    const widget = 'function f(){ console.log("x"); return 1; }\n';
    fs.writeFileSync(path.join(dir, 'gulpfile.js'), gulp);
    fs.writeFileSync(path.join(dir, 'data', 'demo.js'), demo);
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), widget);
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'P', path: dir, libs: [] });
    await autoFixComponent(store, store.get('c1'), { ai: { kind: 'stub' } });
    expect(fs.readFileSync(path.join(dir, 'gulpfile.js'), 'utf8')).toBe(gulp);            // unverändert
    expect(fs.readFileSync(path.join(dir, 'data', 'demo.js'), 'utf8')).toBe(demo);        // unverändert
    expect(fs.readFileSync(path.join(dir, 'js', 'widget.js'), 'utf8')).not.toMatch(/console\.log/); // gefixt
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('B-48: scanSpecSafety blockt gefährliche Konstrukte, erlaubt reine Playwright-Specs', () => {
    const good = "import { test, expect } from '@playwright/test';\nconst URL = process.env.PLUGIN_URL;\ntest('x', async ({ page }) => { await page.goto(URL); });";
    expect(scanSpecSafety(good).safe).toBe(true);
    expect(scanSpecSafety("import cp from 'node:child_process'; cp.execSync('rm -rf /')").safe).toBe(false);
    expect(scanSpecSafety("const fs = require('fs'); fs.unlink('/x')").safe).toBe(false);
    expect(scanSpecSafety("eval('process.exit(1)')").safe).toBe(false);
    expect(scanSpecSafety("const m = await import('child_process')").safe).toBe(false);
  });

  it('B-48: runUiTests führt unsichere Specs NICHT aus', async () => {
    let execCalled = false;
    const component = { uiTestUrl: 'http://x/mock', codedTests: [{ name: 'evil.ui.spec.js', content: "require('child_process').execSync('whoami')" }] };
    const r = await runUiTests(component, { specsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b48-')), hasPlaywright: true, exec: async () => { execCalled = true; return { code: 0, stdout: '', stderr: '' }; } });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/blocked by the safety check/);
    expect(execCalled).toBe(false); // nie ausgeführt
  });
});
