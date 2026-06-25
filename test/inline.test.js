import { describe, it, expect } from 'vitest';
import { extractInlineJs } from '../src/extract/inline.js';
import { extractArtifact } from '../src/extract/extract.js';
import { reinjectAsset } from '../src/extract/reinject.js';

const reader = (map) => (p) => map[p];

describe('T-20 Inline-JS Extraktion', () => {
  it('add_inline_code-Literal → JS extrahiert + sourceMap auf die SQL-Stelle', () => {
    const sql = `begin\napex_javascript.add_inline_code(p_code => 'var x = 1; foo();');\nend;`;
    const { inline } = extractInlineJs(sql, 'r.sql');
    expect(inline).toHaveLength(1);
    expect(inline[0].code).toBe('var x = 1; foo();');
    expect(inline[0].origin).toMatchObject({ type: 'inline', call: 'add_inline_code', sqlFile: 'r.sql' });
    // Offsets zeigen exakt auf das Literal
    expect(sql.slice(inline[0].origin.absStart, inline[0].origin.absEnd)).toBe(`'var x = 1; foo();'`);
  });

  it("htp.p('<script>…</script>') → JS ohne Tags, Wrapper gemerkt", () => {
    const sql = `htp.p('<script>alert(1);</script>');`;
    const { inline } = extractInlineJs(sql, 'r.sql');
    expect(inline[0].code).toBe('alert(1);');
    expect(inline[0].origin.wrap).toEqual({ pre: '<script>', post: '</script>' });
  });

  it('htp.p ohne <script> ist HTML → kein Inline-JS', () => {
    const { inline } = extractInlineJs(`htp.p('<div>nur html</div>');`, 'r.sql');
    expect(inline).toHaveLength(0);
  });

  it('Konkatenation von Literalen wird zusammengefügt', () => {
    const sql = `apex_javascript.add_inline_code(p_code => 'var a=' || '42' || ';');`;
    const { inline } = extractInlineJs(sql, 'r.sql');
    expect(inline[0].code).toBe('var a=42;');
  });

  it('dynamisch zusammengesetztes JS wird NICHT geraten, sondern als unsicher markiert', () => {
    const sql = `apex_javascript.add_inline_code(p_code => 'var v=' || l_value || ';');`;
    const { inline, unsafe } = extractInlineJs(sql, 'r.sql');
    expect(inline).toHaveLength(0);
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0].reason).toMatch(/dynamisch/);
  });
});

describe('T-20 Integration ins kanonische Bündel', () => {
  it('extractArtifact füllt inlineCode + sourceMap', () => {
    const sql = `apex_javascript.add_inline_code(p_code => 'init();');`;
    const bundle = extractArtifact({ name: 'w', sqlFiles: ['w.sql'] }, { readFile: reader({ 'w.sql': sql }) });
    expect(bundle.inlineCode).toHaveLength(1);
    expect(bundle.inlineCode[0].code).toBe('init();');
    const name = bundle.inlineCode[0].name;
    expect(bundle.sourceMap[name].type).toBe('inline');
  });
});

describe('T-20 Re-Injektion inline (Round-Trip)', () => {
  it('extrahieren → unverändert re-injizieren ⇒ byte-identisch (add_inline_code)', () => {
    const original = `begin\napex_javascript.add_inline_code(p_code => 'var x=1;');\nend;`;
    const store = { 'w.sql': original };
    const bundle = extractArtifact({ name: 'w', sqlFiles: ['w.sql'] }, { readFile: (p) => store[p] });
    const asset = bundle.inlineCode[0];
    const res = reinjectAsset(bundle.sourceMap[asset.name], asset.code, { readFile: (p) => store[p], writeFile: (p, c) => { store[p] = c; } });
    expect(res.written).toBe(true);
    expect(store['w.sql']).toBe(original);
  });

  it('Round-Trip mit <script>-Wrapper bleibt byte-identisch', () => {
    const original = `htp.p('<script>doStuff();</script>');`;
    const store = { 'a.sql': original };
    const bundle = extractArtifact({ name: 'a', sqlFiles: ['a.sql'] }, { readFile: (p) => store[p] });
    const asset = bundle.inlineCode[0];
    reinjectAsset(bundle.sourceMap[asset.name], asset.code, { readFile: (p) => store[p], writeFile: (p, c) => { store[p] = c; } });
    expect(store['a.sql']).toBe(original);
  });

  it('geänderter Inline-Code landet an der exakten Stelle, Rest des SQL unverändert', () => {
    const original = `begin\n-- davor\napex_javascript.add_inline_code(p_code => 'alt();');\n-- danach\nend;`;
    const store = { 'w.sql': original };
    const bundle = extractArtifact({ name: 'w', sqlFiles: ['w.sql'] }, { readFile: (p) => store[p] });
    const asset = bundle.inlineCode[0];
    reinjectAsset(bundle.sourceMap[asset.name], 'neu();', { readFile: (p) => store[p], writeFile: (p, c) => { store[p] = c; } });
    expect(store['w.sql']).toContain(`'neu();'`);
    expect(store['w.sql']).not.toContain(`'alt();'`);
    expect(store['w.sql'].startsWith('begin\n-- davor\n')).toBe(true);
    expect(store['w.sql'].endsWith('-- danach\nend;')).toBe(true);
  });
});
