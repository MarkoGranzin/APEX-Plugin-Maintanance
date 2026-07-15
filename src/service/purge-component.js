/**
 * T-143 — Plugin vollständig löschen (Purge): aus dem Tool, aus der Test-APEX-App UND von der Platte.
 *
 * Bewusst destruktiv und daher nur mit ausdrücklicher Namens-Bestätigung (Endpoint prüft confirm===name)
 * und „etwas versteckt" in der GUI (Danger-Zone). Alle Effekte sind injizierbar → deterministisch testbar.
 *
 * SICHERHEIT: Auf der Platte werden NUR vom Tool VERWALTETE Pfade gelöscht (unter workDir oder DATA_DIR).
 * Ein extern/lokal zugeordnetes Repo (component.path außerhalb) bleibt unangetastet — es sind die Dateien
 * des Nutzers, nicht die des Tools. APEX-seitig werden nur die plugin-EIGENE Testseite (apexPageId) und das
 * plugin-EIGENE Plug-in entfernt — nie reservierte/fremde Seiten.
 *
 * Resultat: src/service/purge-component.js
 */

import path from 'node:path';

/** Liegt `child` (aufgelöst) UNTERHALB von `parent`? Guard gegen das Löschen fremder/lokaler Pfade. */
export function isUnder(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Vom Tool VERWALTETE Platten-Pfade einer Komponente (die gelöscht werden dürfen). Externe lokale Repos
 * (component.path außerhalb workDir/DATA_DIR) werden NICHT gelistet, sondern als `skipped` zurückgegeben.
 * @param {{name:string, path?:string}} c
 * @param {{dataDir:string, workDir:string, slugify:(s:string)=>string}} o
 */
export function managedPaths(c, o) {
  const slug = o.slugify(c.name);
  const list = [];
  const skipped = [];
  if (c.path) {
    if (isUnder(c.path, o.workDir) || isUnder(c.path, o.dataDir)) list.push(c.path); // verwalteter Repo-Klon (inkl. .maintenance/mock)
    else skipped.push({ path: c.path, reason: 'external/local repo — not deleted' });
  }
  list.push(path.join(o.dataDir, 'logs', slug));            // Prüfprotokolle (F-22)
  list.push(path.join(o.dataDir, 'ui-tests', slug));         // Coded-UI-Test-Specs
  list.push(path.join(o.dataDir, 'sbom', `${slug}.cdx.json`)); // SBOM
  list.push(path.join(o.dataDir, 'baseline', `${slug}.json`)); // Mock-Baseline
  return { list, skipped };
}

/**
 * Vollständiges Löschen: APEX (Seite + Plug-in) → Platte (nur verwaltet) → Registry.
 * @param {object} store  Komponenten-Store (get/remove)
 * @param {string} id
 * @param {{apexCleanup?:(c)=>Promise<any>, dataDir?:string, workDir?:string, slugify?:Function,
 *          rm?:(p:string)=>void, exists?:(p:string)=>boolean}} deps
 */
export async function purgeComponent(store, id, deps = {}) {
  const c = store.get(id);
  if (!c) return { ok: false, error: 'not found' };
  const result = { component: c.name, apex: null, removed: [], skipped: [], registry: false };

  // 1) APEX-Cleanup (best-effort — schlägt es fehl, wird der Rest trotzdem entfernt; ehrlich gemeldet).
  if (deps.apexCleanup) {
    try { result.apex = await deps.apexCleanup(c); }
    catch (e) { result.apex = { ok: false, error: String(e?.message ?? e) }; }
  }

  // 2) Platte — nur verwaltete Pfade.
  if (deps.dataDir && deps.workDir && deps.slugify) {
    const { list, skipped } = managedPaths(c, { dataDir: deps.dataDir, workDir: deps.workDir, slugify: deps.slugify });
    result.skipped = skipped;
    const rm = deps.rm ?? (() => {});
    const exists = deps.exists ?? (() => false);
    for (const p of list) { try { if (exists(p)) { rm(p); result.removed.push(p); } } catch { /* einzelnen Pfad-Fehler nicht eskalieren */ } }
  }

  // 3) Registry.
  result.registry = store.remove(id);
  result.ok = result.registry;
  return result;
}
