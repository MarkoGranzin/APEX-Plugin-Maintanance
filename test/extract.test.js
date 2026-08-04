import { describe, it, expect } from 'vitest';
import { extractArtifact, versionFromUrl, referencedUrlsFrom } from '../src/extract/extract.js';

// base64('console.log(1);') = 'Y29uc29sZS5sb2coMSk7'
const B64_WIDGET = Buffer.from('console.log("widget");').toString('base64');

function fakeReader(map) {
  return (rel) => {
    if (!(rel in map)) throw new Error('not found: ' + rel);
    return map[rel];
  };
}

describe('T-19 Base64-Plugin-Datei dekodieren', () => {
  it('dekodiert per create_plugin_file kodierte widget.js + sourceMap zeigt auf den SQL-Export', () => {
    const sql = `begin
wwv_flow_api.create_plugin_file(
  p_id=>1,
  p_plugin_id=>99,
  p_file_name=>'widget.js',
  p_mime_type=>'application/javascript',
  p_file_content=>'${B64_WIDGET}');
end;`;
    const art = { name: 'cp', sqlFiles: ['export/cp.sql'], jsFiles: [], cssFiles: [] };
    const b = extractArtifact(art, { readFile: fakeReader({ 'export/cp.sql': sql }) });

    const widget = b.js.find((j) => j.name === 'widget.js');
    expect(widget?.code).toBe('console.log("widget");');
    expect(b.sourceMap['widget.js']).toMatchObject({ type: 'plugin_file', sqlFile: 'export/cp.sql' });
    expect(b.status).toBe('ok');
  });

  it('dekodiert g_varchar2_table-Chunks', () => {
    const full = Buffer.from('alert(42);').toString('base64');
    const a = full.slice(0, 4);
    const rest = full.slice(4);
    const sql = `wwv_flow_api.create_plugin_file(p_file_name=>'a.js',
      p_file_content=> wwv_flow_api.g_varchar2_table('${a}','${rest}'));`;
    const art = { name: 'x', sqlFiles: ['x.sql'] };
    const b = extractArtifact(art, { readFile: fakeReader({ 'x.sql': sql }) });
    expect(b.js[0].code).toBe('alert(42);');
  });
});

describe('T-19 Lose .js/.css unverändert übernehmen', () => {
  it('übernimmt beide as-is und sourceMap verweist auf Originalpfade', () => {
    const art = { name: 'slider', jsFiles: ['src/slider/slider.js'], cssFiles: ['src/slider/slider.css'] };
    const b = extractArtifact(art, {
      readFile: fakeReader({
        'src/slider/slider.js': 'export const x=1;',
        'src/slider/slider.css': '.s{}',
      }),
    });
    // B-75: Assets tragen origin auch direkt am Eintrag (für die Header-Fingerprint-Stufe)
    expect(b.js[0]).toEqual({ name: 'slider.js', code: 'export const x=1;', origin: { type: 'file', path: 'src/slider/slider.js' } });
    expect(b.css[0]).toEqual({ name: 'slider.css', code: '.s{}', origin: { type: 'file', path: 'src/slider/slider.css' } });
    expect(b.sourceMap['slider.js']).toEqual({ type: 'file', path: 'src/slider/slider.js' });
  });
});

describe('T-19 Referenzierte CDN-URL mit Version', () => {
  it('extrahiert URL + Version, ohne lokalen Code zu erwarten', () => {
    const sql = `-- p_file_urls_to_load
    wwv_flow_api.create_plugin(p_file_urls=>'https://cdn.example.com/chart.js@3.9.1/chart.min.js');`;
    const art = { name: 'chart', sqlFiles: ['c.sql'] };
    const b = extractArtifact(art, { readFile: fakeReader({ 'c.sql': sql }) });
    expect(b.referencedUrls).toEqual([
      { url: 'https://cdn.example.com/chart.js@3.9.1/chart.min.js', version: '3.9.1', kind: 'js' },
    ]);
    expect(b.js).toHaveLength(0);
  });

  it('versionFromUrl erkennt @x.y.z, /x.y.z/ und -x.y.z', () => {
    expect(versionFromUrl('https://x/lib@1.2.3/a.js')).toBe('1.2.3');
    expect(versionFromUrl('https://x/2.4.1/a.css')).toBe('2.4.1');
    expect(versionFromUrl('https://x/jquery-3.6.0.min.js')).toBe('3.6.0');
  });
});

describe('T-19 Misch-Repo je Artefakt → gleiches Bündel-Format', () => {
  it('Export- und Quell-Artefakt liefern dieselbe kanonische Struktur', () => {
    const exp = extractArtifact(
      { name: 'e', sqlFiles: ['e.sql'] },
      { readFile: fakeReader({ 'e.sql': `wwv_flow_api.create_plugin_file(p_file_name=>'e.js',p_file_content=>'${B64_WIDGET}');` }) },
    );
    const src = extractArtifact(
      { name: 's', jsFiles: ['s.js'] },
      { readFile: fakeReader({ 's.js': 'var s=1;' }) },
    );
    const keys = ['artifact', 'js', 'css', 'inlineCode', 'referencedUrls', 'sourceMap', 'unsafe', 'status'];
    for (const k of keys) {
      expect(exp).toHaveProperty(k);
      expect(src).toHaveProperty(k);
    }
  });
});

describe('T-19 Unsichere Extraktion nicht raten', () => {
  it('markiert dynamischen Inhalt als unsicher, ohne JS zu erfinden', () => {
    const sql = `declare l_blob blob; begin
      wwv_flow_api.create_plugin_file(p_file_name=>'dyn.js', p_file_content=> l_dynamic_content);
    end;`;
    const art = { name: 'dyn', sqlFiles: ['d.sql'] };
    const b = extractArtifact(art, { readFile: fakeReader({ 'd.sql': sql }) });
    expect(b.unsafe.length).toBeGreaterThan(0);
    expect(b.status).toBe('extraktion-unsicher');
    expect(b.js).toHaveLength(0);
  });
});
