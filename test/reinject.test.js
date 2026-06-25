import { describe, it, expect } from 'vitest';
import { extractArtifact } from '../src/extract/extract.js';
import { reinjectAsset, replacePluginFileContent } from '../src/extract/reinject.js';

const B64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function memWriter(store) {
  return {
    readFile: (p) => store[p],
    writeFile: (p, c) => { store[p] = c; },
  };
}

describe('T-25 Round-Trip & Re-Injektion', () => {
  it('Round-Trip ist byte-identisch (extrahieren → unverändert re-injizieren)', () => {
    const original = `begin\nwwv_flow_api.create_plugin_file(p_file_name=>'w.js', p_file_content=>'${B64('console.log(1);')}');\nend;`;
    const store = { 'a.sql': original };
    const art = { name: 'a', sqlFiles: ['a.sql'] };
    const bundle = extractArtifact(art, { readFile: (p) => store[p] });
    const asset = bundle.js.find((j) => j.name === 'w.js');

    const res = reinjectAsset(bundle.sourceMap['w.js'], asset.code, memWriter(store));
    expect(res.written).toBe(true);
    expect(store['a.sql']).toBe(original); // byte-identisch
  });

  it('minimaler Diff: nur der betroffene create_plugin_file-Aufruf ändert sich', () => {
    const head = `begin\n-- wichtiger umgebender Code\nwwv_flow_api.create_plugin(p_id=>1);\n`;
    const callBefore = `wwv_flow_api.create_plugin_file(p_file_name=>'w.js', p_file_content=>'${B64('alt();')}');`;
    const tail = `\n-- nachgelagerter Code\nend;`;
    const original = head + callBefore + tail;
    const store = { 'a.sql': original };

    const newSql = replacePluginFileContent(original, 'w.js', B64('neu();'));
    store['a.sql'] = newSql;

    expect(newSql.startsWith(head)).toBe(true); // Kopf unverändert
    expect(newSql.endsWith(tail)).toBe(true); // Schwanz unverändert
    expect(newSql).toContain(B64('neu();'));
    expect(newSql).not.toContain(B64('alt();'));
  });

  it('lose Datei wird direkt überschrieben', () => {
    const store = { 'src/x.js': 'alt' };
    const res = reinjectAsset({ type: 'file', path: 'src/x.js' }, 'neu', memWriter(store));
    expect(res.written).toBe(true);
    expect(store['src/x.js']).toBe('neu');
  });

  it('extraktion-unsicher wird nicht zurückgeschrieben', () => {
    const store = { 'a.sql': 'irgendwas' };
    const res = reinjectAsset({ type: 'plugin_file', sqlFile: 'a.sql', fileName: 'w.js' }, 'neu', {
      ...memWriter(store),
      bundleStatus: 'extraktion-unsicher',
    });
    expect(res.written).toBe(false);
    expect(res.manualNeeded).toBe(true);
    expect(store['a.sql']).toBe('irgendwas'); // unverändert
  });

  it('geänderter Code landet base64-kodiert wieder im BLOB', () => {
    const original = `wwv_flow_api.create_plugin_file(p_file_name=>'w.js', p_file_content=>'${B64('old')}');`;
    const store = { 'a.sql': original };
    reinjectAsset({ type: 'plugin_file', sqlFile: 'a.sql', fileName: 'w.js' }, 'brandneu', memWriter(store));
    expect(store['a.sql']).toContain(B64('brandneu'));
  });
});
