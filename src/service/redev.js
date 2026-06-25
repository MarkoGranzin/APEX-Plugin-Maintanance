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
import { inspectAssets, parseOk } from '../extract/assets.js';
import { reinjectAsset } from '../extract/reinject.js';
import { runUiTestsDetailed } from '../test/run-ui.js';
import { compareToBaseline } from './baseline.js';

/** Default-Migration: KI schreibt jedes beschreibbare Asset auf die neueste stabile Lib um (Backups fuer Rollback). */
async function defaultMigrate(store, comp, deps = {}) {
  const ai = deps.ai;
  const dir = comp.path;
  const libs = (store.get(comp.id)?.libs ?? comp.libs ?? []);
  const target = libs.map((l) => `${l.name} → ${l.latest || 'neueste stabile Version'}`).join(', ') || 'die neueste stabile Version der verwendeten Bibliothek(en)';
  const backups = new Map();
  let changed = 0;
  for (const asset of inspectAssets(dir)) {
    if (!asset.origin) continue;
    let out = '';
    try {
      out = await ai.complete(`You are an expert web developer migrating an Oracle APEX plugin to ${target} while preserving its exact behavior. Rewrite the file minimally for the new library version. Return EXCLUSIVELY the full updated file content (no Markdown, no explanation).\nFile ${asset.name}:\n${asset.code}`, {});
    } catch { continue; }
    out = String(out).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!out || !parseOk(out) || out === asset.code.trim()) continue;
    const tgt = asset.origin.type === 'file' ? `${dir}/${asset.origin.path}` : `${dir}/${asset.origin.sqlFile}`;
    if (!backups.has(tgt) && fs.existsSync(tgt)) backups.set(tgt, fs.readFileSync(tgt, 'utf8'));
    reinjectAsset(asset.origin, out, { rootDir: dir });
    changed++;
  }
  return {
    changed: changed > 0,
    summary: changed ? `AI migrated ${changed} asset(s) to ${target}` : 'AI produced no usable migration',
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
  if (!baseline || !baseline.scenarios?.length) {
    return { error: 'Keine Baseline — erst „Capture baseline" auf dem funktionierenden Build ausführen.' };
  }
  const migrate = deps.migrate ?? defaultMigrate;
  const ai = deps.ai;
  if (migrate === defaultMigrate && (!ai || ai.kind === 'stub')) {
    return { error: 'Kein KI-Backend konfiguriert — für die Migration nötig (Einstellungen → KI).' };
  }

  // 1) Migrieren (schreibt Dateien, hält Backups)
  let mig;
  try { mig = await migrate(store, comp, deps); }
  catch (e) { return { error: 'Migration fehlgeschlagen: ' + (e?.message ?? e) }; }
  if (!mig?.changed) return { adopted: false, reason: mig?.summary || 'keine Änderung durch die Migration', migration: mig?.summary };

  // 2) UI-Tests erneut gegen den migrierten Build
  const runDetailed = deps.runDetailed ?? runUiTestsDetailed;
  const cur = store.get(comp.id) ?? comp;
  const r = await runDetailed(cur, { pluginUrl: deps.pluginUrl || cur.uiTestUrl, specsDir: deps.specsDir, hasPlaywright: deps.hasPlaywright, exec: deps.exec, timeoutMs: deps.timeoutMs });
  if (!r.ran) { if (mig.rollback) await mig.rollback(); return { adopted: false, reason: r.reason, migration: mig.summary }; }

  // 3) works-as-before-Gate gegen die Baseline
  const gate = compareToBaseline(cur, r.scenarios ?? []);

  if (gate.pass) {
    let upload = null;
    if (deps.upload) { try { upload = await deps.upload(store.get(comp.id) ?? comp); } catch (e) { upload = { error: String(e?.message ?? e) }; } }
    // T-94: Komponente als neu gebaut/migriert kennzeichnen (GUI-Badge + E-Mail-Report)
    const target = (store.get(comp.id)?.libs ?? comp.libs ?? []).filter((l) => l.latest).map((l) => `${l.name}@${l.latest}`).join(', ') || 'latest';
    store.update(comp.id, { rebuilt: true, rebuiltAt: now(), rebuiltTo: target, rebuiltSummary: mig.summary, verifiedAsBefore: true, reviewUrl: upload?.prUrl ?? (store.get(comp.id)?.reviewUrl ?? null), reviewBranch: upload?.branch ?? (store.get(comp.id)?.reviewBranch ?? null) });
    store.addReview?.(comp.id, { kind: 'redev', pass: true, migration: mig.summary });
    return { adopted: true, at: now(), migration: mig.summary, rebuiltTo: target, gate, upload };
  }
  // Regress → Rollback (nichts wird ohne „grün wie zuvor" übernommen)
  if (mig.rollback) await mig.rollback();
  store.addReview?.(comp.id, { kind: 'redev', pass: false, regressions: gate.regressions?.length ?? 0 });
  return { adopted: false, at: now(), migration: mig.summary, gate, regressions: gate.regressions };
}
