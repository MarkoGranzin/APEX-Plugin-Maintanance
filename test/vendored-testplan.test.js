import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/service/run-repo.js';

/**
 * Regression: vendored Bibliotheken (lib/, *.min.js) dürfen den Cucumber-Testplan
 * NICHT fluten. Sie gehören unter „Bibliotheken", nicht in die Test-Szenarien.
 * (Realfall ApexFlowChart: 532 KB → 4 KB nach dieser Eingrenzung.)
 */
describe('Testplan grenzt vendored Libs aus', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vend-'));
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    // eigenes Plugin-JS → soll im Testplan auftauchen
    fs.writeFileSync(path.join(dir, 'js', 'widget.js'), 'function drawWidget(){ apex.item("P1").setValue(1); }\n');
    // vendored Lib → soll NICHT im Testplan auftauchen
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'function vendorOnly(){ return 42; }\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('eigenes JS ja, vendored JS nein', () => {
    const res = scanRepo(dir);
    expect(res.testPlan).toContain('drawWidget');
    expect(res.testPlan).not.toContain('vendorOnly');
  });
});
