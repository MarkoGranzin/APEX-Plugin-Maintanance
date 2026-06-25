/**
 * Autonomes Review-&-Fix (analog devhub-Review, aber selbst behebend).
 *
 * Extrahiert die Assets der Komponente, lässt das Review-Gate (Security+Code, T-31) laufen und
 * behebt blockierende Findings iterativ mit dem konfigurierten KI-Backend: KI liefert den
 * korrigierten Datei-Inhalt → acorn-validiert → über die sourceMap re-injiziert (T-25) → erneut
 * reviewen, bis grün oder Limit. Bei Misserfolg: Rollback. Alles landet im Protokoll (lastLog).
 * Benötigt ein echtes Backend (CLI/Provider) — mit Stub gibt es keinen sinnvollen Fix.
 *
 * Resultat: src/service/autoreview.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { reinjectAsset } from '../extract/reinject.js';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { reviewGate as defaultReviewGate } from '../run/review.js';

export async function autoReviewFix(store, comp, deps = {}) {
  const dir = comp.path;
  if (!dir || !fs.existsSync(dir)) return { error: 'No repo assigned — please assign a repo first.' };
  const ai = deps.ai;
  if (!ai || ai.kind === 'stub') return { error: 'No AI backend configured — please set a real backend (CLI/provider) in the settings.' };
  const gateFn = deps.reviewGate ?? defaultReviewGate;
  const now = deps.now ?? (() => new Date().toISOString());
  const limit = deps.limit ?? 5;

  const backups = new Map();
  const protocol = [];
  const review = () => { const assets = inspectAssets(dir); return { assets, gate: gateFn({ assets: assets.map((a) => ({ name: a.name, code: a.code })) }) }; };

  let { assets, gate } = review();
  let attempts = 0;
  while (!gate.pass && attempts < limit) {
    attempts++;
    const blocking = [...(gate.security?.blocking ?? []), ...(gate.quality?.blocking ?? [])];
    if (!blocking.length) break;
    const f = blocking[0];
    const asset = assets.find((a) => a.name === f.asset) ?? assets[0];
    if (!asset?.origin) { protocol.push({ agent: 'Web-Dev', file: f.asset || comp.name, result: 'not writable (no sourceMap origin)' }); break; }

    let fixed = '';
    try {
      fixed = await ai.complete(`You are an excellent, security-conscious web developer. Fix ONLY this finding, minimally and idiomatically. Return EXCLUSIVELY the full, corrected file content (no Markdown, no explanation).\nFinding: ${f.rule} — ${f.message}\nFile ${asset.name}:\n${asset.code}`, {});
    } catch (e) { protocol.push({ agent: 'Web-Dev', file: asset.name, result: 'AI error: ' + (e?.message ?? e) }); break; }

    fixed = String(fixed).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!fixed || !parseOk(fixed) || fixed === asset.code.trim()) { protocol.push({ agent: 'Web-Dev', file: asset.name, result: 'no usable fix (invalid/empty)' }); break; }

    const target = asset.origin.type === 'file' ? path.join(dir, asset.origin.path) : path.join(dir, asset.origin.sqlFile);
    if (!backups.has(target) && fs.existsSync(target)) backups.set(target, fs.readFileSync(target, 'utf8'));
    reinjectAsset(asset.origin, fixed, { rootDir: dir });
    protocol.push({ agent: 'Web-Dev', file: asset.name, result: `Applied fix for ${f.rule}` });

    ({ assets, gate } = review());
  }

  // Protokoll zusammenstellen
  const entries = [];
  for (const f of gate.security?.findings ?? []) entries.push({ agent: 'Security', file: f.asset || comp.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
  for (const f of gate.quality?.findings ?? []) entries.push({ agent: 'Code-Review', file: f.asset || comp.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
  entries.push(...protocol);
  if (!gate.pass) {
    for (const [target, content] of backups) fs.writeFileSync(target, content); // Rollback
    entries.push({ agent: 'Auto-Review', file: comp.name, result: `not green after ${attempts} attempt(s) — changes rolled back`, severity: 'error' });
  } else {
    entries.push({ agent: 'Auto-Review', file: comp.name, result: `green after ${attempts} fix attempt(s)` });
  }

  const keepers = (store.get(comp.id).lastLog?.entries ?? []).filter((e) => !['Security', 'Code-Review', 'Web-Dev', 'Auto-Review'].includes(e.agent));
  store.update(comp.id, { lastLog: { at: now(), entries: [...keepers, ...entries] }, status: gate.pass ? 'ok' : (comp.status ?? 'handlungsbedarf') });
  store.addReview(comp.id, { kind: 'auto-review', pass: gate.pass, attempts });
  return { pass: gate.pass, attempts, protocol };
}
