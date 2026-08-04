/**
 * F-28 (T-93) — Re-Dev/Migration gegen die Charakterisierungs-Spec.
 *
 * Orchestriert: (1) KI migriert/baut das Plugin auf die neueste stabile Lib um (schreibt Dateien,
 * mit Backups), (2) die generierten Coded-UI-Tests laufen erneut, (3) das works-as-before-Gate
 * vergleicht gegen die Baseline. Uebernahme NUR bei kein-Regress; danach optional Upload/PR (gated).
 * Bei Regress: Rollback + Bericht, welche Szenarien brachen. Alle Schritte injizierbar → testbar.
 *
 * Resultat: src/service/redev.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { reinjectAsset } from '../extract/reinject.js';
import { runUiTestsDetailed } from '../test/run-ui.js';
import { compareToBaseline } from './baseline.js';
import { readAcceptance, compareAcceptance } from './acceptance.js';
import { applyVendoredUpdates } from './lib-update.js';
import { analyzeDeep } from '../test/analyze-deep.js';
import { captureShot, aiVisualCheck } from '../test/visual.js';
import { collectMock } from '../test/mock.js';
import { planReplacements } from './lib-replace.js';

// T-103: konkrete Breaking-Change-Hinweise je Bibliothek, damit die KI Aufrufstellen PORTIERT
// (Markup/Klassen/APIs) statt nicht-kompilierenden Code zu löschen — sonst gehen Optik & Features verloren.
const LIB_NOTES = {
  jquery: 'jQuery 3/4: removed event shorthands .load()/.unload()/.error() and .bind/.unbind/.delegate/.live → use .on()/.off(); .size() → .length; jqXHR .success()/.error()/.complete() → .done()/.fail()/.always(); $.isArray/$.isFunction/$.trim/$.parseJSON removed → Array.isArray/typeof/String.trim/JSON.parse; .andSelf() → .addBack(); positional :first/:last/:eq deprecated. Keep every selector, handler and DOM effect identical.',
  bootstrap: 'Bootstrap 3→5: jQuery is no longer required and the jQuery plugin API ($el.modal()/$el.tooltip()/$el.tab()) is REMOVED → use the new JS API (new bootstrap.Modal(el)…) or data-bs-* attributes; data-toggle→data-bs-toggle, data-target→data-bs-target, data-dismiss→data-bs-dismiss; grid col-xs-*→col-*; .hidden→.d-none; .pull-left/right→.float-start/end; .center-block→.mx-auto; .panel→.card (.panel-heading→.card-header, .panel-body→.card-body); .btn-default→.btn-secondary; .img-responsive→.img-fluid; .label→.badge; glyphicons removed. Port ALL class names & data-attributes so the layout LOOKS identical.',
  bootstrap4: 'Bootstrap 4→5: drop jQuery dependency; data-* → data-bs-*; .form-row→.row; .no-gutters→.g-0; .ml-/.mr-→.ms-/.me-; .float-left/right→.float-start/end; .badge-*→.bg-*; .close→.btn-close; .custom-control→form-check. Port markup so appearance is unchanged.',
};
/** Baut die Breaking-Change-Notizen für die tatsächlich betroffenen Libs (rein/testbar). */
export function breakingNotes(libs = []) {
  const out = [];
  for (const l of libs || []) {
    const key = String(l.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const note = LIB_NOTES[key] || LIB_NOTES[key.replace(/[0-9].*$/, '')];
    if (note) out.push(`- ${l.name} (${l.version || '?'} → ${l.latest || 'latest'}): ${note}`);
    else if (l.latest && l.version && l.version !== l.latest) out.push(`- ${l.name} (${l.version} → ${l.latest}): consult this library's migration guide; port removed/renamed APIs and markup instead of deleting them.`);
  }
  return out.join('\n');
}

/** Plugin-weites Feature-Inventar aus der Analyse (Funktionen, Events/Interaktionen, Selektoren, apex.*). */
function featureInventory(dir) {
  const fns = new Set(), events = new Set(), selectors = new Set(), apexCalls = new Set();
  try {
    for (const a of inspectAssets(dir)) {
      const d = analyzeDeep(a.code || '');
      for (const f of d.functions || []) { if (f.name) fns.add(`${f.name}(${(f.params || []).join(', ')})`); for (const c of f.apexCalls || []) apexCalls.add(c); }
      for (const ev of d.events || []) { if (ev.selector) events.add(`${ev.type}→${ev.selector}`); }
      for (const s of d.selectors || []) selectors.add(s);
    }
  } catch { /* best effort */ }
  return { fns: [...fns], events: [...events], selectors: [...selectors], apexCalls: [...apexCalls] };
}

/** Reicher, feature-/breaking-bewusster Migrations-Prompt je Datei (rein/testbar, T-103). */
export function buildMigrationPrompt(asset, ctx = {}) {
  const { target = 'the latest stable libraries', breaking = '', inventory = {}, replacements = [] } = ctx;
  const inv = [];
  if (inventory.events?.length) inv.push('Interactions/events to PRESERVE (re-bind so they still work — includes drag & drop / sortable): ' + inventory.events.slice(0, 40).join(', '));
  if (inventory.fns?.length) inv.push('Functions/behaviors to keep working: ' + inventory.fns.slice(0, 40).join(', '));
  if (inventory.apexCalls?.length) inv.push('apex.* integration to keep: ' + [...new Set(inventory.apexCalls)].slice(0, 30).join(', '));
  // T-164-Regel für unmaintained Libs — zwei klar getrennte Pfade:
  //   a) Es gibt einen PFLICHTENFREIEN (obligations 'none'), funktional GLEICHWERTIGEN Nachfolger
  //      → NUR ein ADAPTER wird geschrieben: er stellt exakt die vom Plugin genutzte alte API-Oberfläche
  //      bereit (gleiche Globals/Funktionen/Signaturen), implementiert auf dem Nachfolger. Der
  //      Plugin-Code selbst bleibt UNVERÄNDERT.
  //   b) Sonst (kein Nachfolger / Nachfolger mit Pflichten wie Attribution) → kompletter Neubau der
  //      genutzten Fähigkeit auf Basis der charakterisierten INTERFACES, eigener Code unter MIT.
  const repl = [];
  for (const r of replacements || []) {
    if (r.strategy === 'replace' && r.to) {
      repl.push(`- "${r.from}" is UNMAINTAINED, and "${r.to}" (${r.license}, no obligations) does the same job. Write an ADAPTER (shim) that exposes EXACTLY the API surface this plugin uses from "${r.from}" — same global names, functions, signatures and return shapes — implemented on top of "${r.to}"${r.cdn ? ` (e.g. ${r.cdn})` : ''}. ${r.note || ''} Do NOT rewrite the plugin's own code: it keeps calling the old names unchanged; only the library loading is swapped for the adapter.`);
    } else {
      repl.push(`- "${r.from}" is UNMAINTAINED and there is no obligation-free, equivalent successor${r.rejected ? ` (${r.rejected.to} exists, but its license ${r.rejected.license} carries obligations)` : ''} — RE-DEVELOP the capability this plugin uses it for: from the characterized INTERFACES/behavior above, RE-IMPLEMENT it from scratch so the plugin behaves and LOOKS exactly as before. YOU decide the approach and derive the entire implementation yourself — do not expect a 1:1 API mapping. Your own code under MIT; tiny obligation-free helpers (MIT/ISC/0BSD) are acceptable — NEVER attribution-bound or copyleft code.`);
    }
  }
  return `You are an expert front-end engineer migrating an Oracle APEX plugin to ${target}. Migrate THIS file so the plugin keeps working on the new library versions WITHOUT changing what the user sees or can do.

NON-NEGOTIABLE — preserve 1:1:
- The exact VISUAL appearance and layout: keep the same DOM structure; when a framework renamed classes/attributes, PORT them to the new version's equivalents so the result LOOKS identical. Do NOT delete markup/classes that "no longer apply" — translate them.
- ALL interactive features: drag & drop / sortable, click/hover/keyboard handlers, animations, dialogs/modals, AJAX/data loading. Re-bind every handler with the new API; NEVER drop a feature because its old API was removed — replace it with the new equivalent.
- The public behavior and apex.* integration.

Library breaking changes to apply (port call sites; do not remove functionality):
${breaking || "(consult each library's migration guide)"}
${repl.length ? '\nUNMAINTAINED libraries — rule: obligation-free equivalent successor → write ONLY an adapter (plugin code untouched); otherwise rewrite from the interfaces (keep behavior 1:1; NEVER GPL/AGPL/LGPL/other copyleft):\n' + repl.join('\n') + '\n' : ''}
${inv.join('\n')}

If something cannot be preserved perfectly, keep the closest WORKING equivalent rather than removing it. Return EXCLUSIVELY the full updated file content (no Markdown, no explanation).

File ${asset.name}:
${asset.code}`;
}

/**
 * Default-Migration (B-17): ZUERST die vendored Lib-Dateien wirklich auf die neueste stabile Version
 * tauschen (breaking → force) UND in den Mock spiegeln, DANN die KI die aufrufenden Plugin-Assets an
 * die neue Lib-API anpassen. Ohne den realen Tausch „migriert" die KI nur den Code, die Bibliothek
 * selbst bliebe alt (jquery 1.12.4 etc.). Backups (Lib + Mock + Code) erlauben vollständigen Rollback.
 */
async function defaultMigrate(store, comp, deps = {}) {
  const ai = deps.ai;
  const dir = comp.path;
  const libs = (store.get(comp.id)?.libs ?? comp.libs ?? []);
  const target = libs.map((l) => `${l.name} → ${l.latest || 'neueste stabile Version'}`).join(', ') || 'die neueste stabile Version der verwendeten Bibliothek(en)';
  const backups = new Map();

  // 1) Vendored Libs real tauschen (breaking → force) + in den Mock spiegeln, damit das
  //    works-as-before-Gate gegen die NEUE Lib verifiziert (nicht gegen die alte Mock-Kopie).
  const applyFn = deps.applyVendoredUpdates ?? applyVendoredUpdates;
  let vend = { results: [], backups: new Map() };
  try { vend = await applyFn(dir, libs, { force: true, fetchFile: deps.fetchFile }); }
  catch { /* offline → KI-Code-Migration läuft trotzdem, Lib bliebe dann alt */ }
  for (const [abs, content] of vend.backups) if (!backups.has(abs)) backups.set(abs, content);
  const swapped = vend.results.filter((r) => r.applied && r.file);
  const mockDir = path.join(dir, '.maintenance', 'mock');
  for (const r of swapped) {
    const mockTgt = path.join(mockDir, r.file);
    try {
      if (fs.existsSync(mockTgt)) {
        if (!backups.has(mockTgt)) backups.set(mockTgt, fs.readFileSync(mockTgt, 'utf8'));
        fs.copyFileSync(path.join(dir, r.file), mockTgt);
      }
    } catch { /* Mock-Spiegelung best effort */ }
  }

  // 2) KI passt die aufrufenden Plugin-Assets an die neue Lib-API an — mit Feature-Inventar +
  //    lib-spezifischen Breaking-Changes, damit Optik & Interaktionen (Drag&Drop usw.) erhalten bleiben (T-103).
  const breaking = breakingNotes(libs);
  const inventory = featureInventory(dir);
  const replacements = planReplacements(libs); // unmaintained → permissiver Nachfolger / MIT-Self-Build
  let aiChanged = 0;
  for (const asset of inspectAssets(dir)) {
    if (!asset.origin) continue;
    let out = '';
    try {
      out = await ai.complete(buildMigrationPrompt(asset, { target, breaking, inventory, replacements }), {});
    } catch { continue; }
    out = String(out).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!out || !parseOk(out) || out === asset.code.trim()) continue;
    const tgt = asset.origin.type === 'file' ? `${dir}/${asset.origin.path}` : `${dir}/${asset.origin.sqlFile}`;
    if (!backups.has(tgt) && fs.existsSync(tgt)) backups.set(tgt, fs.readFileSync(tgt, 'utf8'));
    reinjectAsset(asset.origin, out, { rootDir: dir });
    aiChanged++;
  }

  // Mock-Update: die Plugin-Code-Kopien des Mocks auf den MIGRIERTEN Code aktualisieren (Libs wurden
  // oben bereits gespiegelt). Sonst lädt der Mock alten Plugin-Code → das Gate/Optik-Gate verifiziert
  // nicht den tatsächlich migrierten Stand, und der Mock zeigt am Ende Altes. Mit Backup → Rollback.
  if (aiChanged > 0) {
    try {
      for (const pf of collectMock(dir).pluginFiles) {
        const tgt = path.join(mockDir, pf.name); // pf.name = 'plugin/<file>'
        if (fs.existsSync(tgt)) {
          if (!backups.has(tgt)) backups.set(tgt, fs.readFileSync(tgt, 'utf8'));
          fs.writeFileSync(tgt, pf.code);
        }
      }
    } catch { /* Mock-Spiegelung best effort */ }
  }

  const applied = swapped.map((r) => ({ name: r.name, to: r.to }));
  const changed = swapped.length + aiChanged;
  const swapTxt = swapped.length ? `swapped ${swapped.map((r) => `${r.name}@${r.to}`).join(', ')}` : 'no lib swap';
  return {
    changed: changed > 0,
    applied, // tatsächlich getauschte Libs → rebuiltTo
    summary: changed ? `Migrated: ${swapTxt}; AI-adapted ${aiChanged} asset(s)` : 'AI produced no usable migration',
    backups,
    rollback: () => { for (const [t, content] of backups) { try { fs.writeFileSync(t, content); } catch { /* ignore */ } } },
  };
}

/**
 * @param {object} store
 * @param {object} comp
 * @param {{ai?:object, migrate?:Function, runDetailed?:Function, upload?:Function, pluginUrl?:string, specsDir?:string, hasPlaywright?:boolean, exec?:Function, now?:Function}} deps
 */
export async function redevelopComponent(store, comp, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const baseline = (store.get(comp.id)?.baseline ?? comp.baseline);
  // works-as-before-Maßstab: ENTWEDER eine Playwright-Baseline ODER ein Akzeptanz-Vertrag (Mock-Charakterisierung).
  const contract = deps.acceptanceContract ?? readAcceptance(comp.path);
  const haveContract = !!(contract && (contract.criteria || []).length && typeof deps.runMockSelfTests === 'function');
  const haveBaseline = !!(baseline && baseline.scenarios?.length);
  if (!haveBaseline && !haveContract) {
    return { error: 'Neither baseline nor acceptance contract — run "Capture baseline" first or create a green mock.' };
  }
  const migrate = deps.migrate ?? defaultMigrate;
  const ai = deps.ai;
  if (migrate === defaultMigrate && (!ai || ai.kind === 'stub')) {
    return { error: 'No AI backend configured — required for the migration (Settings → AI).' };
  }

  // 1) Migrieren (schreibt Dateien, hält Backups)
  let mig;
  try { mig = await migrate(store, comp, deps); }
  catch (e) { return { error: 'Migration failed: ' + (e?.message ?? e) }; }
  if (!mig?.changed) return { adopted: false, reason: mig?.summary || 'keine Änderung durch die Migration', migration: mig?.summary };

  // 1b) Review + Rework-Loop: Security/Code-Gate → KI-Fix → Re-Review (bis grün/Limit), VOR dem UI-Gate.
  let review = null;
  if (deps.reviewFix && ai && ai.kind !== 'stub') {
    try { const rv = await deps.reviewFix(store, store.get(comp.id) ?? comp, { ai }); review = { pass: !!rv?.pass, attempts: rv?.attempts ?? 0, error: rv?.error }; }
    catch (e) { review = { pass: false, error: String(e?.message ?? e) }; }
  }

  // 2+3) works-as-before-Gate gegen den MIGRIERTEN Build.
  const cur = store.get(comp.id) ?? comp;
  let gate;
  if (haveContract) {
    // Akzeptanz-Vertrag-Gate (T-122): Mock-Selbsttest gegen den migrierten Code, mit dem eingefrorenen Soll vergleichen.
    const mockUrl = deps.mockUrl || cur.mockUrl;
    const st = await deps.runMockSelfTests(mockUrl, { timeoutMs: deps.timeoutMs });
    if (!st || !st.ran) { if (mig.rollback) await mig.rollback(); return { adopted: false, reason: 'Acceptance gate not runnable: ' + (st?.reason || 'Mock/Playwright missing'), migration: mig.summary }; }
    const acc = compareAcceptance(contract, st);
    gate = { pass: acc.pass, acceptance: acc, regressions: [...acc.broken.map((b) => ({ scenario: `${b.view}: ${b.feature}`, reason: 'rot' })), ...acc.missing.map((m) => ({ scenario: `${m.view}: ${m.feature}`, reason: 'fehlt' })), ...(acc.renderOk ? [] : [{ scenario: 'render', reason: 'no real rendering' }])] };
  } else {
    // UI-Tests gegen die Playwright-Baseline (Bestandsweg)
    const runDetailed = deps.runDetailed ?? runUiTestsDetailed;
    const r = await runDetailed(cur, { pluginUrl: deps.pluginUrl || cur.uiTestUrl, specsDir: deps.specsDir, hasPlaywright: deps.hasPlaywright, exec: deps.exec, timeoutMs: deps.timeoutMs });
    if (!r.ran) { if (mig.rollback) await mig.rollback(); return { adopted: false, reason: r.reason, migration: mig.summary }; }
    gate = compareToBaseline(cur, r.scenarios ?? []);
  }

  // B-25: „adopt/rebuilt" NUR bei einer ECHTEN Änderung (real getauschte Lib). Sonst ist ein grünes Gate
  // bedeutungslos (Plugin unverändert) — dann ehrlich als „nicht automatisch reparierbar" markieren.
  const realChange = !!(mig.applied && mig.applied.length);
  const markNotRepairable = (reason) => { try { store.update(comp.id, { rebuilt: false, rebuiltTo: null, verifiedAsBefore: false, notRepairable: { at: now(), reason } }); } catch { /* ignore */ } };

  if (gate.pass && !realChange) {
    // Gate grün, aber NICHTS real migriert (z.B. Lib-Version „unbekannt", kein sicherer Tausch, kein Nachfolger).
    if (mig.rollback) await mig.rollback();
    markNotRepairable('Automatische Pflege konnte keine betroffene Lib real aktualisieren/ersetzen (kein sicherer Versions-/Tauschpfad) — manuelle Migration nötig.');
    store.addReview?.(comp.id, { kind: 'redev', pass: false, reason: 'no-op — nichts real migriert' });
    return { adopted: false, notRepairable: true, at: now(), migration: mig.summary, gate, review, reason: 'no effective upgrade possible — marked as "not repairable"' };
  }

  if (gate.pass) {
    // 3b) T-104 — optisches Abschluss-Gate: „sieht aus wie zuvor?" KI vergleicht initialen Baseline-Screenshot
    //     mit einem frischen Screenshot des migrierten Builds. Optischer Regress = NICHT übernehmen (Rollback).
    let visual = { ran: false, reason: 'no baseline screenshot' };
    const beforeShot = baseline?.shot;
    const shotUrl = deps.pluginUrl || cur.uiTestUrl;
    if (beforeShot && shotUrl && deps.hasPlaywright !== false && ai && ai.kind !== 'stub') {
      const afterShot = `${deps.specsDir || '.'}/after-shot.png`;
      const cap = await (deps.captureShot ?? captureShot)(shotUrl, afterShot, {});
      if (cap.ok) visual = await (deps.aiVisualCheck ?? aiVisualCheck)({ ai, before: beforeShot, after: afterShot });
      else visual = { ran: false, reason: 'after-screenshot failed: ' + cap.error };
    }
    if (visual.ran && visual.looksSame === false) {
      if (mig.rollback) await mig.rollback();
      markNotRepairable('Optischer Regress nach Migration — sieht nicht „wie zuvor" aus: ' + (visual.issues || []).join('; '));
      store.addReview?.(comp.id, { kind: 'redev', pass: false, visual });
      return { adopted: false, notRepairable: true, at: now(), migration: mig.summary, gate, review, visual, reason: 'visual regression — does not look as before: ' + (visual.issues || []).join('; ') };
    }

    let upload = null;
    if (deps.upload) { try { upload = await deps.upload(store.get(comp.id) ?? comp); } catch (e) { upload = { error: String(e?.message ?? e) }; } }
    // T-94/B-17/B-25: Kennzeichnung NUR aus den TATSÄCHLICH getauschten Libs.
    const target = mig.applied.map((l) => `${l.name}@${l.to}`).join(', ');
    store.update(comp.id, { rebuilt: true, rebuiltAt: now(), rebuiltTo: target, rebuiltSummary: mig.summary, verifiedAsBefore: true, notRepairable: null, reviewUrl: upload?.prUrl ?? (store.get(comp.id)?.reviewUrl ?? null), reviewBranch: upload?.branch ?? (store.get(comp.id)?.reviewBranch ?? null) });
    store.addReview?.(comp.id, { kind: 'redev', pass: true, migration: mig.summary, visual });
    return { adopted: true, at: now(), migration: mig.summary, rebuiltTo: target, gate, review, upload, visual };
  }
  // Regress → Rollback (nichts wird ohne „grün wie zuvor" übernommen) → nicht (automatisch) reparierbar
  if (mig.rollback) await mig.rollback();
  markNotRepairable('Migration verletzte die Akzeptanzkriterien (Regress) — automatisch nicht „wie zuvor" herstellbar, manuelle Migration nötig.');
  store.addReview?.(comp.id, { kind: 'redev', pass: false, regressions: gate.regressions?.length ?? 0 });
  return { adopted: false, notRepairable: true, at: now(), migration: mig.summary, gate, review, regressions: gate.regressions };
}
