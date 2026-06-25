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
import { cmpSemver as cmp } from '../util/version.js';

const major = (v) => { const m = String(v ?? '').match(/(\d+)/); return m ? Number(m[1]) : null; };

/** 'none' | 'safe' | 'breaking' — safe = gleiche Major, neuere Version. */
export function classifyUpdate(current, latest) {
  if (!current || !latest || current === 'unbekannt') return 'none';
  const mc = major(current);
  const ml = major(latest);
  if (mc == null || ml == null) return 'none';
  if (cmp(latest, current) <= 0) return 'none';
  return mc === ml ? 'safe' : 'breaking';
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
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, breaking: true, reason: 'breaking (Major) — Migration durch KI-Agent der Software' });
      continue;
    }
    const rel = fileFor(lib.name);
    if (!rel) { results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, reason: 'Datei nicht gefunden' }); continue; }
    const abs = path.join(dir, rel);
    try {
      const content = await fetchFile(npmPackageName(lib.name), lib.latest);
      if (!content || typeof content !== 'string') throw new Error('leerer Download');
      if (fs.existsSync(abs)) backups.set(abs, fs.readFileSync(abs, 'utf8'));
      fs.writeFileSync(abs, content);
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: true, breaking: cls === 'breaking', file: rel });
    } catch (e) {
      results.push({ name: lib.name, from: lib.version, to: lib.latest, applied: false, reason: 'Download/Schreiben fehlgeschlagen: ' + (e?.message ?? e) });
    }
  }
  return { results, backups };
}

/** Setzt eingespielte Updates zurück (bei Regression). */
export function rollbackUpdates(backups) {
  for (const [abs, content] of backups || []) {
    try { fs.writeFileSync(abs, content); } catch { /* ignore */ }
  }
}
