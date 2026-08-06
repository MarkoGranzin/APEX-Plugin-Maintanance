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

import fs from 'node:fs';
import path from 'node:path';
import { repoCheckoutDir, repoComponent } from './workspace.js';
import { slug } from '../util/slug.js';

const SQL_RE = /\.sql$/i;
const ALLOWED = /\.(sql|js|css|json|md|txt)$/i; // Plugin-Export + typische Asset-/Doku-Dateien
// B-76: liegt im Zielverzeichnis schon ein Export (früherer Import), dürfen weitere Dateien OHNE .sql
// nachgereicht werden — die .sql-Pflicht gilt nur für ein NEUES Plugin.
const defaultHasExistingSql = (dir) => { try { return fs.readdirSync(dir).some((f) => SQL_RE.test(f)); } catch { return false; } };

/**
 * @param {object} store  Komponenten-Store (list/add/update)
 * @param {{name?:string, files:Array<{name:string, content:string}>}} payload
 * @param {{workDir:string, writeFile:(p:string,c:string)=>void, mkdir:(p:string)=>void}} deps
 * @returns {{ok:true, component:object, dir:string, files:string[]} | {error:string}}
 */
export function importFromFiles(store, payload, deps = {}) {
  const raw = (payload?.files || []).filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string');
  if (!raw.length) return { error: 'No files provided.' };
  // T-168: RELATIVE Pfade sind erlaubt (Ordner-Picker lädt die Struktur hoch) — aber nur SICHERE:
  // keine absoluten Pfade/Laufwerke, keine ..-Segmente; Nicht-Laufzeit-Ordner werden übersprungen.
  const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.maintenance)(\/|$)/i;
  const safeRel = (name) => {
    const n = String(name).replace(/\\/g, '/');
    if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
    const parts = n.split('/').filter((p) => p && p !== '.');
    if (!parts.length || parts.some((p) => p === '..')) return null;
    return parts.join('/');
  };
  const files = [];
  for (const f of raw) {
    const rel = safeRel(f.name);
    if (rel === null) return { error: `Invalid or disallowed file name: ${f.name}` };
    if (SKIP_DIRS.test(rel)) continue; // node_modules/.git still still überspringen (kein Fehler)
    if (!ALLOWED.test(rel)) return { error: `Invalid or disallowed file name: ${f.name}` };
    files.push({ name: rel, content: f.content });
  }
  if (!files.length) return { error: 'No files provided.' };
  const sqlFile = files.find((f) => SQL_RE.test(f.name));
  const name = (payload.name && payload.name.trim()) || (sqlFile ? path.basename(sqlFile.name).replace(SQL_RE, '') : '');
  if (!name) return { error: 'No name derivable.' };
  if (!deps.workDir) return { error: 'Working directory not configured.' };

  const dir = repoCheckoutDir(deps.workDir, slug(name));
  // B-76: ohne .sql nur erlaubt, wenn dieser Import-Ordner bereits einen Export enthält (Nachreichen).
  const hasExistingSql = (deps.hasExistingSql ?? defaultHasExistingSql)(dir);
  if (!sqlFile && !hasExistingSql) return { error: 'No plugin export included — at least one .sql file is required (re-import with the SAME name to add files to an existing import).' };
  deps.mkdir(dir);
  for (const f of files) {
    const target = path.join(dir, ...f.name.split('/')); // sichere relative Struktur (T-168)
    deps.mkdir(path.dirname(target));
    deps.writeFile(target, f.content);
  }

  // Typ/Format/Status wie bei einem Repo-Checkout aus dem Verzeichnis erkennen.
  const rc = repoComponent(dir, name);
  const patch = { name, source: 'Datei-Import', repo: null, path: dir, type: rc.type, format: rc.format, status: rc.status };
  // Re-Import desselben Plugins (gleiches Zielverzeichnis) aktualisiert statt zu duplizieren.
  const existing = store.list().find((c) => c.path === dir);
  const comp = existing ? store.update(existing.id, patch) : store.add(patch);
  return { ok: true, component: comp, dir, files: files.map((f) => path.basename(f.name)) };
}
