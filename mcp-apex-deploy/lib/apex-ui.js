/**
 * apex-ui — wiederverwendbare, headless APEX-UI-Automation (Playwright), config-parametrisiert.
 *
 * Reine Page-Level-Bausteine (keine ENV-Abhängigkeit) — nutzbar vom stdio-MCP-Server UND von
 * Plugin Maintenance. Der Aufrufer übergibt die Verbindung als `cfg` ({baseUrl, workspace, user, pass})
 * und managed Browser-/Seiten-Lebenszyklus selbst.
 *
 * Resultat: mcp-apex-deploy/lib/apex-ui.js
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Playwright chromium laden (aus dem cwd oder global). null, wenn nicht installiert. */
export async function loadChromium(cwd = process.cwd()) {
  try { const m = await import(pathToFileURL(path.join(cwd, 'node_modules', 'playwright', 'index.mjs')).href); return m.chromium; }
  catch { try { return (await import('playwright')).chromium; } catch { return null; } }
}

/**
 * B-67 — die APEX-baseUrl kommt aus der (pro Komponente frei setzbaren) Konfiguration und bekommt
 * beim Login Workspace/Username/Passwort im Klartext gefüttert. Ohne Schema-/Host-Prüfung würde ein
 * gefälschter/vertippter Wert (http://…, file:, javascript:, oder ein fremder Host über http) die
 * echten APEX-Credentials an einen beliebigen Ort schicken. Darum VOR der Navigation validieren:
 * nur http(s); http ausschließlich für localhost (sonst geht das Passwort im Klartext übers Netz).
 * @returns {URL} die geparste, sichere Basis-URL
 */
export function assertSafeApexBaseUrl(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl)); } catch { throw new Error('APEX Base-URL ist keine gültige URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`APEX Base-URL muss http(s) sein, nicht ${u.protocol}`);
  const isLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !isLocal) throw new Error('APEX Base-URL muss https nutzen (sonst würden Workspace/User/Passwort im Klartext übertragen)');
  return u;
}

/**
 * Anmeldung an der modernen APEX-Workspace-Sign-In-Seite (Workspace + Database Username + Passwort).
 * @param {import('playwright').Page} page
 * @param {{baseUrl:string, workspace:string, user:string, pass:string}} cfg
 */
export async function uiLogin(page, cfg = {}) {
  const { baseUrl, workspace, user, pass } = cfg;
  if (!baseUrl) return { ok: false, error: 'baseUrl fehlt.' };
  if (!workspace || !user || !pass) return { ok: false, error: 'Login unvollständig — workspace, user, pass nötig.' };
  // B-67: config-getriebene baseUrl prüfen, BEVOR Credentials dorthin gefüttert werden.
  try { assertSafeApexBaseUrl(baseUrl); } catch (e) { return { ok: false, error: e.message }; }
  await page.goto(`${baseUrl.replace(/\/$/, '')}/r/apex/app-builder/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const fill = async (labels, ids, value) => {
    for (const l of labels) { const loc = page.getByPlaceholder(l, { exact: false }); if (await loc.count()) { await loc.first().fill(value); return true; } }
    for (const id of ids) { const loc = page.locator(id); if (await loc.count()) { await loc.first().fill(value); return true; } }
    return false;
  };
  if (await page.getByPlaceholder('Workspace', { exact: false }).count()) {
    await fill(['Workspace'], ['#P9999_COMPANY', '#P101_COMPANY'], workspace);
    await fill(['Database Username', 'Username'], ['#P9999_USERNAME', '#P101_USERNAME'], user);
    await fill(['Password'], ['#P9999_PASSWORD', '#P101_PASSWORD'], pass);
    const btn = page.getByRole('button', { name: /sign in|anmelden/i });
    if (await btn.count()) await btn.first().click(); else await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }
  const url = page.url();
  const stillLogin = /sign-in|login/i.test(url) || (await page.getByPlaceholder('Password', { exact: false }).count()) > 0;
  return stillLogin ? { ok: false, error: 'Login nicht erfolgreich — Workspace/Username/Passwort prüfen.', url } : { ok: true, url, workspace, user };
}

/**
 * T-165 — Apps des Workspace von der App-Builder-Home lesen (Kacheln sind Links mit fb_flow_id=<id>).
 * Erwartet eine bereits angemeldete Page. Navigiert defensiv zur Builder-Home, wenn o.baseUrl gesetzt ist.
 * @returns {Promise<Array<{id:number, name:string}>>}
 */
export async function uiListApps(page, o = {}) {
  if (o.baseUrl) {
    await page.goto(`${String(o.baseUrl).replace(/\/$/, '')}/r/apex/app-builder/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const seen = new Map();
  for (const a of await page.locator('a[href*="fb_flow_id="]').all()) {
    const href = (await a.getAttribute('href').catch(() => '')) || '';
    const m = href.match(/fb_flow_id=(\d+)/);
    if (!m) continue;
    const id = Number(m[1]);
    const label = ((await a.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    // Pro App der aussagekräftigste Link-Text (die Kachel trägt den App-Namen, Icon-Links sind leer).
    if (!seen.has(id) || (label && label.length > (seen.get(id) || '').length)) seen.set(id, label);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name: name || String(id) })).sort((a, b) => a.id - b.id);
}

/**
 * T-165 — EIN SQL-Statement über SQL Workshop → SQL Commands ausführen und den sichtbaren Ergebnis-Text
 * zurückgeben. Versionsrobust: der Aufrufer baut sein SQL so, dass der gesuchte Wert als eindeutig
 * markierter String erscheint (z.B. 'AISPP|'||…) und parst ihn aus dem zurückgegebenen Text — so hängt
 * nichts am Tabellen-Markup des Ergebnisses. Erwartet eine bereits angemeldete Page.
 * @param {{baseUrl:string}} o
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function uiRunSql(page, sql, o = {}) {
  if (!o.baseUrl) return { ok: false, error: 'baseUrl missing.' };
  await page.goto(`${String(o.baseUrl).replace(/\/$/, '')}/r/apex/sql-commands`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // Editor fokussieren (CodeMirror/Monaco/plain textarea — je nach APEX-Version) und SQL eintippen.
  const editor = page.locator('.CodeMirror, .monaco-editor, #apexir_CODE, textarea').first();
  if (!(await editor.count())) return { ok: false, error: 'SQL Commands editor not found (navigation differs).' };
  await editor.click({ force: true }).catch(() => {});
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a').catch(() => {});
  await page.keyboard.insertText(sql).catch(async () => { await page.keyboard.type(sql, { delay: 5 }); });
  // Ausführen: Run-Button, sonst Ctrl+Enter.
  const run = page.getByRole('button', { name: /^run/i });
  if (await run.count()) await run.first().click().catch(() => {});
  else await page.keyboard.press('Control+Enter').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText().catch(() => '');
  return { ok: true, text };
}

/**
 * Import einer Datei über die APEX-UI (Plug-in- ODER Seiten-/Komponenten-Import). Erwartet eine bereits
 * angemeldete Page. Navigiert app-intern, lädt die Datei hoch und klickt die primäre Aktion durch.
 * @param {{appId:number|string, viaPlugins?:boolean}} o
 */
export async function uiImportFile(page, filePath, o = {}) {
  const clickFirst = async (locs) => { for (const l of locs) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
  const appId = o.appId;
  const appTile = page.locator(`a[href*="fb_flow_id=${appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000);
  if (o.viaPlugins) {
    await clickFirst([page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]);
    await clickFirst([page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]);
    await clickFirst([page.getByRole('link', { name: /^import$/i }), page.getByRole('button', { name: /^import$/i }), page.getByText(/^import$/i)]);
  } else {
    await clickFirst([page.getByRole('link', { name: /export ?\/ ?import/i }), page.getByText(/export ?\/ ?import/i)]);
    await clickFirst([page.getByRole('link', { name: /^import$/i }), page.getByRole('button', { name: /^import$/i }), page.getByText(/^import$/i)]);
  }
  const file = page.locator('input[type="file"]');
  try { await file.first().waitFor({ state: 'attached', timeout: 15000 }); }
  catch { return { ok: false, error: 'Upload-Feld nicht gefunden (Navigation weicht ab).' }; }
  await file.first().setInputFiles(filePath);
  const steps = [];
  for (let i = 0; i < 8; i++) {
    const hot = page.locator('button.a-Button--hot, a.a-Button--hot').filter({ hasText: /\S/ });
    try { await hot.first().waitFor({ state: 'visible', timeout: 20000 }); } catch { break; }
    const label = (await hot.first().innerText().catch(() => '')).trim();
    steps.push(label);
    await hot.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2000);
    const title = await page.locator('title').first().innerText().catch(() => '');
    if (/edit page|page designer|pages -|plug-?ins$/i.test(title)) break;
  }
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const oraErr = (body.match(/ORA-\d+[^.]{0,120}|PLS-\d+[^.]{0,120}/i) || [])[0] || null;
  const resultTitle = await page.locator('title').first().innerText().catch(() => '');
  // Import-Fehlerseiten ehrlich erkennen (sonst False-Green): „Bad Request"/400/Forbidden/500 im Titel
  // oder am Anfang der Seite bedeuten, dass der Import NICHT durchlief.
  const importErr = /Bad Request|HTTP Status 4\d\d|HTTP Status 5\d\d|Forbidden|Not Authorized|Internal Server Error/i
    .test(`${resultTitle} ${body.slice(0, 200)}`) ? (resultTitle || 'Bad Request') : null;
  return { ok: !oraErr && !importErr, steps, oraError: oraErr, importError: importErr, resultTitle };
}

/**
 * Setzt die „File URLs to Load" (JS + CSS) eines installierten Plugins über die APEX-UI.
 * @param {{appId:number|string, displayName?:string, jsUrls?:string[], cssUrls?:string[], overwrite?:boolean}} o
 */
export async function uiSetPluginFileUrls(page, o = {}) {
  const clickFirst = async (locs) => { for (const l of locs) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
  const appId = o.appId;
  const appTile = page.locator(`a[href*="fb_flow_id=${appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(800);
  await clickFirst([page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]);
  await clickFirst([page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]);
  const nameRe = o.displayName ? new RegExp(o.displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  let opened = false;
  if (nameRe) opened = await clickFirst([page.getByRole('link', { name: nameRe })]);
  if (!opened) return { ok: false, error: `Plugin „${o.displayName || '?'}" in der Liste nicht gefunden.` };
  await page.waitForTimeout(800);
  const setField = async (id, urls) => {
    // clear=true → Feld LEEREN (B-38: bei selbst-ladenden Plugins fälschlich gesetzte URLs entfernen,
    // sonst lädt jedes File doppelt). Sonst: nur setzen, wenn Dateien da sind und Feld leer/overwrite.
    if (!urls?.length && !o.clear) return { field: id, skipped: 'keine Dateien' };
    return page.evaluate(({ id, val, overwrite, clear }) => {
      const t = document.getElementById(id); if (!t) return { field: id, error: 'Feld fehlt' };
      if (clear) {
        if (!t.value || !t.value.trim()) return { field: id, skipped: 'schon leer' };
        t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
        try { if (window.apex && apex.item) apex.item(id).setValue(''); } catch (e) { /* egal */ }
        return { field: id, cleared: true, set: true };
      }
      if (t.value && t.value.trim() && !overwrite) return { field: id, skipped: 'bereits gesetzt' };
      t.value = val; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (window.apex && apex.item) apex.item(id).setValue(val); } catch (e) { /* egal */ }
      return { field: id, set: true, count: val.split('\n').filter(Boolean).length };
    }, { id, val: (urls || []).join('\n'), overwrite: !!o.overwrite, clear: !!o.clear });
  };
  const jsRes = await setField('P4410_JAVASCRIPT_FILE_URLS', o.jsUrls);
  const cssRes = await setField('P4410_CSS_FILE_URLS', o.cssUrls);
  let applied = false;
  if (jsRes.set || cssRes.set) {
    for (const b of [page.getByRole('button', { name: /apply changes/i }), page.locator('button:has-text("Apply Changes")')]) { if (await b.count()) { await b.first().click(); applied = true; break; } }
    await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1500);
  }
  return { ok: true, js: jsRes, css: cssRes, applied };
}

const rxEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rxi = (s) => new RegExp(rxEsc(s), 'i');

/** Property im Page-Designer-Property-Editor per Label setzen (Text→apex.item, Select→Options-Text→Value).
 *  Label-Matching ist tolerant: APEX hängt bei Validierungsfehlern „(Error)"/„(Warning)" ans Label
 *  (z.B. „Selection Type\n(Error)") — der Suffix wird abgeschnitten, sonst würde das Feld nie gefunden. */
async function pdSetProp(page, label, value) {
  return page.evaluate(({ label, value }) => {
    const norm = (s) => String(s || '').replace(/\s*\((?:error|warning)\)\s*$/i, '').replace(/\s+/g, ' ').trim();
    const pr = [...document.querySelectorAll('.a-Property')].find((e) => norm(e.querySelector('.a-Property-label')?.innerText) === label);
    if (!pr) return 'no-prop';
    const inp = pr.querySelector('input,textarea,select'); if (!inp || !inp.id) return 'no-input';
    let v = value;
    if (inp.tagName === 'SELECT') { const opt = [...inp.options].find((o) => o.text.trim().toLowerCase() === String(value).toLowerCase() || o.text.trim().toLowerCase().includes(String(value).toLowerCase())); if (!opt) return 'no-option'; v = opt.value; }
    try { if (window.apex && apex.item(inp.id) && apex.item(inp.id).node) { apex.item(inp.id).setValue(v); inp.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; } } catch (e) { return 'err:' + e.message; }
    return 'noitem';
  }, { label, value });
}

/** Setzt das ERSTE Select im Property-Editor, dessen Optionen `wantOption` enthalten (Text-Match).
 *  Für Felder, deren Label mehrdeutig ist (z.B. die Source-„Type"-Auswahl vs. die Region-„Type"-Auswahl):
 *  hier zählt die Option, nicht das Label. */
async function pdSetSelectByOption(page, wantOption) {
  return page.evaluate(({ wantOption }) => {
    for (const pr of document.querySelectorAll('.a-Property')) {
      const sel = pr.querySelector('select'); if (!sel || !sel.id) continue;
      const o = [...sel.options].find((x) => x.text.trim().toLowerCase() === String(wantOption).toLowerCase());
      if (o) { try { apex.item(sel.id).setValue(o.value); sel.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; } catch (e) { return 'err:' + e.message; } }
    }
    return 'no-option';
  }, { wantOption });
}

/** jQuery-UI-Draggable-kompatibler Maus-Drag: down → Threshold-Ruck → in Schritten zum Ziel → up.
 *  Startet in der Mitte der Quell-Box (sb = boundingBox), lässt bei (tx,ty) los. */
async function pdMouseDrag(page, sb, tx, ty) {
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 8, sb.y + sb.height / 2 + 8); await page.waitForTimeout(200);
  for (let i = 1; i <= 12; i++) { await page.mouse.move(sb.x + (tx - sb.x) * i / 12, sb.y + (ty - sb.y) * i / 12); await page.waitForTimeout(60); }
  await page.mouse.move(tx, ty); await page.waitForTimeout(400); await page.mouse.up();
  await page.waitForTimeout(2500);
}

/**
 * Löscht eine Seite über den Page Designer (Utilities → „Delete Page" → „Permanently Delete Page").
 * Für das Aufräumen alter/verwaister Testseiten. @param {{appId:number|string, pageId:number|string}} o
 */
export async function uiDeletePage(page, o = {}) {
  const appTile = page.locator(`a[href*="fb_flow_id=${o.appId}"]`);
  // Landing ist der „Pages"-Report (IRR) — genug Zeit lassen, bis er geladen ist (B-32: 1200ms war zu kurz).
  if (await appTile.count()) { await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2800); }
  const link = page.getByRole('link', { name: new RegExp(`\\b${o.pageId}\\b`) });
  if (!(await link.count())) return { ok: true, deleted: false, note: 'Seite existiert nicht.' };
  // Force-Klick: die IRR-Toolbar überlagert die Zelle und fängt normale Klicks ab (pointer-events intercept).
  await link.first().scrollIntoViewIfNeeded().catch(() => {});
  await link.first().click({ force: true }).catch(async () => { await link.first().evaluate((a) => a.click()).catch(() => {}); });
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(3000);
  if (!new RegExp(`${o.appId}:${o.pageId}\\b`).test(await page.title().catch(() => ''))) return { ok: false, error: 'Page Designer nicht geöffnet.' };
  await page.locator('#pdUtilities, button[aria-label*="Utilities" i], button[title*="Utilities" i]').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByText(/^Delete Page$/i).first().click().catch(async () => { await page.getByRole('menuitem', { name: /Delete Page/i }).first().click().catch(() => {}); });
  await page.waitForTimeout(1800);
  let clicked = false;
  for (const b of [page.getByRole('button', { name: /Permanently Delete Page/i }), page.getByRole('button', { name: /^Delete$/i }), page.locator('button.a-Button--hot:has-text("Delete")')]) { if (await b.count()) { await b.first().click(); clicked = true; break; } }
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
  const gone = !new RegExp(`${o.appId}:${o.pageId}\\b`).test(await page.title().catch(() => ''));
  return { ok: clicked && gone, deleted: gone };
}

/**
 * Deinstalliert ein Plug-in aus der App (Shared Components → Plug-ins → Plugin öffnen → Delete → bestätigen).
 * Für das vollständige Löschen eines Plugins aus der Test-App. Löscht nur das per displayName benannte
 * plugin-EIGENE Plug-in. @param {{appId:number|string, displayName:string}} o
 */
export async function uiDeletePlugin(page, o = {}) {
  const clickFirst = async (locs) => { for (const l of locs) { if (await l.count()) { await l.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1000); return true; } } return false; };
  const appTile = page.locator(`a[href*="fb_flow_id=${o.appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${o.appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1500);
  await clickFirst([page.getByRole('link', { name: /shared components/i }), page.getByText(/shared components/i)]);
  await clickFirst([page.getByRole('link', { name: /^plug-?ins$/i }), page.getByText(/^plug-?ins$/i)]);
  const nameRe = rxi(o.displayName);
  const listUrl = page.url();
  if (!(await clickFirst([page.getByRole('link', { name: nameRe })]))) return { ok: true, deleted: false, note: 'Plugin nicht in der Liste (schon entfernt?).' };
  await page.waitForTimeout(800);
  // Delete-Button auf der Plug-in-Edit-Seite. APEX BLENDET ihn aus, wenn das Plug-in noch REFERENZIERT ist
  // (z.B. auf einer Seite genutzt) — dann ehrlich melden statt zu tun als sei gelöscht. Sicherheits-Feature:
  // ein anderweitig genutztes Plugin wird nicht genullt (die eigene Testseite wird beim Purge vorher gelöscht).
  const delBtn = page.locator('button:has-text("Delete"), a.a-Button:has-text("Delete"), input[type=button][value="Delete" i]').first();
  if (!(await delBtn.count())) return { ok: false, deleted: false, note: 'Kein Delete-Button — Plug-in ist noch referenziert (erst alle Nutzungen/Testseite entfernen).' };
  page.on('dialog', (d) => d.accept().catch(() => {})); // Sicherung, falls confirmDelete einen NATIVEN Dialog nutzt
  await delBtn.click().catch(() => {});
  await page.waitForTimeout(1200);
  // Der Delete-Button ruft confirmDelete(...) → jQuery-UI-Bestätigungsdialog. Dessen Bestätigungs-Button
  // (OK/Delete) im DIALOG-Button-Pane klicken (NICHT den verdeckten Edit-Seiten-Delete-Button).
  const dlgOk = page.locator('.ui-dialog-buttonpane button, .ui-dialog button.ui-button, [role=dialog] button').filter({ hasText: /^(OK|Delete|Yes)$/i }).first();
  if (await dlgOk.count()) await dlgOk.click().catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2000);
  // Ehrlich verifizieren: zurück zur Plug-ins-Liste und prüfen, dass das Plugin dort WIRKLICH fehlt.
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(1500);
  const gone = !(await page.getByRole('link', { name: nameRe }).count());
  return { ok: gone, deleted: gone };
}

/**
 * Öffnet die Testseite im Page Designer: existiert sie → wiederverwenden, sonst per Create-Page-Wizard
 * (Blank) neu anlegen. Gemeinsame Basis für Region- UND Item-Testseiten. Setzt ein großes, festes Viewport
 * (Layout/Gallery-Positionen für den Maus-Drag vorhersehbar). Gibt {ok, mode|error} zurück; bei ok ist der
 * Page Designer der Zielseite offen.
 * @param {{appId:number|string, pageId:number|string, pageName:string}} o
 */
async function pdOpenOrCreatePage(page, o) {
  await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
  const settle = async (ms = 1500) => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms); };
  const wizFrame = () => page.frames().find((f) => f !== page.mainFrame());
  const appTile = page.locator(`a[href*="fb_flow_id=${o.appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${o.appId} nicht gefunden.` };
  // Landing ist der Pages-Report (IRR) — genug Zeit lassen, bis der Report die Seiten-Links geladen hat.
  // Sonst wird die BESTEHENDE Seite des Plugins nicht erkannt → fälschlich neu angelegt (statt wiederverwendet).
  await appTile.first().click(); await settle(2800);
  const existing = page.getByRole('link', { name: new RegExp(`\\b${o.pageId}\\b`) });
  let mode = 'reuse';
  if (await existing.count()) {
    // Force-/JS-Klick: die IRR-Toolbar überlagert die Zelle und fängt normale Klicks ab.
    await existing.first().scrollIntoViewIfNeeded().catch(() => {});
    await existing.first().click({ force: true }).catch(async () => { await existing.first().evaluate((a) => a.click()).catch(() => {}); });
    await settle(2500);
  } else {
    mode = 'create';
    await page.getByRole('button', { name: /create page/i }).first().click(); await page.waitForTimeout(3500);
    let fr = wizFrame();
    if (!fr) return { ok: false, error: 'Create-Page-Wizard nicht geöffnet.' };
    await fr.getByText(/^Blank Page$/i).first().click().catch(() => {});
    await fr.getByRole('button', { name: /^Next/i }).first().click().catch(() => {}); await page.waitForTimeout(2500);
    fr = wizFrame() || fr;
    await fr.evaluate(({ pg, nm }) => {
      const byLbl = (re) => [...document.querySelectorAll('input')].find((i) => { const l = document.querySelector(`label[for='${i.id}']`); return l && re.test(l.innerText); });
      const n = byLbl(/page number/i); if (n) { n.value = pg; try { apex.item(n.id).setValue(pg); } catch (e) { /* egal */ } }
      const m = byLbl(/^name$/i); if (m) { m.value = nm; try { apex.item(m.id).setValue(nm); } catch (e) { /* egal */ } }
    }, { pg: String(o.pageId), nm: o.pageName });
    await page.waitForTimeout(500);
    for (let i = 0; i < 4; i++) { const cr = fr.getByRole('button', { name: /^Create Page$|^Create$/i }); const nx = fr.getByRole('button', { name: /^Next/i }); if (await cr.count()) { await cr.first().click(); break; } else if (await nx.count()) { await nx.first().click(); } else break; await page.waitForTimeout(2000); fr = wizFrame() || fr; }
    await settle(2500);
  }
  if (!new RegExp(`${o.appId}:${o.pageId}`).test(await page.title().catch(() => ''))) return { ok: false, error: 'Page Designer nicht geöffnet.' };
  return { ok: true, mode };
}

/** T-149/T-150 — normalisiert die (Manifest-)Page-Items zu {name,type,submit}. Rein/ohne Browser → unit-testbar. */
export function normalizePageItems(items) {
  return (items || [])
    .map((i) => (typeof i === 'string' ? { name: i, type: 'Hidden', submit: false }
      : i && i.name ? { name: String(i.name), type: i.type || 'Hidden', submit: !!(i.ajaxItemsToSubmit ?? i.submit) } : null))
    .filter((i) => i && i.name);
}

/** Namen der als „Items to Submit" markierten Page-Items (für die Region-Verdrahtung). */
export function itemsToSubmitNames(items) {
  return normalizePageItems(items).filter((i) => i.submit).map((i) => i.name);
}

/**
 * T-149/T-150 — Hidden-Page-Items im Page Designer prüfen und (opt-in) physisch anlegen.
 *
 * Read-only-Default (opts.create=false): reine Bestandsaufnahme über window.pe (existing/missing), wie T-149.
 * Mit opts.create=true wird jedes fehlende Item über das Modell angelegt. ENTSCHEIDEND (Lehre aus dem
 * Vorfall, der eine Transaction hängen ließ und die Seite brach): die Modell-Transaction wird IMMER im
 * finally geschlossen (execute/…), egal ob die Anlage klappt, wirft oder die API fehlt. Dadurch kann die
 * Anlage die Seite NICHT mehr blockieren; schlägt sie fehl, wird das ehrlich gemeldet (kein stiller Erfolg).
 * Die Anlage ist bewusst opt-in und bis zur Live-Verifikation NICHT der Default.
 */
async function pdCreatePageItems(page, items, opts = {}) {
  const specs = normalizePageItems(items);
  if (!specs.length) return { created: 0, existing: [], missing: [], note: 'keine Page-Items nötig' };
  return page.evaluate(({ specs, create }) => {
    const m = window.pe;
    if (!m || !m.getComponents || !m.COMP_TYPE) return { created: 0, existing: [], missing: specs.map((s) => s.name.toUpperCase()), note: 'kein pe/Modell' };
    const have = new Set();
    try {
      for (const c of (m.getComponents(m.COMP_TYPE.PAGE_ITEM) || [])) {
        try { const v = c.getProperty(m.PROP.ITEM_NAME)?.getValue(); if (v) have.add(String(v).toUpperCase()); } catch { /* egal */ }
      }
    } catch (e) { return { created: 0, existing: [], missing: specs.map((s) => s.name.toUpperCase()), note: String(e && e.message || e).slice(0, 80) }; }
    const existing = specs.map((s) => s.name.toUpperCase()).filter((n) => have.has(n));
    const missing = specs.filter((s) => !have.has(s.name.toUpperCase()));
    if (!create) return { created: 0, existing, missing: missing.map((s) => s.name.toUpperCase()), note: missing.length ? 'read-only Bestandsaufnahme (Anlage nicht angefordert)' : 'alle vorhanden' };
    if (!missing.length) return { created: 0, existing, missing: [], note: 'alle vorhanden' };

    // Anlage — IMMER in einer Transaction, die im finally geschlossen wird (sonst „Finish pending
    // Transaction first!" → Seite blockiert). Das ist genau die Disziplin aus pdSetRegionSqlModel.
    let created = 0; const failed = [];
    let t = null;
    try {
      t = m.transaction && m.transaction.start ? m.transaction.start('aisp', 'create page items') : null;
      const pageId = m.getCurrentPageId ? m.getCurrentPageId() : undefined;
      for (const s of missing) {
        try {
          if (typeof m.createComponents === 'function') {
            const props = [{ id: m.PROP.ITEM_NAME, value: s.name }];
            if (m.PROP.ITEM_TYPE != null) props.push({ id: m.PROP.ITEM_TYPE, value: 'NATIVE_HIDDEN' });
            m.createComponents(pageId, [{ typeId: m.COMP_TYPE.PAGE_ITEM, properties: props }]);
            created++;
          } else { failed.push(s.name + ':no-create-api'); }
        } catch (e) { failed.push(s.name + ':' + String(e && e.message || e).slice(0, 40)); }
      }
    } catch (e) { failed.push('tx:' + String(e && e.message || e).slice(0, 40)); }
    finally { try { for (const fn of ['execute', 'done', 'commit', 'apply', 'end', 'close']) { if (t && typeof t[fn] === 'function') { t[fn](); break; } } } catch { /* egal */ } }
    return { created, existing, missing: missing.map((s) => s.name.toUpperCase()), failed: failed.length ? failed : undefined, note: created ? `angelegt: ${created}${failed.length ? `, fehlgeschlagen: ${failed.length}` : ''}` : 'Anlage fehlgeschlagen/kein Create-API — Live-Verifikation nötig' };
  }, { specs, create: !!opts.create });
}

/** Setzt die SQL-Quelle einer Region über das Page-Designer-MODELL (window.pe). Nötig, weil der
 *  Property-Editor bei BESTEHENDEN Regionen (Reuse) das Textarea-setValue nicht ins Modell übernimmt —
 *  pdSetProp meldet „ok", aber der Save persistiert die alte SQL (live am BI-Dashboard beobachtet).
 *  Nimmt die (einzige) Region mit SQL-Quelle der Testseite. */
async function pdSetRegionSqlModel(page, sql) {
  return page.evaluate(({ sql }) => {
    const model = window.pe;
    if (!model || !model.getComponents || !model.PROP) return 'no-pe';
    let t = null;
    try {
      const regions = model.getComponents(model.COMP_TYPE.REGION) || [];
      const withSql = regions.map((r) => { try { return { r, p: r.getProperty(model.PROP.REGION_SQL) }; } catch (e) { return { r, p: null }; } }).filter((x) => x.p);
      if (!withSql.length) return 'no-sql-region';
      // WICHTIG: setValue MUSS in einer Modell-Transaction laufen — sonst gilt die Änderung nicht als
      // dirty und der Save persistiert sie nicht (empirisch verifiziert). Die Transaction wird IMMER
      // beendet (finally) — sonst blockiert eine hängende Transaction alle folgenden Schritte („Finish
      // pending Transaction first!", live beobachtet an Seite 20004).
      t = model.transaction && model.transaction.start ? model.transaction.start('aisp', 'set region sql') : null;
      withSql[0].p.setValue(sql);
      return 'ok';
    } catch (e) { return 'err:' + String(e?.message ?? e).slice(0, 80); }
    // Das von start() zurückgegebene HANDLE ist ein Undo/Redo-COMMAND (Methoden: execute/cancel/undo/redo);
    // model.transaction selbst hat KEIN end(). Der Abschluss/Commit ist t.execute() — ohne ihn bleibt die
    // Transaction offen und blockiert ALLE folgenden Property-Änderungen („Finish pending Transaction first!",
    // live an Seite 20004 diagnostiziert). execute zuerst, dann tolerante Fallbacks.
    finally { try { for (const fn of ['execute', 'done', 'commit', 'apply', 'end', 'close']) { if (t && typeof t[fn] === 'function') { t[fn](); break; } } } catch { /* egal */ } }
  }, { sql });
}

/** Setzt die Template-Position der aktuell selektierten Region auf „Body" — der Gallery-Drag lässt
 *  Regionen sonst in der zuerst getroffenen Position (z.B. Banner/Header) landen, was optisch falsch
 *  sitzt (T-148/Nutzer-Feedback). Property heißt je nach APEX-Version „Position" oder „Slot". */
async function pdSetRegionBody(page) {
  let r = await pdSetProp(page, 'Position', 'Body');
  if (r !== 'ok') r = await pdSetProp(page, 'Slot', 'Body');
  await page.waitForTimeout(500);
  return r;
}

/** Seite öffentlich machen + speichern (gemeinsamer Abschluss für Region-/Item-/DA-Testseiten).
 *  Zuerst auf den Rendering-Tab schalten — nur dort führt der Page-Root-Knoten zuverlässig die
 *  Page-Attribute inkl. „Authentication" (aus dem DA-/Processing-Tab fehlt das Feld → Seite bliebe privat). */
async function pdPublishAndSave(page, o) {
  await page.locator('[role=tab]:has-text("Rendering")').first().click().catch(() => {}); await page.waitForTimeout(700);
  await page.locator('.a-TreeView-label').filter({ hasText: rxi(`Page ${o.pageId}`) }).first().click().catch(() => {}); await page.waitForTimeout(700);
  let auth = await pdSetProp(page, 'Authentication', 'Page Is Public');
  if (auth !== 'ok') { // Fallback: Page-Attribute-Tab öffnen, dann erneut
    await page.locator('[role=tab]:has-text("Attributes")').first().click().catch(() => {}); await page.waitForTimeout(700);
    auth = await pdSetProp(page, 'Authentication', 'Page Is Public');
  }
  await page.waitForTimeout(400);
  await page.locator('#pdSave, button:has-text("Save")').first().click().catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const saveError = (body.match(/ORA-\d+[^.]{0,100}|could not be saved|processing failed/i) || [])[0] || null;
  return { auth, saveError };
}

/**
 * Baut eine Testseite für ein ITEM-Plugin im PAGE DESIGNER: Create/Reuse-Seite → Host-Region (Static
 * Content) per Drag → Page-Item VOM Plugin-Typ per Drag aus der Items-Gallery IN die Host-Region → Item-Name
 * + Custom-Attribute (z.B. „Color Json") → Seite öffentlich → Save. Generisch für jedes Item-Plugin.
 * @param {{appId:number|string, pageId:number|string, pageName:string, pluginDisplayName:string,
 *          itemName:string, hostRegionName?:string, attributes?:Array<{prompt:string,value:string}>}} o
 */
export async function uiCreateItemTestPage(page, o = {}) {
  const opened = await pdOpenOrCreatePage(page, o);
  if (!opened.ok) return opened;
  const hostName = o.hostRegionName || 'Host';

  // 1) Host-Region (Static Content) anlegen, falls noch nicht vorhanden.
  let hostNode = page.getByText(new RegExp(`^${rxEsc(hostName)}$`)).first();
  if (!(await hostNode.count())) {
    await page.locator('button:has-text("Regions"),[role=tab]:has-text("Regions")').first().click().catch(() => {}); await page.waitForTimeout(1000);
    const rsrc = page.locator('.a-Gallery-region').filter({ hasText: /Static Content/i }).first();
    if (!(await rsrc.count())) return { ok: false, error: 'Static-Content-Region nicht in der Gallery.' };
    await rsrc.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(400);
    const rb = await rsrc.boundingBox();
    await pdMouseDrag(page, rb, Math.round(1500 * 0.57), Math.min(rb.y - 80, 684));
    await pdSetProp(page, 'Name', hostName);
    await page.waitForTimeout(500);
  }
  await page.getByText(new RegExp(`^${rxEsc(hostName)}$`)).first().click().catch(() => {}); await page.waitForTimeout(800);
  await pdSetRegionBody(page); // Host-Region in den BODY (nicht Banner/Header)

  // Host-Region-Position im LAYOUT (Grid) ermitteln — bewusst NUR im Layout-Panel suchen (nicht im
  // Rendering-Tree), damit das Item-Drop-Ziel die echte Region-Fläche trifft. Drop-Ziel für das Item.
  const hostBox = await page.evaluate((name) => {
    const re = new RegExp(name, 'i');
    const el = [...document.querySelectorAll('.a-Designer-gridRegion, [class*=Designer] [class*=region], .a-Designer-region')].find((e) => re.test(e.innerText || ''));
    const box = el?.getBoundingClientRect();
    return box && box.width > 0 ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null;
  }, rxEsc(hostName)).catch(() => null);

  // 2) Item VOM Plugin-Typ anlegen — ODER, bei Wiederverwendung der Seite, das schon vorhandene Item
  //    selektieren (kein zweites Item anlegen; der erneute Update-Test soll die Seite nicht zumüllen).
  const itemRx = new RegExp(`^${rxEsc(o.itemName)}$`);
  let rName = 'ok'; let selName = o.itemName;
  if (await page.getByText(itemRx).count()) {
    await page.getByText(itemRx).first().click(); await page.waitForTimeout(800);
  } else {
    await page.locator('[role=tab]:has-text("Items"), button:has-text("Items")').first().click().catch(() => {}); await page.waitForTimeout(1200);
    const isrc = page.locator('.a-Gallery-pageItem').filter({ hasText: rxi(o.pluginDisplayName) }).first();
    if (!(await isrc.count())) return { ok: false, error: `Item-Typ „${o.pluginDisplayName}" nicht in der Items-Gallery (installiert?).` };
    await isrc.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
    const ib = await isrc.boundingBox();
    const tx = hostBox ? hostBox.x + Math.min(hostBox.w / 2, 120) : Math.round(1500 * 0.5);
    const ty = hostBox ? hostBox.y + Math.min(hostBox.h / 2, 40) : 300;
    await pdMouseDrag(page, ib, tx, ty);
    // Prüfen, ob ein Page-Item entstand (neuer Knoten P<page>_… bzw. selektiertes Name-Property).
    selName = await page.evaluate(() => { const pr = [...document.querySelectorAll('.a-Property')].find((e) => (e.querySelector('.a-Property-label')?.innerText || '').trim() === 'Name'); const inp = pr?.querySelector('input,textarea'); return inp ? inp.value : null; });
    if (!selName || !/^P\d+_/.test(selName)) return { ok: false, error: 'Item-Drag verfehlte die Host-Region (kein Page-Item angelegt).' };
    // 3) Item benennen + selektieren.
    rName = await pdSetProp(page, 'Name', o.itemName);
    await page.getByText(itemRx).first().click().catch(() => {}); await page.waitForTimeout(800);
  }
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // 4) Öffentlich + Save.
  const { auth, saveError } = await pdPublishAndSave(page, o);
  return { ok: rName === 'ok' && !saveError, mode: opened.mode, item: { name: rName, was: selName }, attributes: attrs, auth, saveError };
}

/**
 * Baut eine Testseite für ein DYNAMIC-ACTION-Plugin im PAGE DESIGNER: Create/Reuse-Seite → Dynamic-Actions-
 * Tab → Rechtsklick auf das Event (Standard „Page Load") → „Create Dynamic Action" → die True-Aktion „Show"
 * auf den Plugin-Typ setzen → Selection Type + Selektor (Standard: jQuery Selector „body") → Custom-Attribute
 * → Seite öffentlich → Save. Generisch für jedes DA-Plugin. Hinweis: DAs rendern oft einen Effekt (Canvas/
 * WebGL); die Render-Verifikation kann headless je nach Plugin eingeschränkt sein (ehrlich gemeldet).
 * @param {{appId:number|string, pageId:number|string, pageName:string, pluginDisplayName:string,
 *          event?:string, selectionType?:string, selector?:string, attributes?:Array<{prompt:string,value:string}>}} o
 */
export async function uiCreateDynamicActionTestPage(page, o = {}) {
  const opened = await pdOpenOrCreatePage(page, o);
  if (!opened.ok) return opened;
  const event = o.event || 'Page Load';
  const selectionType = o.selectionType || 'jQuery Selector';
  const selector = o.selector || 'body';

  // 1) Dynamic-Actions-Tab öffnen. Existiert bei Seiten-Wiederverwendung schon eine DA mit diesem Plugin,
  //    diese selektieren statt eine ZWEITE anzulegen (erneuter Update-Test soll nicht zumüllen).
  await page.locator('[role=tab]:has-text("Dynamic Actions")').first().click().catch(() => {}); await page.waitForTimeout(1200);
  const reselect = async () => { await page.locator('.a-TreeView-label').filter({ hasText: rxi(o.pluginDisplayName) }).first().click().catch(() => {}); await page.waitForTimeout(900); };
  let act = 'ok';
  if (await page.locator('.a-TreeView-label').filter({ hasText: rxi(o.pluginDisplayName) }).count()) {
    await reselect();
  } else {
    // Event-Knoten rechtsklicken → „Create Dynamic Action".
    const evNode = page.locator('.a-TreeView-label').filter({ hasText: new RegExp(`^${rxEsc(event)}$`) }).first();
    if (!(await evNode.count())) return { ok: false, error: `Event „${event}" im DA-Baum nicht gefunden.` };
    await evNode.click().catch(() => {}); await page.waitForTimeout(300);
    await evNode.click({ button: 'right' }).catch(() => {}); await page.waitForTimeout(1000);
    await page.getByText(/^Create Dynamic Action$/i).first().click().catch(async () => { await page.getByRole('menuitem', { name: /Create Dynamic Action/i }).first().click().catch(() => {}); });
    await page.waitForTimeout(2200);
    if (!(await page.locator('.a-TreeView-label').filter({ hasText: /^Show$/ }).count())) return { ok: false, error: 'Dynamic Action wurde nicht angelegt (keine „Show"-Aktion).' };
    // True-Aktion „Show" selektieren → Action auf den Plugin-Typ setzen. Danach heißt der Knoten
    // „<Plugin> [Plug-In]" → für alle weiteren Property-Zugriffe RE-SELEKTIEREN.
    await page.locator('.a-TreeView-label').filter({ hasText: /^Show$/ }).first().click().catch(() => {}); await page.waitForTimeout(1000);
    act = await pdSetProp(page, 'Action', o.pluginDisplayName);
    if (act !== 'ok') return { ok: false, error: `Action „${o.pluginDisplayName}" nicht setzbar (installiert?): ${act}` };
    await page.waitForTimeout(1200);
    await reselect();
  }

  // 3) Ziel-Element festlegen (Selection Type + Selektor) — sonst bleibt „Selection Type (Error)" und der
  //    Save wird blockiert (Seite bliebe privat). Selektor-Feld-Label = gewählter Selection-Type.
  const selType = await pdSetProp(page, 'Selection Type', selectionType);
  await page.waitForTimeout(900);
  const selField = await pdSetProp(page, selectionType, selector);
  await page.waitForTimeout(500);

  // 4) Plugin-Custom-Attribute setzen (ConfigJSON, Animation Type etc.) — Aktion nochmal re-selektieren.
  await reselect();
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // 5) Öffentlich + Save.
  const { auth, saveError } = await pdPublishAndSave(page, o);
  return { ok: act === 'ok' && !saveError, mode: opened.mode, action: act, selection: { type: selType, selector: selField }, attributes: attrs, auth, saveError };
}

/**
 * Baut eine Testseite für ein TEMPLATE-COMPONENT-Plugin im PAGE DESIGNER. Template Components sind
 * region-artig (in der Regions-Gallery) und datengebunden: Create/Reuse-Seite → TC per Drag aus der Regions-
 * Gallery → Name → Source „Type"=SQL Query + Beispiel-SQL → Spalten-Mapping (z.B. Title=&TITLE.) → Pflicht-
 * Attribute (Defaults) → öffentlich → Save. Generisch; das Spalten-Mapping ist Best-Effort (TC-spezifische
 * Feldnamen), fehlende Felder werden ignoriert (no-prop). @param {{appId,pageId,pageName,pluginDisplayName,
 * regionName,sourceSql?,columnMap?:object,attributes?:Array<{prompt,value}>}} o
 */
export async function uiCreateTemplateComponentTestPage(page, o = {}) {
  const opened = await pdOpenOrCreatePage(page, o);
  if (!opened.ok) return opened;
  const rx = new RegExp(`^${rxEsc(o.regionName)}$`);
  const reselect = async () => { await page.getByText(rx).first().click().catch(() => {}); await page.waitForTimeout(800); };

  // 1) TC als Region aus der Gallery ziehen (falls nicht schon vorhanden).
  if (!(await page.getByText(rx).count())) {
    await page.locator('button:has-text("Regions"),[role=tab]:has-text("Regions")').first().click().catch(() => {}); await page.waitForTimeout(1000);
    const src = page.locator('.a-Gallery-region').filter({ hasText: rxi(o.pluginDisplayName) }).first();
    if (!(await src.count())) return { ok: false, error: `Template Component „${o.pluginDisplayName}" nicht in der Regions-Gallery (installiert?).` };
    await src.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(400);
    const sb = await src.boundingBox();
    if (!sb) return { ok: false, error: 'Gallery-Item nicht sichtbar.' };
    await pdMouseDrag(page, sb, Math.round(1500 * 0.57), Math.min(sb.y - 80, 684));
    await pdSetProp(page, 'Name', o.regionName);
  }
  await reselect();
  await pdSetRegionBody(page); // TC-Region in den BODY (nicht Banner/Header)
  await reselect();

  // 2) Datenquelle: Source-„Type" = SQL Query (per Option, nicht Label — „Type" ist mehrdeutig) + SQL.
  const srcType = await pdSetSelectByOption(page, 'SQL Query');
  await page.waitForTimeout(900);
  let sql = o.sourceSql ? await pdSetProp(page, 'SQL Query', o.sourceSql) : 'skip';
  if (o.sourceSql) { const m = await pdSetRegionSqlModel(page, o.sourceSql); if (m === 'ok') sql = 'ok'; } // Reuse-fest (Modell)
  await page.waitForTimeout(1000);
  await reselect();

  // 3) Spalten-Mapping (Best-Effort) + Pflicht-Attribute (Defaults).
  const maps = [];
  for (const [label, value] of Object.entries(o.columnMap || {})) { maps.push({ label, r: await pdSetProp(page, label, value) }); }
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // 4) Öffentlich + Save.
  const { auth, saveError } = await pdPublishAndSave(page, o);
  return { ok: srcType === 'ok' && (sql === 'ok' || sql === 'skip') && !saveError, mode: opened.mode, sourceType: srcType, sql, columnMap: maps, attributes: attrs, auth, saveError };
}

/**
 * Baut eine Testseite komplett im PAGE DESIGNER (statt des in dieser Instanz WAF-blockierten Wizard-Imports,
 * B-30): Create-Page-Wizard (Blank) → Plugin-Region per jQuery-UI-Maus-Drag aus der Regions-Gallery →
 * Region-Name + SQL-Quelle + Custom-Attribute (ConfigJSON etc.) → Seite öffentlich → Save-Button. Existiert
 * die Seite schon (gleiches Plugin), wird sie WIEDERVERWENDET (Region aktualisiert statt neu angelegt).
 * @param {{appId:number|string, pageId:number|string, pageName:string, pluginDisplayName:string,
 *          regionName:string, sourceSql?:string, attributes?:Array<{prompt:string,value:string}>}} o
 */
export async function uiCreateTestPage(page, o = {}) {
  // Großes, festes Viewport → Layout/Gallery-Positionen sind vorhersehbar (der Region-Drag arbeitet mit
  // echten Maus-Koordinaten; ein kleines/Default-Viewport verfehlt die Body-Fläche).
  await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
  const settle = async (ms = 1500) => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms); };
  const wizFrame = () => page.frames().find((f) => f !== page.mainFrame());
  const appTile = page.locator(`a[href*="fb_flow_id=${o.appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${o.appId} nicht gefunden.` };
  await appTile.first().click(); await settle();

  // Existiert die Seite schon? → wiederverwenden (Page Designer öffnen), sonst Create-Page-Wizard.
  const existing = page.getByRole('link', { name: new RegExp(`\\b${o.pageId}\\b`) });
  let mode = 'reuse';
  if (await existing.count()) {
    await existing.first().click(); await settle(2500);
  } else {
    mode = 'create';
    await page.getByRole('button', { name: /create page/i }).first().click(); await page.waitForTimeout(3500);
    let fr = wizFrame();
    if (!fr) return { ok: false, error: 'Create-Page-Wizard nicht geöffnet.' };
    await fr.getByText(/^Blank Page$/i).first().click().catch(() => {});
    await fr.getByRole('button', { name: /^Next/i }).first().click().catch(() => {}); await page.waitForTimeout(2500);
    fr = wizFrame() || fr;
    await fr.evaluate(({ pg, nm }) => {
      const byLbl = (re) => [...document.querySelectorAll('input')].find((i) => { const l = document.querySelector(`label[for='${i.id}']`); return l && re.test(l.innerText); });
      const n = byLbl(/page number/i); if (n) { n.value = pg; try { apex.item(n.id).setValue(pg); } catch (e) { /* egal */ } }
      const m = byLbl(/^name$/i); if (m) { m.value = nm; try { apex.item(m.id).setValue(nm); } catch (e) { /* egal */ } }
    }, { pg: String(o.pageId), nm: o.pageName });
    await page.waitForTimeout(500);
    for (let i = 0; i < 4; i++) { const cr = fr.getByRole('button', { name: /^Create Page$|^Create$/i }); const nx = fr.getByRole('button', { name: /^Next/i }); if (await cr.count()) { await cr.first().click(); break; } else if (await nx.count()) { await nx.first().click(); } else break; await page.waitForTimeout(2000); fr = wizFrame() || fr; }
    await settle(2500);
  }
  if (!new RegExp(`${o.appId}:${o.pageId}`).test(await page.title().catch(() => ''))) return { ok: false, error: 'Page Designer nicht geöffnet.' };

  // Plugin-Region: existiert sie schon → im Baum selektieren, sonst per Drag aus der Regions-Gallery anlegen.
  const regionNode = page.getByText(new RegExp(`^${rxEsc(o.regionName)}$`)).first();
  if (await regionNode.count()) {
    await regionNode.click(); await page.waitForTimeout(1000);
  } else {
    await page.locator('button:has-text("Regions"),[role=tab]:has-text("Regions")').first().click().catch(() => {}); await page.waitForTimeout(1000);
    const src = page.locator('.a-Gallery-region').filter({ hasText: rxi(o.pluginDisplayName) }).first();
    if (!(await src.count())) return { ok: false, error: `Plugin „${o.pluginDisplayName}" nicht in der Regions-Gallery (installiert?).` };
    // Gallery-Item in den sichtbaren Bereich scrollen — bei vielen installierten Plugins liegt es sonst
    // UNTER dem Viewport (Maus-Drag würde off-screen starten und die Body-Fläche verfehlen).
    await src.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    const sb = await src.boundingBox();
    if (!sb) return { ok: false, error: `Gallery-Item „${o.pluginDisplayName}" nicht sichtbar (Scroll fehlgeschlagen).` };
    // Drop in die untere Body-Fläche der Layout-Ansicht (bewiesene Position). jQuery-UI-Draggable → echte
    // Maus-Events: down → Threshold-Bewegung → in Schritten zum Ziel → up. Ziel bewusst OBERHALB der Gallery
    // (die Gallery liegt unten ~y795; ein Ziel darunter verfehlt die Layout-Fläche und legt KEINE Region an).
    const vp = page.viewportSize() || { width: 1500, height: 950 };
    const tx = Math.round(vp.width * 0.57); // Layout-Panel-Mitte
    const ty = Math.min(sb.y - 80, Math.round(vp.height * 0.72)); // Body-Fläche, klar über der Gallery
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 8, sb.y + sb.height / 2 + 8); await page.waitForTimeout(200);
    for (let i = 1; i <= 12; i++) { await page.mouse.move(sb.x + (tx - sb.x) * i / 12, sb.y + (ty - sb.y) * i / 12); await page.waitForTimeout(60); }
    await page.mouse.move(tx, ty); await page.waitForTimeout(400); await page.mouse.up();
    await page.waitForTimeout(2500);
    // Verifizieren, dass eine Plugin-Region entstand (sonst hat der Drop die Layout-Fläche verfehlt).
    if (!(await page.getByText(new RegExp(`^${rxEsc(o.regionName)}$`)).count()) && !(await page.locator('.a-Property').filter({ hasText: /SQL Query/ }).count())) {
      return { ok: false, error: 'Plugin-Region-Drag verfehlte die Body-Fläche (keine Region angelegt).' };
    }
  }

  // Region konfigurieren. Zuerst Name → dann die Region über ihren neuen Namen im Baum RE-SELEKTIEREN,
  // damit der Property-Editor sicher auf die Region zeigt (SQL Query/Custom-Attribute sind sonst nach dem
  // Drag zeitweise nicht im DOM → „no-prop").
  const rName = await pdSetProp(page, 'Name', o.regionName);
  await page.getByText(new RegExp(`^${rxEsc(o.regionName)}$`)).first().click().catch(() => {});
  await page.waitForTimeout(900);
  const rPos = await pdSetRegionBody(page); // Region gehört in den BODY, nicht in die Drop-Zufallsposition
  let rSql = o.sourceSql ? await pdSetProp(page, 'SQL Query', o.sourceSql) : 'skip';
  // Modell-Set obendrauf: bei Reuse übernimmt der Property-Editor das Textarea-setValue NICHT ins Modell.
  let __mSql = 'skip'; if (o.sourceSql) { __mSql = await pdSetRegionSqlModel(page, o.sourceSql); if (__mSql === 'ok') rSql = 'ok'; }
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // T-149/T-150: benötigte Hidden-Page-Items. Default read-only (nur Bestandsaufnahme). Mit
  // o.createPageItems=true werden fehlende Items transaction-sicher angelegt (finally schließt IMMER →
  // kann die Seite nicht mehr blockieren) und die „Items to Submit"-Liste der Region verdrahtet.
  let pageItems = null;
  if (o.pageItems && o.pageItems.length) {
    pageItems = await pdCreatePageItems(page, o.pageItems, { create: !!o.createPageItems });
    if (o.createPageItems) {
      const submit = itemsToSubmitNames(o.pageItems);
      if (submit.length) {
        await page.getByText(new RegExp(`^${rxEsc(o.regionName)}$`)).first().click().catch(() => {});
        await page.waitForTimeout(500);
        pageItems.itemsToSubmit = await pdSetProp(page, 'Page Items to Submit', submit.join(','));
      }
    }
  }

  // Seite öffentlich machen (Page-Root selektieren → „Authentication" = Page Is Public).
  await page.locator('.a-TreeView-label').filter({ hasText: rxi(`Page ${o.pageId}`) }).first().click().catch(() => {}); await page.waitForTimeout(700);
  const auth = await pdSetProp(page, 'Authentication', 'Page Is Public');

  // Speichern über den Save-Button (Strg+S feuert headless nicht zuverlässig).
  await page.waitForTimeout(400);
  await page.locator('#pdSave, button:has-text("Save")').first().click().catch(() => {});
  await settle(2500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const saveError = (body.match(/ORA-\d+[^.]{0,100}|could not be saved|processing failed/i) || [])[0] || null;
  return { ok: rName === 'ok' && (rSql === 'ok' || rSql === 'skip') && !saveError, mode, region: { name: rName, sql: rSql, position: rPos, model: __mSql }, attributes: attrs, pageItems, auth, saveError };
}

/**
 * Setzt Plugin-Region-Attribute (z.B. ConfigJSON) über den PAGE DESIGNER — der zuverlässige Weg,
 * weil der Seiten-Import-Wizard p_attribute_NN nicht persistiert (B-28). Öffnet die Seite im Page
 * Designer (session-erhaltend per Klick, KEIN goto), wählt die Region und setzt jedes Attribut
 * anhand seines Property-Labels (= Plugin-Attribut-Prompt), dann Strg+S.
 * @param {{appId:number|string, pageId:number|string, regionName:string,
 *          attributes:Array<{label:string, value:string}>}} o
 */
export async function uiSetPluginAttributes(page, o = {}) {
  const attrs = (o.attributes || []).filter((a) => a && a.label && a.value != null && a.value !== '');
  if (!attrs.length) return { ok: true, skipped: 'keine Attribute' };
  const appTile = page.locator(`a[href*="fb_flow_id=${o.appId}"]`);
  if (!(await appTile.count())) return { ok: false, error: `App ${o.appId} nicht gefunden.` };
  await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1200);
  // In der Pages-Liste die Seite anklicken → Page Designer (session-erhaltend).
  let opened = false;
  for (const l of [page.getByRole('link', { name: new RegExp(`\\b${o.pageId}\\b`) }), page.locator(`a:has-text("${o.pageId}")`)]) {
    if (await l.count()) { await l.first().click(); opened = true; break; }
  }
  if (!opened) return { ok: false, error: `Seite ${o.pageId} in der Liste nicht gefunden.` };
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(3500);
  if (!new RegExp(`${o.appId}:${o.pageId}`).test(await page.title().catch(() => ''))) {
    return { ok: false, error: 'Page Designer nicht geöffnet (Titel weicht ab).' };
  }
  // Region-Knoten im Rendering-Tree wählen → Property-Editor lädt die Plugin-Attribute.
  const nameRe = new RegExp(`^${String(o.regionName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const node = page.getByText(nameRe);
  if (!(await node.count())) return { ok: false, error: `Region „${o.regionName}" im Baum nicht gefunden.` };
  await node.first().click(); await page.waitForTimeout(2000);
  // Jedes Attribut anhand seines Property-Labels setzen (über die APEX-Item-API des Feldes).
  const results = [];
  for (const a of attrs) {
    const res = await page.evaluate(({ label, value }) => {
      const props = [...document.querySelectorAll('.a-Property')];
      const p = props.find((el) => (el.querySelector('.a-Property-label')?.innerText || '').trim() === label);
      if (!p) return { label, error: 'Property nicht gefunden' };
      const inp = p.querySelector('textarea, input, select');
      if (!inp || !inp.id) return { label, error: 'Feld ohne id' };
      try {
        if (window.apex && apex.item(inp.id) && apex.item(inp.id).node) {
          apex.item(inp.id).setValue(value);
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
          return { label, set: true, id: inp.id };
        }
      } catch (e) { return { label, error: String(e.message || e) }; }
      return { label, error: 'apex.item fehlt' };
    }, { label: a.label, value: a.value });
    results.push(res);
  }
  // Speichern (Strg+S), sonst Save-Button.
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2000);
  const saveBtn = page.locator('#pdSave, button:has-text("Save")');
  if (await saveBtn.count()) { await saveBtn.first().click().catch(() => {}); }
  await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(2500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const saveError = (body.match(/ORA-\d+[^.]{0,120}|processing failed|could not be saved/i) || [])[0] || null;
  return { ok: results.every((r) => r.set) && !saveError, results, saveError };
}

/**
 * Headless Render-Smoke-Test einer bereits geladenen Seite: erkennt APEX-Fehlerseiten (ORA-/
 * is_internal_error) und Login-Redirects ehrlich (kein False-Green) und prüft sichtbares Rendern.
 * Der Aufrufer navigiert zur URL und sammelt JS-Fehler (errors) via page.on('pageerror'/'console').
 * @param {string[]} errors  gesammelte JS-Fehler
 * @param {{selector?:string, settleMs?:number, expectMarker?:string}} o
 *   expectMarker: Text, der im Seitentitel stehen MUSS (z.B. Plugin-Name) — sonst zeigt die URL noch
 *   eine ALTE/fremde Seite (Import nicht durchgelaufen) → kein Grün auf einem übrig gebliebenen SVG.
 */
export async function smokeCheckPage(page, errors = [], o = {}) {
  await page.waitForTimeout(o.settleMs ?? 3500); // Plugin-Init/async-Render (mxGraph u.ä.) abwarten
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const pageTitle = (await page.locator('title').first().innerText().catch(() => '')) || '';
  const apexError = /Error processing request|apex_error_code|ORA-\d{4,5}/i.test(body)
    ? (body.match(/ORA-\d{4,5}: [^A-Z]{0,80}|apex_error_code: [\w.]+/i) || ['APEX-Fehlerseite'])[0] : null;
  const is404 = /Not Found|HTTP Status Code: 404/i.test(body);
  const sel = o.selector || 'body';
  const visibleText = (await page.locator(sel).first().innerText().catch(() => '')).trim();
  const hasGraphics = await page.locator('canvas, svg, .mxgraph, [class*="mx"]').count();
  // Nicht jedes Plugin rendert SVG/Canvas (z.B. Bargraphs = Divs) → generisch prüfen, ob eine REGION echten
  // Inhalt hat: Region-Body mit sichtbarem Text oder mehreren Kind-Elementen. Verhindert False-Negative.
  const regionContent = await page.locator('.t-Region-body, [class*="Region-body"], .a-Region-body').evaluateAll(
    (els) => els.some((e) => (e.innerText || '').trim().length > 2 || e.querySelectorAll('div,span,canvas,svg,table,ul,li,i,img').length > 3),
  ).catch(() => false);
  const stillLogin = /sign-in|\/login/i.test(page.url());
  // Titel-Abgleich: zeigt die Seite noch das falsche Plugin, ist der Import NICHT durchgelaufen.
  const wrongPage = o.expectMarker && pageTitle && !pageTitle.toLowerCase().includes(String(o.expectMarker).toLowerCase()) ? pageTitle : null;
  const hasRender = hasGraphics > 0 || regionContent;
  const ok = !apexError && !is404 && !stillLogin && !wrongPage && errors.length === 0 && (visibleText.length > 0 || hasRender);
  return {
    ok, url: page.url().replace(/session=\d+/, 'session=…'), apexError, is404: is404 || undefined, needsLogin: stillLogin || undefined,
    wrongPage: wrongPage || undefined, pageTitle,
    jsErrors: errors.slice(0, 20), rendered: !apexError && !is404 && !wrongPage && hasRender, graphics: hasGraphics, regionContent: regionContent || undefined,
    note: apexError ? `APEX-Fehlerseite: ${apexError} — Plugin-Render schlug fehl (Region-/Laufzeit-Setup prüfen).`
      : is404 ? 'Seite nicht gefunden (404) — Seiten-ID/Alias prüfen.'
        : wrongPage ? `Falsche Seite gerendert („${wrongPage}") — Seiten-Import lief nicht durch (kein Grün auf Fremd-Inhalt).`
          : stillLogin ? 'Laufzeit verlangt App-Login (Seite nicht öffentlich?).' : undefined,
  };
}
