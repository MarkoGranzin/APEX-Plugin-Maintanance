import { describe, it, expect } from 'vitest';
import { parseGulpBundles, buildContentBlock, reembedFile, embeddedFileNames, rebuildEmbeddedBundles, resolveSources, detectEmbeddedAssets, reembedFromAssets } from '../src/service/plugin-bundle.js';
import { reembedBundles } from '../src/service/lib-update.js';

// Minimaler APEX-Export mit EINER eingebetteten Datei (414243 = "ABC").
const EXPORT = [
  'begin',
  'wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;',
  "wwv_flow_api.g_varchar2_table(1) := '414243';",
  'end;',
  '/',
  'begin',
  'wwv_flow_api.create_plugin_file(',
  ' p_id=>wwv_flow_api.id(1)',
  ",p_file_name=>'bundle.js'",
  ',p_file_content=>wwv_flow_api.varchar2_to_blob(wwv_flow_api.g_varchar2_table)',
  ');',
  'end;',
  '/',
].join('\n');

/** Dekodiert den eingebetteten HEX-Content einer Datei zurück (Testspiegel des Einbettens). */
function decode(sql, fileName) {
  const fi = sql.indexOf(`,p_file_name=>'${fileName}'`);
  const createBegin = sql.lastIndexOf('begin', sql.lastIndexOf('wwv_flow_api.create_plugin_file(', fi));
  const reset = sql.lastIndexOf('empty_varchar2_table;', createBegin);
  const block = sql.slice(sql.lastIndexOf('begin', reset), createBegin);
  const hex = [...block.matchAll(/g_varchar2_table\(\d+\) := '([0-9A-Fa-f]*)'/g)].map((m) => m[1]).join('');
  return Buffer.from(hex, 'hex').toString('utf8');
}

describe('B-40 plugin-bundle: gulp-Bundles neu bauen + in die .sql re-embedden', () => {
  it('parseGulpBundles liest src-Listen + concat-Namen (auch concat({path}))', () => {
    const gulp = `
      function a(){ return gulp.src(['./js/lib/x.js','./js/lib/y.js']).pipe(concat('out.js')).pipe(gulp.dest('./build/')); }
      function b(){ return gulp.src('./css/*.css').pipe(concat({ path: 'out.css' })).pipe(gulp.dest('./build/')); }`;
    expect(parseGulpBundles(gulp)).toEqual([
      { bundle: 'out.js', sources: ['./js/lib/x.js', './js/lib/y.js'] },
      { bundle: 'out.css', sources: ['./css/*.css'] },
    ]);
  });

  it('buildContentBlock: HEX-Chunks à 100 Bytes, gültiger begin/end-Block', () => {
    const blk = buildContentBlock(Buffer.from('ABC'));
    expect(blk).toContain('wwv_flow_api.g_varchar2_table := wwv_flow_api.empty_varchar2_table;');
    expect(blk).toContain("wwv_flow_api.g_varchar2_table(1) := '414243';");
    expect(blk.trimEnd().endsWith('/')).toBe(true);
    // >100 Bytes → mehrere Chunks
    const big = buildContentBlock(Buffer.alloc(250, 0x41));
    expect((big.match(/g_varchar2_table\(\d+\) :=/g) || []).length).toBe(3);
  });

  it('reembedFile: ersetzt den Content bit-genau (round-trip decode)', () => {
    expect(decode(EXPORT, 'bundle.js')).toBe('ABC');
    const r = reembedFile(EXPORT, 'bundle.js', Buffer.from('XYZ-neu'));
    expect(r.ok).toBe(true);
    expect(decode(r.sql, 'bundle.js')).toBe('XYZ-neu');
    // Struktur bleibt: genau ein create_plugin_file für die Datei
    expect((r.sql.match(/create_plugin_file\(/g) || []).length).toBe(1);
  });

  it('reembedFile: unbekannte Datei → ok:false, .sql unverändert', () => {
    const r = reembedFile(EXPORT, 'gibtsnicht.js', Buffer.from('x'));
    expect(r.ok).toBe(false);
  });

  it('embeddedFileNames listet die eingebetteten Dateien', () => {
    expect(embeddedFileNames(EXPORT)).toEqual(['bundle.js']);
  });

  it('rebuildEmbeddedBundles: baut nur eingebettete Bundles neu (skippt den Rest)', () => {
    const gulp = `gulp.src(['./js/lib/a.js','./js/lib/b.js']).pipe(concat('bundle.js'));
                  gulp.src(['./js/lib/c.js']).pipe(concat('nicht-eingebettet.js'));`;
    const deps = {
      exists: () => true,
      readText: () => gulp,
      readBuf: (f) => Buffer.from(f.endsWith('a.js') ? 'AA' : f.endsWith('b.js') ? 'BB' : 'CC'),
    };
    const r = rebuildEmbeddedBundles({ repoDir: '/repo', exportSql: EXPORT }, deps);
    // Nur die EINGEBETTETE Datei (bundle.js) ist relevant; 'nicht-eingebettet.js' taucht nicht auf.
    expect(r.updated.map((u) => u.bundle)).toEqual(['bundle.js']);
    expect(decode(r.sql, 'bundle.js')).toBe('AA\nBB'); // concat mit \n
  });

  it('detectEmbeddedAssets: bundle (gulp) vs copy (Repo-Datei) vs unknown', () => {
    const gulp = `gulp.src(['./js/lib/a.js']).pipe(concat('bundle.js'));`;
    // EXPORT bettet nur 'bundle.js' ein → als bundle erkannt (gulpfile vorhanden)
    const a1 = detectEmbeddedAssets(EXPORT, '/repo', { exists: (f) => f.endsWith('gulpfile.js'), readText: () => gulp });
    expect(a1).toEqual([{ file: 'bundle.js', build: 'bundle', sources: ['./js/lib/a.js'] }]);
    // ohne gulpfile, aber Repo-Datei gleichen Namens → copy
    const a2 = detectEmbeddedAssets(EXPORT, '/repo', { exists: (f) => f.endsWith('bundle.js'), readText: () => '' });
    expect(a2).toEqual([{ file: 'bundle.js', build: 'copy', sources: ['bundle.js'] }]);
    // weder Bundle noch Repo-Datei → unknown
    const a3 = detectEmbeddedAssets(EXPORT, '/repo', { exists: () => false, readText: () => '', walk: () => [] });
    expect(a3).toEqual([{ file: 'bundle.js', build: 'unknown', sources: [] }]);
  });

  it('reembedFromAssets: nur bei realer Inhaltsänderung ersetzen (content-diff)', () => {
    // copy, Repo-Inhalt = eingebettet ("ABC") → skip 'unverändert'
    const same = reembedFromAssets(EXPORT, [{ file: 'bundle.js', build: 'copy', sources: ['bundle.js'] }], '/repo', { readBuf: () => Buffer.from('ABC') });
    expect(same.updated).toEqual([]);
    expect(same.skipped[0].reason).toBe('unverändert');
    // geänderter Inhalt → ersetzt
    const diff = reembedFromAssets(EXPORT, [{ file: 'bundle.js', build: 'copy', sources: ['bundle.js'] }], '/repo', { readBuf: () => Buffer.from('NEU') });
    expect(diff.updated).toEqual([{ file: 'bundle.js', bytes: 3 }]);
    expect(decode(diff.sql, 'bundle.js')).toBe('NEU');
  });

  it('reembedBundles (lib-update): keine Export-.sql → null (kein Re-Embed erzwungen)', () => {
    const r = reembedBundles('/repo', new Map(), { exists: () => false, findExport: () => null });
    expect(r).toBeNull();
  });

  it('reembedBundles: gulpfile + eingebettete .sql → schreibt aktualisierte .sql + Backup', () => {
    const gulp = `gulp.src(['./js/lib/a.js']).pipe(concat('bundle.js'));`;
    const written = {}; const backups = new Map();
    const deps = {
      exists: () => true,
      readText: (f) => (f.endsWith('gulpfile.js') ? gulp : EXPORT),
      writeText: (f, c) => { written[f] = c; },
      readBuf: () => Buffer.from('NEU'),
      findExport: () => '/repo/plugin.sql',
    };
    const r = reembedBundles('/repo', backups, deps);
    expect(r.ok).toBe(true);
    expect(r.updated).toEqual(['bundle.js']);
    expect(decode(written['/repo/plugin.sql'], 'bundle.js')).toBe('NEU');
    expect(backups.get('/repo/plugin.sql')).toBe(EXPORT); // Rollback-Backup gesetzt
  });
});
