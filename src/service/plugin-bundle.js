/**
 * B-40 — App-seitiger Zugang zur generischen Plugin-Asset-Engine (mcp-apex-deploy/lib/plugin-assets.js).
 *
 * Die Engine (Erkennen der Herkunft eingebetteter Dateien + Re-Embed) lebt im standalone-MCP, damit das
 * Manifest sie tragen kann. Hier nur Re-Export + ein dünnes rebuildEmbeddedBundles für Bestandscode/Tests.
 *
 * Resultat: src/service/plugin-bundle.js
 */

export {
  parseGulpBundles, embeddedFileNames, resolveSources, buildBundle, buildContentBlock,
  decodeEmbeddedFile, reembedFile, findRepoSource, detectEmbeddedAssets, reembedFromAssets,
} from '../../mcp-apex-deploy/lib/plugin-assets.js';

import { detectEmbeddedAssets, reembedFromAssets } from '../../mcp-apex-deploy/lib/plugin-assets.js';

/** Kompatibilität: baut alle eingebetteten Assets (bundle+copy) aus dem Repo neu und re-embeddet sie. */
export function rebuildEmbeddedBundles({ repoDir, exportSql }, deps = {}) {
  const assets = detectEmbeddedAssets(exportSql, repoDir, deps);
  const r = reembedFromAssets(exportSql, assets, repoDir, deps);
  return { sql: r.sql, updated: r.updated.map((u) => ({ bundle: u.file, bytes: u.bytes })), skipped: r.skipped.map((s) => ({ bundle: s.file, reason: s.reason })) };
}
