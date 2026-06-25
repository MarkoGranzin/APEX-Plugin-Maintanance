import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectArtifacts, sqlSignals } from '../src/inventory/inventory.js';
import { detectFormat, enrichWithFormat, FORMAT, TEST_PATH } from '../src/inventory/format.js';

let repo;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-inv-'));
  const w = (rel, content) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  // A) export-fertiges Plugin
  w(
    'export/colorpicker.sql',
    `prompt --application/shared_components/plugins
begin
wwv_flow_api.create_plugin(p_id=>123, p_plugin_type=>'REGION', p_name=>'COLORPICKER');
wwv_flow_api.create_plugin_file(p_id=>1, p_file_name=>'widget.js', p_file_content=>'Y29uc29sZS5sb2coMSk7');
end;`,
  );

  // B) Template-Komponente (Export)
  w(
    'export/card_tc.sql',
    `begin
wwv_flow_api.create_template_component(p_id=>9, p_name=>'FANCY_CARD');
end;`,
  );

  // C) roher Quellcode (getrennte Dateien)
  w('src/slider/slider.js', `(function(){ apex.item('P1_X').setValue(1); })();`);
  w('src/slider/slider.css', `.slider{color:red}`);
  w('src/slider/slider_pkg.sql', `create or replace package slider_pkg as procedure render; end;`);

  // Testdatei darf NICHT als Artefakt zählen
  w('test/slider.test.js', `it('x',()=>{})`);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('T-2 Plugin-/Komponenten-Erkennung', () => {
  it('erkennt Export-Plugin, Template-Komponente und rohes Quell-Plugin', () => {
    const arts = detectArtifacts(repo);
    const byName = Object.fromEntries(arts.map((a) => [a.name, a]));

    expect(byName.colorpicker?.type).toBe('plugin');
    expect(byName.card_tc?.type).toBe('template_component');
    expect(byName.slider?.type).toBe('plugin');
  });

  it('sammelt JS/CSS-Assets je rohem Artefakt als SBOM-Eingang', () => {
    const arts = detectArtifacts(repo);
    const slider = arts.find((a) => a.name === 'slider');
    expect(slider.assets).toEqual(
      expect.arrayContaining(['src/slider/slider.js', 'src/slider/slider.css']),
    );
  });

  it('ignoriert Testdateien', () => {
    const arts = detectArtifacts(repo);
    expect(arts.some((a) => a.files.some((f) => f.includes('.test.js')))).toBe(false);
  });

  it('sqlSignals erkennt Export- und Package-Signale', () => {
    expect(sqlSignals('wwv_flow_api.create_plugin(...)').isApexExport).toBe(true);
    expect(sqlSignals('CREATE OR REPLACE PACKAGE x AS END;').isPlSqlPackage).toBe(true);
  });
});

describe('T-18 Speicherformat & Test-Pfad', () => {
  it('Export-fertige Komponente erkannt → Instanz-Pfad', () => {
    const arts = enrichWithFormat(detectArtifacts(repo));
    const cp = arts.find((a) => a.name === 'colorpicker');
    expect(cp.format).toBe(FORMAT.EXPORT);
    expect(cp.testPath).toBe(TEST_PATH.INSTANCE);
    expect(cp.status).toBe('ok');
  });

  it('Roher Quellcode erkannt → Instanz-freier Pfad', () => {
    const arts = enrichWithFormat(detectArtifacts(repo));
    const sl = arts.find((a) => a.name === 'slider');
    expect(sl.format).toBe(FORMAT.SOURCE);
    expect(sl.testPath).toBe(TEST_PATH.INSTANCE_FREE);
  });

  it('Unklares/gemischtes Format → zu klären statt Annahme', () => {
    const mixed = {
      name: 'mixed',
      jsFiles: ['x.js'],
      cssFiles: [],
      signals: { isApexExport: true, isPlSqlPackage: false },
    };
    const res = detectFormat(mixed);
    expect(res.format).toBe(FORMAT.UNCLEAR);
    expect(res.status).toBe('clarify');
    expect(res.testPath).toBeNull();
  });
});
