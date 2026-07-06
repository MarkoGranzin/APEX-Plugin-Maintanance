/**
 * T-144 — Einfacher Datei-Import (Alternative zu Git): ein Plugin aus HOCHGELADENEN Dateien anlegen.
 *
 * Für den Fall, dass kein Git verwendet wird: die Plugin-Export-SQL (und optional JS/CSS-Assets) werden
 * in ein VOM TOOL VERWALTETES Verzeichnis (workDir/<slug>) geschrieben und eine Komponente angelegt, deren
 * Pfad dorthin zeigt. Danach greifen Analyse, Pflege, apex-live und Purge exakt wie bei einem Git-Repo —
 * nur ohne Remote (source = „Datei-Import", repo = null). Alle Effekte injizierbar → deterministisch testbar.
 *
 * SICHERHEIT: nur erlaubte Dateiendungen, keine Pfad-Traversal (basename-Check) — es landet nichts außerhalb
 * des Zielverzeichnisses. Mindestens eine .sql (Plugin-Export) ist Pflicht.
 *
 * Resultat: src/service/import-file.js
 */

import path from 'node:path';
import { repoCheckoutDir, repoComponent } from './workspace.js';
import { slug } from '../util/slug.js';

const SQL_RE = /\.sql$/i;
const ALLOWED = /\.(sql|js|css|json|md|txt)$/i; // Plugin-Export + typische Asset-/Doku-Dateien

/**
 * @param {object} store  Komponenten-Store (list/add/update)
 * @param {{name?:string, files:Array<{name:string, content:string}>}} payload
 * @param {{workDir:string, writeFile:(p:string,c:string)=>void, mkdir:(p:string)=>void}} deps
 * @returns {{ok:true, component:object, dir:string, files:string[]} | {error:string}}
 */
export function importFromFiles(store, payload, deps = {}) {
  const files = (payload?.files || []).filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string');
  if (!files.length) return { error: 'Keine Dateien übergeben.' };
  // Nur sichere Dateinamen (kein Verzeichnis-Traversal, nur erlaubte Endungen).
  for (const f of files) {
    // Kein Verzeichnis-Anteil erlaubt (basename === name) → kein Traversal; nur erlaubte Endungen.
    if (path.basename(f.name) !== f.name || /[/\\]/.test(f.name) || !ALLOWED.test(f.name)) return { error: `Ungültiger oder nicht erlaubter Dateiname: ${f.name}` };
  }
  const sqlFile = files.find((f) => SQL_RE.test(f.name));
  if (!sqlFile) return { error: 'Kein Plugin-Export dabei — mindestens eine .sql-Datei ist nötig.' };

  const name = (payload.name && payload.name.trim()) || path.basename(sqlFile.name).replace(SQL_RE, '');
  if (!name) return { error: 'Kein Name ableitbar.' };
  if (!deps.workDir) return { error: 'Arbeitsverzeichnis nicht konfiguriert.' };

  const dir = repoCheckoutDir(deps.workDir, slug(name));
  deps.mkdir(dir);
  for (const f of files) deps.writeFile(path.join(dir, path.basename(f.name)), f.content);

  // Typ/Format/Status wie bei einem Repo-Checkout aus dem Verzeichnis erkennen.
  const rc = repoComponent(dir, name);
  const patch = { name, source: 'Datei-Import', repo: null, path: dir, type: rc.type, format: rc.format, status: rc.status };
  // Re-Import desselben Plugins (gleiches Zielverzeichnis) aktualisiert statt zu duplizieren.
  const existing = store.list().find((c) => c.path === dir);
  const comp = existing ? store.update(existing.id, patch) : store.add(patch);
  return { ok: true, component: comp, dir, files: files.map((f) => path.basename(f.name)) };
}
