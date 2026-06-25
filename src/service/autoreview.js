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
import * as acorn from 'acorn';
import { detectArtifacts } from '../inventory/inventory.js';
import { extractArtifact } from '../extract/extract.js';
import { reinjectAsset } from '../extract/reinject.js';
import { reviewGate as defaultReviewGate } from '../run/review.js';

const parseOk = (code) => { try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); return true; } catch { return false; } };

function inspect(dir) {
  const assets = [];
  for (const art of detectArtifacts(dir)) {
    const bundle = extractArtifact(art, { rootDir: dir });
    for (const a of [...bundle.js, ...bundle.inlineCode]) assets.push({ name: a.name, code: a.code, origin: bundle.sourceMap[a.name], status: bundle.status });
  }
  return assets;
}

export async function autoReviewFix(store, comp, deps = {}) {
  const dir = comp.path;
  if (!dir || !fs.existsSync(dir)) return { error: 'Kein Repo zugeordnet — bitte zuerst „Repo zuordnen".' };
  const ai = deps.ai;
  if (!ai || ai.kind === 'stub') return { error: 'Kein KI-Backend konfiguriert — bitte in den Einstellungen ein echtes Backend (CLI/Provider) hinterlegen.' };
  const gateFn = deps.reviewGate ?? defaultReviewGate;
  const now = deps.now ?? (() => new Date().toISOString());
  const limit = deps.limit ?? 5;

  const backups = new Map();
  const protocol = [];
  const review = () => { const assets = inspect(dir); return { assets, gate: gateFn({ assets: assets.map((a) => ({ name: a.name, code: a.code })) }) }; };

  let { assets, gate } = review();
  let attempts = 0;
  while (!gate.pass && attempts < limit) {
    attempts++;
    const blocking = [...(gate.security?.blocking ?? []), ...(gate.quality?.blocking ?? [])];
    if (!blocking.length) break;
    const f = blocking[0];
    const asset = assets.find((a) => a.name === f.asset) ?? assets[0];
    if (!asset?.origin) { protocol.push({ agent: 'Web-Dev', file: f.asset || comp.name, result: 'nicht schreibbar (keine sourceMap-Herkunft)' }); break; }

    let fixed = '';
    try {
      fixed = await ai.complete(`Du bist ein sehr guter, sicherheitsbewusster Web-Entwickler. Behebe NUR dieses Finding minimal und idiomatisch. Gib AUSSCHLIESSLICH den vollständigen, korrigierten Inhalt der Datei zurück (kein Markdown, keine Erklärung).\nFinding: ${f.rule} — ${f.message}\nDatei ${asset.name}:\n${asset.code}`, {});
    } catch (e) { protocol.push({ agent: 'Web-Dev', file: asset.name, result: 'KI-Fehler: ' + (e?.message ?? e) }); break; }

    fixed = String(fixed).replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (!fixed || !parseOk(fixed) || fixed === asset.code.trim()) { protocol.push({ agent: 'Web-Dev', file: asset.name, result: 'kein verwertbarer Fix (ungültig/leer)' }); break; }

    const target = asset.origin.type === 'file' ? path.join(dir, asset.origin.path) : path.join(dir, asset.origin.sqlFile);
    if (!backups.has(target) && fs.existsSync(target)) backups.set(target, fs.readFileSync(target, 'utf8'));
    reinjectAsset(asset.origin, fixed, { rootDir: dir });
    protocol.push({ agent: 'Web-Dev', file: asset.name, result: `Fix für ${f.rule} angewandt` });

    ({ assets, gate } = review());
  }

  // Protokoll zusammenstellen
  const entries = [];
  for (const f of gate.security?.findings ?? []) entries.push({ agent: 'Security', file: f.asset || comp.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
  for (const f of gate.quality?.findings ?? []) entries.push({ agent: 'Code-Review', file: f.asset || comp.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
  entries.push(...protocol);
  if (!gate.pass) {
    for (const [target, content] of backups) fs.writeFileSync(target, content); // Rollback
    entries.push({ agent: 'Auto-Review', file: comp.name, result: `nicht grün nach ${attempts} Versuch(en) — Änderungen zurückgerollt`, severity: 'error' });
  } else {
    entries.push({ agent: 'Auto-Review', file: comp.name, result: `grün nach ${attempts} Fix-Versuch(en)` });
  }

  const keepers = (store.get(comp.id).lastLog?.entries ?? []).filter((e) => !['Security', 'Code-Review', 'Web-Dev', 'Auto-Review'].includes(e.agent));
  store.update(comp.id, { lastLog: { at: now(), entries: [...keepers, ...entries] }, status: gate.pass ? 'ok' : (comp.status ?? 'handlungsbedarf') });
  store.addReview(comp.id, { kind: 'auto-review', pass: gate.pass, attempts });
  return { pass: gate.pass, attempts, protocol };
}
