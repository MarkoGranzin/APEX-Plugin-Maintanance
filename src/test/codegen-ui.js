/**
 * T-64 — Coded-UI-Tests (Playwright) + jsdom-Unit-Skeletons aus der Tiefenanalyse (T-62).
 *
 * Erzeugt aus erkannten Selektoren/Events lauffähige Playwright-Specs (Sichtbarkeit, Klick/Eingabe,
 * keine Konsolenfehler) und jsdom-Unit-Skeletons (apex-Shim) mit Positiv/Negativ-Platzhaltern je
 * Funktion. Die Dateien sind syntaktisch gültiges JavaScript (Modul) und als Startpunkt gedacht;
 * konkrete Erwartungen markieren TODOs. PLUGIN_URL steuert das Ziel der UI-Tests.
 *
 * Resultat: src/test/codegen-ui.js
 */

const q = (v) => JSON.stringify(v); // sicher einbetten (escaped)

/** Playwright-Spec aus Events/Selektoren. */
export function buildPlaywrightSpec(artifactName, deep) {
  const events = deep?.events ?? [];
  const selectors = deep?.selectors ?? [];
  const L = [];
  L.push('// @ts-check');
  L.push(`// Coded-UI-Tests für ${artifactName} (auto-generiert aus der Plugin-Analyse).`);
  L.push('// Ziel-Seite über Umgebungsvariable PLUGIN_URL setzen.');
  L.push("import { test, expect } from '@playwright/test';");
  L.push('');
  L.push("const URL = process.env.PLUGIN_URL || 'http://localhost:8080/plugin-test';");
  L.push('');
  L.push("test('Plugin lädt ohne JavaScript-Fehler', async ({ page }) => {");
  L.push('  const errors = [];');
  L.push("  page.on('pageerror', (e) => errors.push(String(e)));");
  L.push("  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });");
  L.push('  await page.goto(URL);');
  L.push("  expect(errors, errors.join('\\n')).toHaveLength(0);");
  L.push('});');
  L.push('');

  for (const sel of selectors) {
    L.push(`test(${q(`Element ${sel} ist sichtbar`)}, async ({ page }) => {`);
    L.push('  await page.goto(URL);');
    L.push(`  await expect(page.locator(${q(sel)})).toBeVisible();`);
    L.push('});');
    L.push('');
  }

  for (const ev of events) {
    if (!ev.selector) continue;
    const loc = `page.locator(${q(ev.selector)})`;
    const action = ev.type === 'change' || ev.type === 'keyup' || ev.type === 'keydown'
      ? `await ${loc}.fill('Test');`
      : ev.type === 'click'
        ? `await ${loc}.click();`
        : `await ${loc}.dispatchEvent(${q(ev.type)});`;
    L.push(`test(${q(`${ev.type} auf ${ev.selector} reagiert ohne Fehler`)}, async ({ page }) => {`);
    L.push('  const errors = [];');
    L.push("  page.on('pageerror', (e) => errors.push(String(e)));");
    L.push('  await page.goto(URL);');
    L.push(`  await expect(page.locator(${q(ev.selector)})).toBeVisible();`);
    L.push(`  ${action}`);
    L.push('  // TODO: erwartete Wirkung der Interaktion prüfen');
    L.push("  expect(errors, errors.join('\\n')).toHaveLength(0);");
    L.push('});');
    L.push('');
  }
  return L.join('\n');
}

/** jsdom-Unit-Skeletons (apex-Shim) je Funktion mit Positiv/Negativ-Platzhaltern. */
export function buildJsdomUnit(artifactName, deep) {
  const fns = deep?.functions ?? [];
  const L = [];
  L.push(`// jsdom-Unit-Skeletons für ${artifactName} (auto-generiert).`);
  L.push("import { describe, it, beforeEach } from 'vitest';");
  L.push("import { JSDOM } from 'jsdom';");
  L.push('');
  L.push('// Minimaler apex-Shim — bei Bedarf erweitern.');
  L.push('function installApexShim(win) {');
  L.push("  win.apex = { item: () => ({ getValue: () => '', setValue: () => {} }), submit: () => {}, message: { clearErrors: () => {}, showErrors: () => {} }, jQuery: win.jQuery, server: { process: () => Promise.resolve({}) } };");
  L.push('}');
  L.push('');
  L.push('// TODO: Plugin-Asset hier importieren/laden (Pfad anpassen):');
  L.push('// import * as plugin from "../js/widget.js";');
  L.push('');
  L.push(`describe(${q(artifactName + ' (auto-generierte Unit-Skeletons)')}, () => {`);
  L.push('  let win;');
  L.push('  beforeEach(() => {');
  L.push("    const dom = new JSDOM('<!doctype html><html><body><div id=\"app\"></div></body></html>');");
  L.push('    win = dom.window; installApexShim(win);');
  L.push('    global.window = win; global.document = win.document;');
  L.push('  });');
  L.push('');
  if (fns.length === 0) {
    L.push("  it.todo('Artefakt lädt ohne Fehler');");
  }
  for (const f of fns) {
    const sig = f.params.length ? `(${f.params.join(', ')})` : '()';
    L.push(`  it.todo(${q(`${f.name}${sig} mit gültigen Eingaben → kein Fehler (Positiv)`)});`);
    for (const p of f.params.slice(0, 6)) {
      L.push(`  it.todo(${q(`${f.name} — ${p} null/undefined/falscher Typ → sauber behandelt (Negativ)`)});`);
    }
    if (f.branches > 0) L.push(`  it.todo(${q(`${f.name} — alle ${f.branches} Verzweigung(en) wahr/falsch abdecken`)});`);
    if (f.throws > 0) L.push(`  it.todo(${q(`${f.name} — wirft definierten Fehler bei ungültigem Zustand`)});`);
  }
  L.push('});');
  return L.join('\n');
}

/** Beide Generate + Dateiliste. */
export function generateCodedTests(artifactName, deep) {
  const slug = String(artifactName).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'plugin';
  const playwright = buildPlaywrightSpec(artifactName, deep);
  const jsdom = buildJsdomUnit(artifactName, deep);
  return { playwright, jsdom, files: [
    { name: `${slug}.ui.spec.js`, content: playwright },
    { name: `${slug}.unit.test.js`, content: jsdom },
  ] };
}
