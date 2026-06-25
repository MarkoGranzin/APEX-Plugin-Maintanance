import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/service/run-repo.js';

/**
 * T-60 — Im Prüfprotokoll erscheint JEDES Test-Szenario einzeln (bestanden/fehlgeschlagen).
 */
describe('Protokoll listet Tests einzeln (bestanden/fehlgeschlagen)', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    // eigener Plugin-Code mit Einstiegspunkt
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), 'function drawWidget(){ return 1; }\n');
    // APEX-Export mit Referenz auf veraltete (verwundbare) jQuery → Schwachstellen-Test schlägt fehl
    fs.writeFileSync(
      path.join(dir, 'colorpicker.sql'),
      "begin wwv_flow_api.create_plugin(p_id=>1,p_name=>'CP'); end;\n-- https://code.jquery.com/jquery-3.4.1.min.js\n",
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('bestandene und fehlgeschlagene Test-Szenarien stehen einzeln im Log', () => {
    const res = scanRepo(dir);
    const tests = res.log.filter((e) => e.agent === 'Test');
    // bestanden: lädt ohne Fehler
    expect(tests.some((e) => /✓ Artefakt lädt ohne Fehler: bestanden/.test(e.result))).toBe(true);
    // bestanden: je Einstiegspunkt
    expect(tests.some((e) => /✓ Einstiegspunkt drawWidget funktioniert: bestanden/.test(e.result))).toBe(true);
    // fehlgeschlagen: bekannte Schwachstelle (jQuery 3.4.1)
    const vuln = tests.find((e) => /keine bekannten Schwachstellen/.test(e.result));
    expect(vuln).toBeTruthy();
    expect(vuln.result).toMatch(/✗.*fehlgeschlagen/);
    expect(vuln.severity).toBe('error');
  });
});
