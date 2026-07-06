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
 * Anmeldung an der modernen APEX-Workspace-Sign-In-Seite (Workspace + Database Username + Passwort).
 * @param {import('playwright').Page} page
 * @param {{baseUrl:string, workspace:string, user:string, pass:string}} cfg
 */
export async function uiLogin(page, cfg = {}) {
  const { baseUrl, workspace, user, pass } = cfg;
  if (!baseUrl) return { ok: false, error: 'baseUrl fehlt.' };
  if (!workspace || !user || !pass) return { ok: false, error: 'Login unvollständig — workspace, user, pass nötig.' };
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
    if (!urls?.length) return { field: id, skipped: 'keine Dateien' };
    return page.evaluate(({ id, val, overwrite }) => {
      const t = document.getElementById(id); if (!t) return { field: id, error: 'Feld fehlt' };
      if (t.value && t.value.trim() && !overwrite) return { field: id, skipped: 'bereits gesetzt' };
      t.value = val; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (window.apex && apex.item) apex.item(id).setValue(val); } catch (e) { /* egal */ }
      return { field: id, set: true, count: val.split('\n').filter(Boolean).length };
    }, { id, val: urls.join('\n'), overwrite: !!o.overwrite });
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

/** Property im Page-Designer-Property-Editor per Label setzen (Text→apex.item, Select→Options-Text→Value). */
async function pdSetProp(page, label, value) {
  return page.evaluate(({ label, value }) => {
    const pr = [...document.querySelectorAll('.a-Property')].find((e) => (e.querySelector('.a-Property-label')?.innerText || '').trim() === label);
    if (!pr) return 'no-prop';
    const inp = pr.querySelector('input,textarea,select'); if (!inp || !inp.id) return 'no-input';
    let v = value;
    if (inp.tagName === 'SELECT') { const opt = [...inp.options].find((o) => o.text.trim().toLowerCase() === String(value).toLowerCase() || o.text.trim().toLowerCase().includes(String(value).toLowerCase())); if (!opt) return 'no-option'; v = opt.value; }
    try { if (window.apex && apex.item(inp.id) && apex.item(inp.id).node) { apex.item(inp.id).setValue(v); inp.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; } } catch (e) { return 'err:' + e.message; }
    return 'noitem';
  }, { label, value });
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
  if (await appTile.count()) { await appTile.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1200); }
  const link = page.getByRole('link', { name: new RegExp(`\\b${o.pageId}\\b`) });
  if (!(await link.count())) return { ok: true, deleted: false, note: 'Seite existiert nicht.' };
  await link.first().click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(3000);
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
  await appTile.first().click(); await settle();
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
  return { ok: true, mode };
}

/** Seite öffentlich machen + speichern (gemeinsamer Abschluss für Region- und Item-Testseiten). */
async function pdPublishAndSave(page, o) {
  await page.locator('.a-TreeView-label').filter({ hasText: rxi(`Page ${o.pageId}`) }).first().click().catch(() => {}); await page.waitForTimeout(700);
  const auth = await pdSetProp(page, 'Authentication', 'Page Is Public');
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

  // Host-Region-Position im LAYOUT (Grid) ermitteln — bewusst NUR im Layout-Panel suchen (nicht im
  // Rendering-Tree), damit das Item-Drop-Ziel die echte Region-Fläche trifft. Drop-Ziel für das Item.
  const hostBox = await page.evaluate((name) => {
    const re = new RegExp(name, 'i');
    const el = [...document.querySelectorAll('.a-Designer-gridRegion, [class*=Designer] [class*=region], .a-Designer-region')].find((e) => re.test(e.innerText || ''));
    const box = el?.getBoundingClientRect();
    return box && box.width > 0 ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null;
  }, rxEsc(hostName)).catch(() => null);

  // 2) Item VOM Plugin-Typ aus der Items-Gallery in die Host-Region ziehen.
  const treeBefore = await page.locator('.a-TreeView-label').evaluateAll((els) => els.map((e) => e.innerText.trim()));
  await page.locator('[role=tab]:has-text("Items"), button:has-text("Items")').first().click().catch(() => {}); await page.waitForTimeout(1200);
  const isrc = page.locator('.a-Gallery-pageItem').filter({ hasText: rxi(o.pluginDisplayName) }).first();
  if (!(await isrc.count())) return { ok: false, error: `Item-Typ „${o.pluginDisplayName}" nicht in der Items-Gallery (installiert?).` };
  await isrc.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300);
  const ib = await isrc.boundingBox();
  const tx = hostBox ? hostBox.x + Math.min(hostBox.w / 2, 120) : Math.round(1500 * 0.5);
  const ty = hostBox ? hostBox.y + Math.min(hostBox.h / 2, 40) : 300;
  await pdMouseDrag(page, ib, tx, ty);
  // Prüfen, ob ein Page-Item entstand (neuer Knoten P<page>_… bzw. selektiertes Name-Property).
  const selName = await page.evaluate(() => { const pr = [...document.querySelectorAll('.a-Property')].find((e) => (e.querySelector('.a-Property-label')?.innerText || '').trim() === 'Name'); const inp = pr?.querySelector('input,textarea'); return inp ? inp.value : null; });
  if (!selName || !/^P\d+_/.test(selName)) return { ok: false, error: 'Item-Drag verfehlte die Host-Region (kein Page-Item angelegt).' };

  // 3) Item benennen + Custom-Attribute setzen.
  const rName = await pdSetProp(page, 'Name', o.itemName);
  await page.getByText(new RegExp(`^${rxEsc(o.itemName)}$`)).first().click().catch(() => {}); await page.waitForTimeout(800);
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // 4) Öffentlich + Save.
  const { auth, saveError } = await pdPublishAndSave(page, o);
  return { ok: rName === 'ok' && !saveError, mode: opened.mode, item: { name: rName, was: selName }, attributes: attrs, auth, saveError };
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
  const rSql = o.sourceSql ? await pdSetProp(page, 'SQL Query', o.sourceSql) : 'skip';
  const attrs = [];
  for (const a of (o.attributes || [])) { if (a && a.prompt && a.value != null && a.value !== '') attrs.push({ prompt: a.prompt, r: await pdSetProp(page, a.prompt, a.value) }); }

  // Seite öffentlich machen (Page-Root selektieren → „Authentication" = Page Is Public).
  await page.locator('.a-TreeView-label').filter({ hasText: rxi(`Page ${o.pageId}`) }).first().click().catch(() => {}); await page.waitForTimeout(700);
  const auth = await pdSetProp(page, 'Authentication', 'Page Is Public');

  // Speichern über den Save-Button (Strg+S feuert headless nicht zuverlässig).
  await page.waitForTimeout(400);
  await page.locator('#pdSave, button:has-text("Save")').first().click().catch(() => {});
  await settle(2500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const saveError = (body.match(/ORA-\d+[^.]{0,100}|could not be saved|processing failed/i) || [])[0] || null;
  return { ok: rName === 'ok' && (rSql === 'ok' || rSql === 'skip') && !saveError, mode, region: { name: rName, sql: rSql }, attributes: attrs, auth, saveError };
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
