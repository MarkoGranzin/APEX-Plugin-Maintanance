/**
 * T-119 (Teil 2) — dualReviewFix: Doppel-Review + Rework als reviewFix-Hook für redevelopComponent.
 *
 * Nutzt dualReviewRework (T-115): nach dem Fix/der Migration werten ZWEI unabhängige Dimensionen den Stand
 * (Security-Gate UND Code-Qualitäts-Gate) plus optional ein Security-Scan. Bei „nicht OK" wird iterativ
 * per KI gefixt (re-injiziert) und erneut bewertet — bis beide grün oder Limit (dann Rollback). Gleiche
 * Rückgabe-Form wie autoReviewFix ({pass, attempts}), damit redev es 1:1 als reviewFix verwenden kann.
 *
 * evalGate/applyFix sind injizierbar → deterministisch testbar ohne echte Dateien/KI.
 *
 * Resultat: src/service/dual-review-fix.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { reinjectAsset } from '../extract/reinject.js';
import { inspectAssets, parseOk } from '../extract/assets.js';
import { reviewGate as defaultReviewGate } from '../run/review.js';
import { dualReviewRework } from './review-loop.js';

export async function dualReviewFix(store, comp, deps = {}) {
  const dir = comp.path;
  const ai = deps.ai;
  const gateFn = deps.reviewGate ?? defaultReviewGate;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!deps.evalGate && (!dir || !fs.existsSync(dir))) return { error: 'No repo assigned — please assign a repo first.', pass: false };
  if (!deps.applyFix && (!ai || ai.kind === 'stub')) return { error: 'No AI backend configured.', pass: false };

  const backups = new Map();
  // Aktuellen Stand bewerten: zwei UNABHÄNGIGE Dimensionen (Security, Code) aus dem Review-Gate.
  const evalGate = deps.evalGate ?? (() => { const assets = inspectAssets(dir); return { assets, gate: gateFn({ assets: assets.map((a) => ({ name: a.name, code: a.code })) }) }; });
  let cur = evalGate();

  // Einen blockierenden Befund per KI fixen + re-injizieren; dann neu bewerten (für die nächste Runde).
  const applyFix = deps.applyFix ?? (async () => {
    const blocking = [...(cur.gate.security?.blocking ?? []), ...(cur.gate.quality?.blocking ?? [])];
    const f = blocking[0]; if (!f) return false;
    const asset = cur.assets.find((a) => a.name === f.asset) ?? cur.assets[0];
    if (!asset?.origin) return false;
    let fixed = '';
    try { fixed = await ai.complete(`You are a security-conscious senior web developer. Fix ONLY this finding, minimally and idiomatically, preserving behaviour. Return EXCLUSIVELY the full corrected file content (no Markdown).\nFinding: ${f.rule} — ${f.message}\nFile ${asset.name}:\n${asset.code}`, {}); }
    catch { return false; }
    fixed = String(fixed).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!fixed || !parseOk(fixed) || fixed === asset.code.trim()) return false;
    const tgt = asset.origin.type === 'file' ? path.join(dir, asset.origin.path) : path.join(dir, asset.origin.sqlFile);
    if (!backups.has(tgt) && fs.existsSync(tgt)) backups.set(tgt, fs.readFileSync(tgt, 'utf8'));
    reinjectAsset(asset.origin, fixed, { rootDir: dir });
    return true;
  });

  const res = await dualReviewRework(comp, {
    maxRounds: deps.limit ?? 3,
    securityScan: deps.securityScan ? async () => deps.securityScan(dir) : undefined,
    securityReview: async () => { const b = cur.gate.security?.blocking ?? []; return { ok: cur.gate.security?.pass !== false && b.length === 0, issues: b.map((f) => `${f.rule}: ${f.message}`) }; },
    codeReview: async () => { const b = cur.gate.quality?.blocking ?? []; return { ok: cur.gate.quality?.pass !== false && b.length === 0, issues: b.map((f) => `${f.rule}: ${f.message}`) }; },
    fix: async () => { const ok = await applyFix(); cur = evalGate(); return ok; },
    log: deps.log,
  });

  if (!res.pass) { for (const [t, content] of backups) { try { fs.writeFileSync(t, content); } catch { /* ignore */ } } } // Rollback
  try { store?.addReview?.(comp.id, { kind: 'dual-review', pass: res.pass, attempts: res.rounds, at: now() }); } catch { /* ignore */ }
  return { pass: res.pass, attempts: res.rounds, votes: res.votes, rolledBack: !res.pass && backups.size > 0 };
}
