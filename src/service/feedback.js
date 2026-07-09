/**
 * T-147 — Fehler-Report (Text + Screenshots) → Analyse → DAUERHAFTER Regressionstest → Rework.
 *
 * Konzept (Nutzer): eigentlich sollen die Tests Fehler selbst fangen. Wenn manuell nachgeholfen werden
 * muss, wird der gemeldete Fehler ANALYSIERT und als ZUSÄTZLICHER Coded-UI-Test festgehalten, der ab dann
 * dauerhaft mitgepflegt wird (codedTests → läuft bei jedem UI-Test-/Pflege-Lauf mit; rot solange der
 * Fehler existiert, grün nach dem Fix, bleibt als Regressionsschutz). Screenshots werden als Dateien im
 * Repo abgelegt und der Analyse-KI per Pfad mitgegeben (die claude-CLI kann Bilddateien lesen).
 *
 * Alle Effekte injizierbar → deterministisch testbar. Keine Secrets, Größen-/Namens-Validierung der Bilder.
 *
 * Resultat: src/service/feedback.js
 */

import fs from 'node:fs';
import path from 'node:path';

const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMG_BYTES = 8_000_000;

/**
 * Speichert einen Fehler-Report (Text + Screenshots) unter <repo>/.maintenance/feedback/<stamp>/.
 * @param {string} dir  component.path
 * @param {{text:string, images?:Array<{name:string, data:string}>}} fb  data = Base64 (ohne data:-Präfix)
 * @returns {{dir,reportPath,imagePaths,stamp,text}|{error:string}}
 */
export function saveFeedback(dir, fb = {}, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const text = String(fb.text || '').trim();
  if (!text) return { error: 'Fehlerbeschreibung fehlt.' };
  if (!dir) return { error: 'Kein Repo-Verzeichnis.' };
  const stamp = now().replace(/[-:T.Z]/g, '').slice(0, 14);
  const fbDir = path.join(dir, '.maintenance', 'feedback', stamp);
  fs.mkdirSync(fbDir, { recursive: true });
  const imagePaths = [];
  for (const img of fb.images ?? []) {
    const name = String(img?.name || '');
    // kein Pfad-Anteil, nur Bild-Endungen (gleiche Guards wie der Datei-Import, T-144)
    if (path.basename(name) !== name || /[/\\]/.test(name) || !IMG_RE.test(name)) return { error: `Ungültiger Screenshot-Name: ${name}` };
    const buf = Buffer.from(String(img.data || ''), 'base64');
    if (!buf.length) return { error: `Screenshot leer: ${name}` };
    if (buf.length > MAX_IMG_BYTES) return { error: `Screenshot zu groß (max 8 MB): ${name}` };
    const p = path.join(fbDir, name);
    fs.writeFileSync(p, buf);
    imagePaths.push(p);
  }
  const reportPath = path.join(fbDir, 'report.md');
  fs.writeFileSync(reportPath, `# Fehler-Report (${now()})\n\n${text}\n\nScreenshots: ${imagePaths.map((p) => path.basename(p)).join(', ') || '—'}\n`);
  return { dir: fbDir, reportPath, imagePaths, stamp, text };
}

/** Prompt für die Analyse-KI: Problem verstehen (inkl. Screenshots per Datei-Pfad) → EIN Playwright-Spec. */
export function buildFeedbackTestPrompt(name, fb, ctx = {}) {
  const imgs = (fb.imagePaths || []).length
    ? `Screenshots of the problem (VIEW them — read these image files):\n${fb.imagePaths.map((p) => `  - ${p}`).join('\n')}`
    : 'No screenshots provided.';
  return `You are the test engineer for the Oracle APEX plugin "${name}". A user reported a problem that the existing automated tests did NOT catch. Analyze it and write ONE new regression test.

User report:
${fb.text}

${imgs}

The page under test is a mock of the plugin, loaded via process.env.PLUGIN_URL${ctx.mockUrl ? ` (currently: ${ctx.mockUrl})` : ''}.
Existing spec files (do NOT duplicate their names or assertions): ${(ctx.existing || []).join(', ') || '(none)'}

Write EXACTLY ONE Playwright spec file (@playwright/test) that encodes the CORRECT expected behavior for the reported problem:
- it must FAIL while the reported bug exists and PASS once the bug is fixed (permanent regression test),
- const { test, expect } = require('@playwright/test');
- await page.goto(process.env.PLUGIN_URL) as the entry,
- deterministic, no external network, reasonable timeouts,
- 1-3 focused test() blocks, titles in German describing the reported problem.

Return ONLY the JavaScript code of the spec file (no Markdown, no explanation).`;
}

/**
 * Erzeugt aus dem Report per KI den dauerhaften Regressionstest: Spec-Datei ins Repo
 * (<repo>/.maintenance/tests/feedback-<stamp>.ui.spec.js) + in component.codedTests (läuft ab jetzt
 * bei jedem UI-Test-Lauf mit) + Notiz am Plugin. KI-Antwort wird validiert (echter Playwright-Spec).
 * @param {{ai:object, mockUrl?:string}} deps
 */
export async function createFeedbackTest(store, comp, fb, deps = {}) {
  const ai = deps.ai;
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function') return { error: 'KI-Backend nötig für die Analyse (Settings → Test connection).' };
  const cur = store.get(comp.id) || comp;
  const existing = (cur.codedTests || []).map((t) => t.name);
  const prompt = buildFeedbackTestPrompt(comp.name, fb, { mockUrl: deps.mockUrl, existing });
  let raw;
  try { raw = String(await ai.complete(prompt, {})); } catch (e) { return { error: 'AI error: ' + (e?.message ?? e) }; }
  const code = raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  if (!/@playwright\/test/.test(code) || !/\btest\s*\(/.test(code) || !/\bexpect\s*\(/.test(code)) {
    return { error: 'KI lieferte keinen brauchbaren Playwright-Test — bitte Report präzisieren und erneut senden.', raw: code.slice(0, 400) };
  }
  const specName = `feedback-${fb.stamp}.ui.spec.js`;
  const testsDir = path.join(comp.path, '.maintenance', 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, specName), code);
  store.update(comp.id, { codedTests: [...(cur.codedTests || []).filter((t) => t.name !== specName), { name: specName, content: code }] });
  store.addNote(comp.id, { kind: 'feedback', text: `Fehler-Report → Regressionstest ${specName}: ${fb.text.slice(0, 200)}` });
  return { ok: true, spec: { name: specName, content: code } };
}
