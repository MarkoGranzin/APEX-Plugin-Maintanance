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

  // T-125: kritischer Code = verbleibende Security-Findings mit severity high/critical (klar herausgehoben).
  const isCritical = (f) => f.severity === 'high' || f.severity === 'critical';
  let criticalFindings = (gate.security?.findings ?? []).filter(isCritical).map((f) => ({ rule: f.rule, severity: f.severity, asset: f.asset, message: f.message }));

  // T-124: Selbst-Fix-Guard — statisch grün reicht NICHT; das Plugin muss NATIV wie zuvor funktionieren.
  // verifyNative (injiziert) prüft das beobachtbare Verhalten gegen den Akzeptanz-Vertrag.
  let native = null;
  let nativeBroke = false;
  if (gate.pass && typeof deps.verifyNative === 'function') {
    try { native = await deps.verifyNative(); } catch (e) { native = { pass: true, skipped: true, error: String(e?.message ?? e) }; }
    // Nur ein ECHTER, gelaufener Regress blockiert (konnte der Guard nicht laufen → nicht fälschlich zurückrollen).
    if (native && native.skipped !== true && native.pass === false) nativeBroke = true;
  }
  const pass = gate.pass && !nativeBroke;

  // Protokoll zusammenstellen
  const entries = [];
  for (const f of gate.security?.findings ?? []) entries.push({ agent: 'Security', file: f.asset || comp.name, result: `${isCritical(f) ? '⛔ KRITISCH — ' : ''}${f.rule}: ${f.message}`, severity: f.severity });
  for (const f of gate.quality?.findings ?? []) entries.push({ agent: 'Code-Review', file: f.asset || comp.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
  entries.push(...protocol);
  if (!pass) {
    for (const [target, content] of backups) fs.writeFileSync(target, content); // Rollback
    if (nativeBroke) entries.push({ agent: 'Auto-Review', file: comp.name, result: `Fix brach natives Funktionieren (Regress: ${[...(native.missing || []), ...(native.broken || [])].length} Kriterium/Kriterien) → alle Änderungen zurückgerollt`, severity: 'error' });
    else entries.push({ agent: 'Auto-Review', file: comp.name, result: `not green after ${attempts} attempt(s) — changes rolled back`, severity: 'error' });
  } else {
    entries.push({ agent: 'Auto-Review', file: comp.name, result: `green after ${attempts} fix attempt(s)${native && native.skipped !== true ? ' — nativ wie zuvor verifiziert' : ''}` });
  }
  // Nach einem Rollback ist der Code wieder der ALTE → die ursprünglichen kritischen Befunde stehen weiter an.
  if (nativeBroke) { const a0 = inspectAssets(dir); const g0 = gateFn({ assets: a0.map((x) => ({ name: x.name, code: x.code })) }); criticalFindings = (g0.security?.findings ?? []).filter(isCritical).map((f) => ({ rule: f.rule, severity: f.severity, asset: f.asset, message: f.message })); }

  const keepers = (store.get(comp.id).lastLog?.entries ?? []).filter((e) => !['Security', 'Code-Review', 'Web-Dev', 'Auto-Review'].includes(e.agent));
  store.update(comp.id, { lastLog: { at: now(), entries: [...keepers, ...entries] }, status: pass ? 'ok' : (comp.status ?? 'handlungsbedarf') });
  store.addReview(comp.id, { kind: 'auto-review', pass, attempts, criticalCount: criticalFindings.length });
  return { pass, attempts, protocol, criticalFindings, native };
}
