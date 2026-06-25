/**
 * Gemeinsame Asset-Helfer für die Fix-/Review-Flows (vorher dupliziert in autofix.js & autoreview.js).
 *
 *  - inspectAssets(dir): erkennt Artefakte, extrahiert den kanonischen Bundle und liefert je JS-/Inline-
 *    Asset { name, code, origin, status } samt sourceMap-Herkunft (für die Re-Injektion).
 *  - parseOk(code): prüft, ob ein (korrigierter) Code-Stand weiterhin gültig parst.
 *
 * Resultat: src/extract/assets.js
 */

import * as acorn from 'acorn';
import { detectArtifacts } from '../inventory/inventory.js';
import { extractArtifact } from './extract.js';

export const parseOk = (code) => {
  try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); return true; } catch { return false; }
};

export function inspectAssets(dir) {
  const assets = [];
  for (const art of detectArtifacts(dir)) {
    const bundle = extractArtifact(art, { rootDir: dir });
    for (const a of [...bundle.js, ...bundle.inlineCode]) {
      assets.push({ name: a.name, code: a.code, origin: bundle.sourceMap[a.name], status: bundle.status });
    }
  }
  return assets;
}
