import { describe, it, expect } from 'vitest';
import { lint, retireCheck, makeSnapshot, compareSnapshot, planArtifactTests } from '../src/test/static.js';

const bundle = (over = {}) => ({
  artifact: 'w',
  js: [{ name: 'w.js', code: 'apex.item("P1").getValue();' }],
  css: [],
  referencedUrls: [],
  ...over,
});

describe('T-23 Static-First je Artefakt', () => {
  it('jedes Artefakt bekommt Lint + retire + Snapshot im Plan', () => {
    const plan = planArtifactTests(bundle());
    expect(plan.static).toEqual(['lint', 'retire', 'snapshot']);
  });

  it('Lint meldet Parse-Fehler als error', () => {
    const r = lint(bundle({ js: [{ name: 'bad.js', code: 'function ( {' }] }));
    expect(r.ok).toBe(false);
    expect(r.findings[0].rule).toBe('parse');
  });

  it('Snapshot ist stabil und erkennt Änderungen (Golden-Master)', () => {
    const b1 = bundle();
    const snap = makeSnapshot(b1);
    // unveränderter Inhalt → kein Change
    expect(compareSnapshot(snap.hash, b1).changed).toBe(false);
    // geänderter Inhalt → Change
    const b2 = bundle({ js: [{ name: 'w.js', code: 'apex.item("P1").setValue(9);' }] });
    expect(compareSnapshot(snap.hash, b2).changed).toBe(true);
  });

  it('retire.js meldet bekannte Schwachstelle in vendored Lib', () => {
    const b = bundle({
      referencedUrls: [{ url: 'https://cdn/jquery-3.4.1.min.js', version: '3.4.1', kind: 'js' }],
    });
    const r = retireCheck(b);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ lib: 'jquery', version: '3.4.1', vuln: 'CVE-2020-11022' });
  });

  it('aktuelle Lib-Version ist sauber', () => {
    const b = bundle({ referencedUrls: [{ url: 'https://cdn/jquery-3.6.0.min.js', version: '3.6.0', kind: 'js' }] });
    expect(retireCheck(b).ok).toBe(true);
  });
});

describe('Verhaltenstests immer (es wird alles getestet)', () => {
  it('Static-First-Schritte immer geplant', () => {
    const plan = planArtifactTests(bundle());
    expect(plan.static).toEqual(['lint', 'retire', 'snapshot']);
  });

  it('Verhaltenstest immer mit gewählter Umgebung', () => {
    const plan = planArtifactTests(bundle());
    expect(plan.behavior).toHaveLength(1);
    expect(plan.behavior[0].env).toBe('jsdom'); // apex.item ist shim-abgedeckt
  });
});
