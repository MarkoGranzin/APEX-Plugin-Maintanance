import { describe, it, expect } from 'vitest';
import { WEB_DEV_PERSONA, buildRepairPrompt } from '../src/ai/personas.js';
import { securityScan, securityReview, qualityScan, qualityReview, reviewGate } from '../src/run/review.js';
import { autoUpdateArtifact } from '../src/run/update.js';
import { stubBackend } from '../src/ai/backend.js';

describe('T-28 Web-Dev-Persona', () => {
  it('Reparatur-Prompt enthält Persona + Befund + Einstiegspunkte', () => {
    const p = buildRepairPrompt({ logs: ['test rot: foo'] }, { artifact: 'w', entryPoints: ['init', 'refresh'], apexCalls: ['apex.item'] });
    expect(p).toContain('Web-Entwickler');
    expect(p).toContain('init, refresh');
    expect(p).toContain('test rot: foo');
  });
  it('Persona fordert schlank/sicher/keine losen Enden', () => {
    expect(WEB_DEV_PERSONA).toMatch(/schlank/i);
    expect(WEB_DEV_PERSONA).toMatch(/lose[n]? Enden/i);
    expect(WEB_DEV_PERSONA).toMatch(/innerHTML/);
    expect(WEB_DEV_PERSONA).toMatch(/eval/);
  });
});

describe('T-29 Security-Review (OWASP)', () => {
  it('XSS via innerHTML → Finding (hoch), Gate nicht grün', () => {
    const r = securityReview({ assets: [{ name: 'w.js', code: 'el.innerHTML = "<b>" + input + "</b>";' }] });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.rule === 'xss-innerHTML' && f.severity === 'high')).toBe(true);
  });
  it('eval/new Function → Code-Injektion', () => {
    expect(securityScan('eval(x)').some((f) => f.rule === 'code-injection-eval')).toBe(true);
    expect(securityScan('var f = new Function("a","return a")').some((f) => f.rule === 'code-injection-function')).toBe(true);
  });
  it('CVE-Lib aus dem SBOM blockiert das Gate', () => {
    const r = securityReview({ assets: [], cve: [{ lib: 'jquery', version: '3.4.1', vuln: 'CVE-2020-11022' }] });
    expect(r.pass).toBe(false);
    expect(r.blocking[0].rule).toBe('vulnerable-dependency');
  });
  it('hartkodiertes Secret → kritisch', () => {
    const r = securityReview({ assets: [{ name: 'c.js', code: 'const t = "ghp_abcdefghijklmnopqrstuvwx";' }] });
    expect(r.blocking.some((f) => f.severity === 'critical')).toBe(true);
  });
  it('saubere Änderung → Gate grün', () => {
    const r = securityReview({ assets: [{ name: 'ok.js', code: 'el.textContent = apex.util.escapeHTML(v);' }] });
    expect(r.pass).toBe(true);
  });
});

describe('T-30 Code-Qualitäts-Review', () => {
  it('lose Enden (TODO/debugger) → Finding, Gate nicht grün', () => {
    const r = qualityReview({ assets: [{ name: 'w.js', code: 'function f(){ debugger; return 1; } // TODO: aufräumen' }] });
    expect(r.pass).toBe(false);
    expect(r.findings.some((f) => f.rule.startsWith('loose-end'))).toBe(true);
  });
  it('unbenutzte Variable wird erkannt', () => {
    const f = qualityScan('function f(){ var ungenutzt = 1; return 2; }');
    expect(f.some((x) => x.rule === 'unused-variable')).toBe(true);
  });
  it('übermäßige Komplexität wird erkannt', () => {
    const body = Array.from({ length: 12 }, (_, i) => `if(a>${i}){}`).join(' ');
    const f = qualityScan(`function f(a){ ${body} return a; }`);
    expect(f.some((x) => x.rule === 'complexity')).toBe(true);
  });
  it('saubere, lesbare Änderung → Gate grün', () => {
    const r = qualityReview({ assets: [{ name: 'ok.js', code: 'function getValue(){ return apex.item("X").getValue(); }' }] });
    expect(r.pass).toBe(true);
  });
});

describe('T-31 Review-Gate-Orchestrierung', () => {
  const clean = { assets: [{ name: 'ok.js', code: 'function v(){ return apex.item("X").getValue(); }' }] };

  it('beide grün → approved', () => {
    const g = reviewGate(clean);
    expect(g.pass).toBe(true);
    expect(g.stage).toBe('approved');
  });
  it('Security-Block stoppt vor dem Code-Review', () => {
    const g = reviewGate({ assets: [{ name: 'x.js', code: 'el.innerHTML = a + b;' }] });
    expect(g.pass).toBe(false);
    expect(g.stage).toBe('security');
    expect(g.quality).toBeUndefined();
  });
  it('Code-Block nach grüner Security', () => {
    const g = reviewGate({ assets: [{ name: 'x.js', code: 'function f(){ debugger; return 1; }' }] });
    expect(g.stage).toBe('quality');
    expect(g.security.pass).toBe(true);
  });

  it('autoUpdate pusht nur bei grünem Review-Gate', async () => {
    const suite = { artifact: 'w', cases: [{ name: 't', fn: () => {} }] };
    let pushed = false;
    let rolledBack = false;
    const res = await autoUpdateArtifact({
      artifact: { name: 'w' },
      suite,
      applyUpdate: () => {},
      ai: stubBackend(),
      healApply: () => true,
      push: () => { pushed = true; return { prRef: 'PR' }; },
      rollback: () => { rolledBack = true; },
      review: async () => ({ pass: false, stage: 'security', security: { blocking: [{ rule: 'xss-innerHTML' }] } }),
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toMatch(/review-blockiert/);
    expect(pushed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it('autoUpdate pusht bei grünem Review-Gate', async () => {
    const suite = { artifact: 'w', cases: [{ name: 't', fn: () => {} }] };
    let pushed = false;
    const res = await autoUpdateArtifact({
      artifact: { name: 'w' },
      suite,
      applyUpdate: () => {},
      ai: stubBackend(),
      healApply: () => true,
      push: () => { pushed = true; return { prRef: 'PR' }; },
      review: async () => ({ pass: true, stage: 'approved' }),
    });
    expect(res.pushed).toBe(true);
    expect(pushed).toBe(true);
  });
});
