/**
 * T-79 — Vendored-Lib-Updates wirklich einspielen (Kern der Pflege).
 *
 * classifyUpdate: safe (gleiche Major-Version = Minor/Patch) vs breaking (Major-Sprung) vs none.
 * applyVendoredUpdates: für veraltete vendored Libs mit SICHEREM Update die neue Datei aus dem CDN
 * (jsDelivr/npm) laden und die lokale vendored Datei ersetzen (mit Backup für Rollback). Breaking-
 * Updates werden NICHT getauscht, sondern gemeldet (manuell/KI-Migration). Danach spiegelt ein
 * erneuter Scan die neue Version (SBOM). fetch/download injizierbar → deterministisch testbar.
 *
 * Resultat: src/service/lib-update.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectVendoredLibraries } from '../sbom/vendored.js';
import { npmPackageName } from '../sbom/registry.js';
import { detectEmbeddedAssets, reembedFromAssets } from '../../mcp-apex-deploy/lib/plugin-assets.js';
import { findPluginExport } from './apex-live.js';
import { cmpSemver as cmp } from '../util/version.js';
import { listFiles } from '../inventory/inventory.js';

/** Version-Token, das im Dateinamen steckt (gleiche Konvention wie die SBOM-Erkennung in vendored.js). */
function versionInBase(base) {
  const m = String(base).match(/[-.@](\d+\.\d+(?:\.\d+)?)(?:[.-]min)?\.(?:js|css)$/);
  return m ? m[1] : null;
}

/**
 * Ersetzt literale Referenzen auf den ALTEN Dateinamen (Basename) durch den neuen in allen Text-Dateien
 * des Repos (HTML/JS/CSS/SQL/JSON …). Sichert jede geänderte Datei in `backups` (Rollback). Überspringt
 * bereits gesicherte Pfade (z.B. die frisch umbenannte Lib-Datei mit null-Marker → nicht überschreiben).
 * @returns {number} Anzahl geänderter Dateien
 */
function rewriteReferences(dir, oldBase, newBase, backups, deps = {}) {
  if (!oldBase || oldBase === newBase) return 0;
  const list = deps.listFiles ?? listFiles;
  let files = [];
  try { files = list(dir); } catch { return 0; }
  const textRe = /\.(js|css|html?|sql|json|xml|md|txt)$/i;
  let changed = 0;
  for (const rel of files) {
    if (!textRe.test(rel)) continue;
    const abs = path.join(dir, rel);
    if (backups.has(abs)) continue; // schützt den null-Marker der neuen Lib-Datei
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!content.includes(oldBase)) continue;
    backups.set(abs, content);
    fs.writeFileSync(abs, content.split(oldBase).join(newBase));
    changed++;
  }
  return changed;
}


/**
 * 'none' | 'safe' | 'breaking'. safe = gleiche Breaking-Stelle, neuere Version.
 * Für 0.x.y gilt die semver-Konvention für pre-1.0: die MINOR-Stelle ist breaking
 * (z.B. three 0.116 → 0.185 ist breaking, nicht safe), sonst die MAJOR-Stelle.
 */
export function classifyUpdate(current, latest) {
  if (!current || !latest || current === 'unbekannt') return 'none';
  const pc = String(current).split('.').map((n) => Number(n) || 0);
  const pl = String(latest).split('.').map((n) => Number(n) || 0);
  if (pc[0] == null || pl[0] == null) return 'none';
  if (cmp(latest, current) <= 0) return 'none';
  const bi = (pc[0] === 0 && pl[0] === 0) ? 1 : 0; // 0.x → Minor ist die Breaking-Stelle
  return (pc[bi] || 0) === (pl[bi] || 0) ? 'safe' : 'breaking';
}

/** Lädt die Default-Datei einer npm-Version vom CDN (best effort). */
async function defaultFetchFile(pkg, version, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error('kein fetch verfügbar');
  const res = await fetchFn(`https://cdn.jsdelivr.net/npm/${encodeURIComponent(pkg)}@${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`CDN ${res.status}`);
  return await res.text();
}

/**
 * Spielt sichere Updates ein; meldet breaking. Liefert Ergebnisse + Backups (für Rollback).
 * @param {string} dir  Repo-Verzeichnis
 * @param {Array} libs  comp.libs (mit version/latest/outdated)
 * @param {{fetchFile?:Function, fetch?:Function}} [deps]
 */
export async function applyVendoredUpdates(dir, libs, deps = {}) {
  const results = [];
  const backups = new Map(); // absoluter Pfad -> alter Inhalt
  if (!dir || !fs.existsSync(dir)) return { results, backups };
  const fetchFile = deps.fetchFile ?? ((pkg, ver) => defaultFetchFile(pkg, ver, deps));
  const detected = detectVendoredLibraries(dir); // name -> evidence (Datei)
  const fileFor = (name) => detected.find((d) => d.name === name)?.evidence;

  for (const lib of libs ?? []) {
    if (!lib.outdated || !lib.latest) continue;
    const cls = classifyUpdate(lib.version, lib.latest);
    if (cls === 'none') continue;
    // Breaking (Major-Sprung) wird standardmäßig NICHT blind getauscht — die Software migriert es
    // über ihren KI-Agenten (force=true, danach KI-Fix der aufrufenden Stellen + Re-Test/Rollback).
    if (cls === 'breaking' && !deps.force) {
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, breaking: true, reason: 'breaking (major) — use “force to latest” or the verified migration (Tests tab)' });
      continue;
    }
    const rel = fileFor(lib.name);
    if (!rel) { results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, reason: 'file not found in repo' }); continue; }
    const abs = path.join(dir, rel);
    try {
      const content = await fetchFile(npmPackageName(lib.name), lib.latest);
      if (!content || typeof content !== 'string') throw new Error('leerer Download');
      if (fs.existsSync(abs)) backups.set(abs, fs.readFileSync(abs, 'utf8'));
      // Steht die ALTE Version im Dateinamen (z.B. lz-string-1.0.2.js), muss die Datei auf die neue Version
      // umbenannt werden — sonst liest die SBOM-Erkennung die Version weiter aus dem Namen und der Status
      // bleibt „veraltet", obwohl der Inhalt aktuell ist. Referenzen werden repo-weit mitgezogen.
      const base = path.basename(rel);
      const embedded = versionInBase(base);
      let outRel = rel, outAbs = abs, renamedTo = null, refsUpdated = 0;
      if (embedded && embedded === lib.version) {
        const i = base.lastIndexOf(embedded);
        const newBase = base.slice(0, i) + lib.latest + base.slice(i + embedded.length);
        if (newBase !== base) { renamedTo = newBase; outRel = rel.slice(0, rel.length - base.length) + newBase; outAbs = path.join(dir, outRel); }
      }
      fs.writeFileSync(outAbs, content);
      if (renamedTo && outAbs !== abs) {
        fs.rmSync(abs, { force: true });
        backups.set(outAbs, null); // Rollback: die neu angelegte Datei wieder entfernen
        refsUpdated = rewriteReferences(dir, base, renamedTo, backups, deps);
      }
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: true, breaking: cls === 'breaking', file: outRel, ...(renamedTo ? { renamedFrom: base, renamedTo, refsUpdated } : {}) });
    } catch (e) {
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, reason: 'download/write failed: ' + (e?.message ?? e) });
    }
  }
  // B-40: Die aktualisierten Quell-Libs müssen in die AUSGELIEFERTEN Artefakte — sonst erreicht das Update
  // das deployte Plugin nie: viele Plugins laden gebündelte (gulp-concat) Dateien, die als HEX-Blob in der
  // Plugin-.sql eingebettet sind und genau so in APEX installiert werden. Nach jedem angewandten Quell-Update
  // die Bundles neu bauen und in die .sql re-embedden (mit Rollback-Backup der .sql).
  if (results.some((r) => r.applied)) {
    try { const re = reembedBundles(dir, backups, deps); if (re) results.push(re); }
    catch (e) { results.push({ step: 'reembed', ok: false, reason: String(e?.message ?? e) }); }
  }
  return { results, backups };
}

/** B-40 (generisch): die in die Plugin-.sql eingebetteten Laufzeit-Assets aus den aktualisierten Quellen
 *  neu erzeugen (bundle=gulp-concat, copy=Repo-Datei) und re-einbetten — nur bei realer Inhaltsänderung.
 *  Kind-agnostisch (region/item/DA/Template-Component). Backup der .sql für Rollback. */
export function reembedBundles(dir, backups, deps = {}) {
  const exists = deps.exists ?? ((f) => fs.existsSync(f));
  const read = deps.readText ?? ((f) => fs.readFileSync(f, 'utf8'));
  const write = deps.writeText ?? ((f, c) => fs.writeFileSync(f, c));
  const exportPath = (deps.findExport ?? findPluginExport)(dir, deps);
  if (!exportPath || !exists(exportPath)) return null;
  const exportSql = read(exportPath);
  const assets = detectEmbeddedAssets(exportSql, dir, deps);
  const r = reembedFromAssets(exportSql, assets, dir, deps);
  if (!r.updated.length) return { step: 'reembed', ok: false, updated: [], skipped: r.skipped };
  if (backups && !backups.has(exportPath)) backups.set(exportPath, exportSql); // Rollback der .sql
  write(exportPath, r.sql);
  return { step: 'reembed', ok: true, file: path.basename(exportPath), updated: r.updated.map((u) => u.file), bytes: r.updated.reduce((a, u) => a + u.bytes, 0) };
}

/** Setzt eingespielte Updates zurück (bei Regression). null-Inhalt = die (neu angelegte) Datei löschen. */
export function rollbackUpdates(backups) {
  for (const [abs, content] of backups || []) {
    try { if (content === null) fs.rmSync(abs, { force: true }); else fs.writeFileSync(abs, content); } catch { /* ignore */ }
  }
}
