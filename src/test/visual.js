/**
 * T-104 — Optisches Abschluss-Gate: „sieht aus wie zuvor".
 *
 * captureShot nimmt einen Screenshot des Mocks auf (Playwright/chromium). aiVisualCheck lässt die KI
 * BEFORE (Original/Baseline) und AFTER (nach der Migration) vergleichen: gleiches Layout/Komponenten/
 * Struktur, nichts kaputt/leer/unstyled/fehlend. Verdikt looksSame=false → optischer Regress → die
 * Migration darf NICHT übernommen werden. Das CLI-Backend (Claude Code) liest die PNG-Pfade selbst.
 *
 * Reine, injizierbare Funktionen → testbar ohne echtes Playwright/KI.
 *
 * Resultat: src/test/visual.js
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Screenshot der Mock-Seite aufnehmen. launch ist injizierbar (Tests/ohne Playwright).
 * @param {string} url @param {string} outPath @param {{launch?:Function, timeoutMs?:number}} deps
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
export async function captureShot(url, outPath, deps = {}) {
  if (!url || !outPath) return { ok: false, error: 'url/outPath fehlt' };
  let launch = deps.launch;
  if (!launch) {
    try { const pw = await import('@playwright/test'); launch = () => pw.chromium.launch(); }
    catch { return { ok: false, error: 'Playwright nicht installiert' }; }
  }
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto(url, { waitUntil: 'load' });
    // auf die Selbst-Charakterisierung des Mocks warten (mxGraph/async-Render), dann ein Tick Ruhe
    await page.waitForFunction(() => window.__ok === true, null, { timeout: deps.timeoutMs ?? 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    try { await browser?.close(); } catch { /* egal */ }
  }
}

/** Prompt für den optischen Vergleich (rein/testbar). Bindet die PNG-Pfade ein → Claude Code liest sie. */
export function visualComparePrompt(before, after) {
  return `You are a meticulous UI reviewer. Read these two PNG screenshots of the SAME Oracle APEX plugin and compare them:
BEFORE (the original, known-good build): ${before}
AFTER (after a library migration): ${after}

Decide whether AFTER still LOOKS LIKE BEFORE to an end user:
- same overall layout and structure, same visible components/areas, same general styling;
- nothing important is missing, broken, empty, overlapping, unstyled or visibly garbled.
Minor pixel/color/font/spacing differences are acceptable; structural or visual breakage is NOT.

Respond with ONLY compact JSON and no other text: {"looksSame": true|false, "issues": ["short issue", ...]}.`;
}

/**
 * KI-UI-Prüfung: sieht der migrierte Build aus wie das Original?
 * @param {{ai:object, before:string, after:string}} deps
 * @returns {Promise<{ran:boolean, looksSame?:boolean, issues?:string[], reason?:string, raw?:string}>}
 */
export async function aiVisualCheck(deps = {}) {
  const { ai, before, after } = deps;
  if (!ai || typeof ai.complete !== 'function' || ai.kind === 'stub') return { ran: false, reason: 'no AI backend' };
  if (!before || !after || !fs.existsSync(before) || !fs.existsSync(after)) return { ran: false, reason: 'screenshots missing' };
  let out;
  try { out = await ai.complete(visualComparePrompt(before, after), {}); }
  catch (e) { return { ran: false, reason: 'AI vision error: ' + (e?.message ?? e) }; }
  let v = null;
  try { const m = String(out).match(/\{[\s\S]*\}/); if (m) v = JSON.parse(m[0]); } catch { /* kein JSON */ }
  if (!v || typeof v.looksSame !== 'boolean') return { ran: false, reason: 'AI returned no usable verdict', raw: String(out).slice(0, 300) };
  return { ran: true, looksSame: v.looksSame, issues: Array.isArray(v.issues) ? v.issues : [] };
}
