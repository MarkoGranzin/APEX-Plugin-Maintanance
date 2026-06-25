// Live-Demo des kompletten F-28-Flows an APEX-Vanta (isoliert, echte Playwright-UI-Tests,
// KI-Migration deterministisch gestubbt = keine Kosten). Zeigt: Erkennung → Baseline → Re-Dev
// (Adopt bei „grün wie zuvor") und einen Regress-Fall (Rollback).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectVendoredLibraries } from '../src/sbom/vendored.js';
import { classifyUpdate } from '../src/service/lib-update.js';
import { classifyLicense } from '../src/sbom/licenses.js';
import { createComponentStore } from '../src/gui/store.js';
import { captureBaseline } from '../src/service/baseline.js';
import { redevelopComponent } from '../src/service/redev.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, 'repo');
const L = (...a) => console.log(...a);

// 1) ERKENNUNG (echt, am geklonten Repo)
L('\n=== 1) Bibliothekserkennung (real) ===');
const libs = detectVendoredLibraries(repo);
for (const l of libs) L(`  - ${l.name}@${l.version}   (${l.evidence})`);
const three = libs.find((x) => x.name === 'three');
L(`  → three erkannt als ${three.version}  (vorher: unbekannt)`);
L(`  → classifyUpdate(${three.version} → 0.185.0) = ${classifyUpdate(three.version, '0.185.0')}  ⇒ Re-Dev-Pfad (kein blinder Swap)`);
L(`  → Lizenz three (MIT): ${JSON.stringify(classifyLicense('MIT'))}`);

// 2) HARNESS-Seite mit three.js (für echte UI-Tests)
const hp = path.join(__dirname, 'harness');
fs.mkdirSync(hp, { recursive: true });
fs.copyFileSync(path.join(repo, 'js', 'lib', 'three.js'), path.join(hp, 'three.js'));
const writePage = (ok) => fs.writeFileSync(path.join(hp, 'page.html'),
  `<!doctype html><html><body><div id="bg" style="width:100px;height:40px">three loaded</div><script src="three.js"></script>
   <script>window.__ok = ${ok ? "(typeof THREE!=='undefined' && !!THREE.REVISION)" : 'false'};</script></body></html>`);
writePage(true);
const url = 'file:///' + hp.replace(/\\/g, '/') + '/page.html';

const uiSpec = { name: 'vanta.ui.spec.js', content: `import { test, expect } from '@playwright/test';
const URL = process.env.PLUGIN_URL;
test('three.js lädt, REVISION verfügbar, keine JS-Fehler', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL);
  await expect(page.locator('#bg')).toBeVisible();
  expect(await page.evaluate(() => window.__ok)).toBe(true);
  expect(errors).toEqual([]);
});` };

// Store + Komponente
const store = createComponentStore({ now: () => new Date('2026-06-25T19:30:00Z').toISOString(), idGen: () => 'demo' });
const id = store.add({ name: 'APEX-Vanta-js-Plugin', path: hp, uiTestUrl: url, codedTests: [uiSpec], libs }).id;
const specsDir = path.join(hp, 'specs');

// 3) BASELINE auf dem funktionierenden Build (echter Playwright-Lauf)
L('\n=== 2) Charakterisierungs-Baseline aufnehmen (echte UI-Tests) ===');
const base = await captureBaseline(store, store.get(id), { hasPlaywright: true, specsDir, now: () => 't0' });
L(`  mode=${base.mode}  Szenarien:`); base.scenarios.forEach((s) => L(`   - ${s.scenario} → ${s.status}`));

// 4) RE-DEV — Fall A: „Migration" hält das Verhalten (Seite bleibt grün) → Übernahme
L('\n=== 3) Re-Dev Fall A: Migration verhält sich wie zuvor → ÜBERNAHME ===');
const okMigrate = async () => ({ changed: true, summary: 'AI-Migration (Demo): three → 0.185.0, Verhalten erhalten', backups: new Map(), rollback: () => {} });
const rA = await redevelopComponent(store, store.get(id), { migrate: okMigrate, hasPlaywright: true, specsDir, now: () => 't1', upload: async () => ({ ok: true, branch: 'aisp/redev-demo', pushed: false, prUrl: null }) });
L(`  adopted=${rA.adopted}  gate.pass=${rA.gate?.pass}  summary="${rA.gate?.summary}"`);
L(`  → Komponente markiert: rebuilt=${store.get(id).rebuilt}, rebuiltTo=${store.get(id).rebuiltTo}, verifiedAsBefore=${store.get(id).verifiedAsBefore}`);

// Reset Markierung für Fall B
store.update(id, { rebuilt: false, verifiedAsBefore: false });

// 5) RE-DEV — Fall B: „Migration" bricht das Verhalten → Gate erkennt Regress → ROLLBACK
L('\n=== 4) Re-Dev Fall B: Migration bricht das Verhalten → ROLLBACK (nichts übernommen) ===');
const badMigrate = async () => { writePage(false); return { changed: true, summary: 'AI-Migration (Demo): bricht three', backups: new Map(), rollback: () => writePage(true) }; };
const rB = await redevelopComponent(store, store.get(id), { migrate: badMigrate, hasPlaywright: true, specsDir, now: () => 't2', upload: async () => ({ ok: true }) });
L(`  adopted=${rB.adopted}  gate.pass=${rB.gate?.pass}`);
L(`  Regressionen:`); (rB.regressions || []).forEach((x) => L(`   - ${x.scenario}: ${x.was} → ${x.now}`));
L(`  → rebuilt=${store.get(id).rebuilt} (unverändert), funktionierender Stand bleibt erhalten (rollback ausgeführt)`);
L('\n=== Ende der Demo ===');
