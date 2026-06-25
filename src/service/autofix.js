/**
 * T-61 — „Alles automatisch beheben": Review-Befunde lösen Korrekturen aus.
 *
 * Drei Stufen, alles landet im Protokoll (lastLog):
 *  1) Deterministische Quick-Fixes OHNE KI (console.log/console.debug & debugger entfernen) — per
 *     sourceMap re-injiziert, nur wenn das Ergebnis weiterhin gültig parst.
 *  2) Veraltete/verwundbare Bibliotheken über das Update-Flow (T-40) aktualisieren.
 *  3) Restliche Security/Quality-Findings über autoReviewFix (T-51) — nur mit echtem KI-Backend;
 *     ohne Backend wird der Rest als „benötigt KI-Backend" gemeldet (Stufen 1+2 laufen trotzdem).
 *
 * Reviewer/Updater/KI sind injizierbar → deterministisch testbar (ohne Netz/Git/KI).
 *
 * Resultat: src/service/autofix.js
 */

import fs from 'node:fs';
import { reinjectAsset } from '../extract/reinject.js';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { autoReviewFix as defaultAutoReviewFix } from './autoreview.js';
import { autoUpdateComponent as defaultAutoUpdate } from './update-component.js';

/** Deterministische, sichere Quick-Fixes: console.log/debug & debugger entfernen. */
export function quickFix(code) {
  let out = code;
  out = out.replace(/^[ \t]*console\.(log|debug)\s*\([^\n]*\)\s*;?[ \t]*\r?\n/gm, ''); // ganze Zeilen
  out = out.replace(/console\.(log|debug)\s*\([^;]*\)\s*;?/g, ''); // inline
  out = out.replace(/^[ \t]*debugger\s*;?[ \t]*\r?\n/gm, '');
  out = out.replace(/\bdebugger\b\s*;?/g, '');
  return out;
}

export async function autoFixComponent(store, comp, deps = {}) {
  const dir = comp.path;
  if (!dir || !fs.existsSync(dir)) return { error: 'No repo assigned — please assign a repo first.' };
  const now = deps.now ?? (() => new Date().toISOString());
  const protocol = [];

  // 1) deterministische Quick-Fixes (ohne KI)
  let quickFixes = 0;
  for (const asset of inspectAssets(dir)) {
    if (!asset.origin) continue;
    const fixed = quickFix(asset.code);
    if (fixed !== asset.code && parseOk(fixed)) {
      reinjectAsset(asset.origin, fixed, { rootDir: dir });
      quickFixes++;
      protocol.push({ agent: 'Quick-Fix', file: asset.name, result: 'removed console.log/debugger' });
    }
  }
  if (quickFixes === 0) protocol.push({ agent: 'Quick-Fix', file: comp.name, result: 'no deterministically fixable findings' });

  // 2) veraltete/verwundbare Bibliotheken aktualisieren
  const libs = store.get(comp.id)?.libs ?? comp.libs ?? [];
  const stale = libs.filter((l) => l.outdated || l.vulnerable || l.status === 'verwundbar' || l.webStatus === 'veraltet');
  let libUpdate = null;
  if (stale.length) {
    const update = deps.update ?? defaultAutoUpdate;
    try {
      libUpdate = await update(store, store.get(comp.id) ?? comp, deps.updateDeps ?? {});
      protocol.push({ agent: 'Lib-Update', file: comp.name, result: `Update triggered for ${stale.map((l) => `${l.name}@${l.version}`).join(', ')} — ${libUpdate?.summary ?? 'done'}` });
    } catch (e) {
      protocol.push({ agent: 'Lib-Update', file: comp.name, result: 'Update error: ' + (e?.message ?? e), severity: 'error' });
    }
  } else {
    protocol.push({ agent: 'Lib-Update', file: comp.name, result: 'no outdated/vulnerable libraries' });
  }

  // 3) restliche Findings über KI (nur mit echtem Backend)
  const ai = deps.ai;
  let aiResult = null;
  if (ai && ai.kind !== 'stub') {
    const autoReview = deps.autoReviewFix ?? defaultAutoReviewFix;
    aiResult = await autoReview(store, store.get(comp.id) ?? comp, { ai });
    protocol.push({ agent: 'Auto-Fix', file: comp.name, result: aiResult?.pass ? `AI fixes green after ${aiResult.attempts} attempt(s)` : `AI review not green (${aiResult?.attempts ?? 0} attempt(s))`, severity: aiResult?.pass ? undefined : 'medium' });
  } else {
    protocol.push({ agent: 'Auto-Fix', file: comp.name, result: 'remaining security/quality findings need an AI backend (Settings → AI)', severity: 'medium' });
  }

  // Protokoll persistieren (eigene Agenten ersetzen, übrige Einträge behalten)
  const keep = (store.get(comp.id)?.lastLog?.entries ?? []).filter((e) => !['Quick-Fix', 'Lib-Update', 'Auto-Fix'].includes(e.agent));
  store.update(comp.id, { lastLog: { at: now(), entries: [...keep, ...protocol] } });

  return { ok: true, quickFixes, libUpdate, aiResult, protocol };
}
