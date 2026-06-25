/**
 * F-20 (T-40) — Auto-Update je Komponente: Plan → Patch → Review-Gate → PR-Dedup → Record.
 *
 * Ermittelt verwundbare referenzierte Libs (retire-DB, Zielversion = Fix), bumpt die URL-Version
 * im Quelltext (echter Datei-Patch), prüft das Ergebnis mit dem Review-Gate (T-31) und liefert
 * nur bei grünem Gate einen idempotenten PR-Push (T-26). Bei Block: Datei zurückrollen, kein Push.
 * Ergebnis wird je Komponente als Review-Notiz + lastChange + History festgehalten.
 *
 * Resultat: src/service/update-component.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { referencedUrlsFrom } from '../extract/extract.js';
import { DEFAULT_VULN_DB } from '../test/static.js';
import { reviewGate as defaultReviewGate } from '../run/review.js';
import { branchKey, createPrRegistry, idempotentPush } from '../run/dedup.js';
import { detectArtifacts } from '../inventory/inventory.js';

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const libName = (url) =>
  (url.split('/').pop() || '').replace(/[-.@]?\d.*$/, '').replace(/\.(min\.)?(js|css)$/i, '');

/**
 * Plant URL-Versions-Updates für verwundbare referenzierte Libs in einem Checkout.
 * @param {string} componentPath
 * @param {{vulnDb?:object}} [opts]
 * @returns {{file:string, lib:string, from:string, to:string, oldUrl:string, newUrl:string, vuln:string}[]}
 */
export function planLibUpdates(componentPath, opts = {}) {
  const db = opts.vulnDb ?? DEFAULT_VULN_DB;
  const arts = detectArtifacts(componentPath);
  const seen = new Set();
  const plans = [];
  for (const a of arts) {
    for (const f of a.files ?? []) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(componentPath, f), 'utf8');
      } catch {
        continue;
      }
      for (const ref of referencedUrlsFrom(text)) {
        const name = libName(ref.url);
        const version = ref.version;
        if (!name || !version || !db[name]) continue;
        for (const v of db[name]) {
          if (cmp(version, v.below) < 0) {
            const key = `${f}|${ref.url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            plans.push({ file: f, lib: name, from: version, to: v.below, oldUrl: ref.url, newUrl: ref.url.split(version).join(v.below), vuln: v.id });
          }
        }
      }
    }
  }
  return plans;
}

/**
 * Führt den Auto-Update-Flow für eine Komponente aus.
 * @param {object} store
 * @param {object} component  {id, name, path}
 * @param {object} [deps] vulnDb/reviewGate/push/registry/recordRun/gateDeps
 */
export async function autoUpdateComponent(store, component, deps = {}) {
  const dir = component.path;
  const plans = planLibUpdates(dir, { vulnDb: deps.vulnDb });
  const registry = deps.registry ?? createPrRegistry();
  const gate = deps.reviewGate ?? defaultReviewGate;
  const push = deps.push ?? (async ({ branch }) => ({ branch }));

  const results = [];
  for (const plan of plans) {
    const file = path.join(dir, plan.file);
    const before = fs.readFileSync(file, 'utf8');
    const patched = before.split(plan.oldUrl).join(plan.newUrl);
    fs.writeFileSync(file, patched);

    const review = gate({ assets: [{ name: plan.file, code: patched }], cve: [] }, deps.gateDeps ?? {});
    if (!review.pass) {
      fs.writeFileSync(file, before); // zurückrollen, kein Push
      results.push({ ...plan, pushed: false, reviewBlocked: true, stage: review.stage });
      continue;
    }
    const pr = await idempotentPush(registry, { artifact: component.name, lib: plan.lib, targetVersion: plan.to }, push);
    results.push({ ...plan, pushed: pr.pushed, prRef: pr.prRef, branchKey: pr.key, reason: pr.reason });
  }

  const pushed = results.filter((r) => r.pushed);
  const blocked = results.filter((r) => r.reviewBlocked);
  const summary = plans.length === 0
    ? 'keine automatischen Updates'
    : [pushed.length ? `${pushed.length} Update(s) als PR` : null, blocked.length ? `${blocked.length} Review-blockiert` : null].filter(Boolean).join(', ') || 'keine Änderung';

  if (plans.length > 0) {
    store.setLastChange(component.id, summary);
    store.update(component.id, { status: pushed.length ? 'pr-offen' : blocked.length ? 'review-blockiert' : component.status });
    store.addReview(component.id, { kind: 'auto-update', pushed: pushed.length, blocked: blocked.length, results });
  }
  if (deps.recordRun) {
    deps.recordRun({
      id: deps.runId ?? `update-${component.name}`,
      status: blocked.length ? 'partial' : 'green',
      updated: pushed.map((r) => ({ artifact: component.name, change: `${r.lib} ${r.from}→${r.to}`, prRef: r.prRef })),
      failures: blocked.map((r) => ({ artifact: component.name, reason: `review-blockiert (${r.stage}): ${r.lib}` })),
    });
  }

  return { component: component.name, plans: plans.length, results, summary, branchRegistry: registry };
}

export { branchKey };
