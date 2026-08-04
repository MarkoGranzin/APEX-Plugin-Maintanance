/**
 * B-58 — Crash-sicherer Pflegelauf: Lib-Update-Backups NICHT nur im RAM halten, sondern für die Dauer
 * eines Laufs nach .maintenance/ persistieren. Stirbt der Dienst mitten im Lauf (z.B. OOM bei langen
 * KI-/Playwright-Läufen), kann der nächste Start den unterbrochenen Lauf erkennen und aus den
 * persistierten Backups sauber ZURÜCKROLLEN (statt einen halb-aktualisierten, unverifizierten Stand zu
 * hinterlassen). KEINE festen Timeouts — die Erkennung ist zustands-/liveness-basiert (Marker existiert
 * ⇒ Lauf lief nicht sauber zu Ende). Reine fs-Logik, alle Zugriffe injizierbar → deterministisch testbar.
 *
 * Resultat: src/service/run-guard.js
 */

import fs from 'node:fs';
import path from 'node:path';

const RUN_FILE = '.maintenance/run.json';
const BK_DIR = '.maintenance/backups';

function io(deps = {}) {
  return {
    exists: deps.exists ?? ((p) => fs.existsSync(p)),
    readFile: deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8')),
    writeFile: deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c)),
    mkdir: deps.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true })),
    rm: deps.rm ?? ((p) => fs.rmSync(p, { recursive: true, force: true })),
    rmFile: deps.rmFile ?? ((p) => fs.rmSync(p, { force: true })),
  };
}

/** Startet die Absicherung eines Laufs: schreibt einen Run-Marker (leerer Backup-Satz). */
export function beginRun(dir, info = {}, deps = {}) {
  const { writeFile, mkdir } = io(deps);
  mkdir(path.join(dir, '.maintenance'));
  const marker = { startedAt: info.startedAt ?? null, component: info.component ?? null, phase: info.phase ?? 'started', backups: [] };
  writeFile(path.join(dir, RUN_FILE), JSON.stringify(marker));
  return marker;
}

/**
 * Persistiert die (In-RAM-)Backups eines angewandten Lib-Updates: Map absoluterPfad → alterInhalt|null.
 * null = die Datei wurde NEU angelegt (Rollback = löschen); sonst wird der alte Inhalt als Backup abgelegt.
 * Idempotent-anfügend an den Marker; legt beginRun-Marker bei Bedarf implizit an.
 */
export function persistBackups(dir, backups, deps = {}) {
  const { exists, readFile, writeFile, mkdir } = io(deps);
  if (!backups || !backups.size) return null;
  mkdir(path.join(dir, BK_DIR));
  const markerPath = path.join(dir, RUN_FILE);
  const marker = exists(markerPath) ? safeJson(readFile(markerPath)) : { startedAt: null, backups: [] };
  marker.backups = marker.backups || [];
  let i = marker.backups.length;
  for (const [abs, old] of backups) {
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (old == null) {
      marker.backups.push({ path: rel, created: true }); // neu angelegt → Rollback löscht sie
    } else {
      const bk = `bk-${i}.txt`;
      writeFile(path.join(dir, BK_DIR, bk), old);
      marker.backups.push({ path: rel, backup: bk });
      i++;
    }
  }
  writeFile(markerPath, JSON.stringify(marker));
  return marker;
}

/** Lauf sauber abgeschlossen (adoptiert ODER regulär zurückgerollt) → Marker + Backups entfernen. */
export function finishRun(dir, deps = {}) {
  const { exists, rm, rmFile } = io(deps);
  const runFile = path.join(dir, RUN_FILE);
  if (exists(runFile)) rmFile(runFile);
  const bkDir = path.join(dir, BK_DIR);
  if (exists(bkDir)) rm(bkDir);
}

/** Gibt es einen unterbrochenen Lauf (Marker vorhanden)? */
export function hasInterruptedRun(dir, deps = {}) {
  const { exists } = io(deps);
  return exists(path.join(dir, RUN_FILE));
}

/**
 * Beim Start aufzurufen: liegt ein Run-Marker vor, endete der vorige Lauf NICHT sauber (Crash/Kill).
 * Rollt alle persistierten Backups zurück (neu angelegte Dateien löschen, geänderte wiederherstellen)
 * und räumt die Marker. @returns {{recovered, restored, removed, startedAt}}
 */
export function recoverInterruptedRun(dir, deps = {}) {
  const { exists, readFile, writeFile, rm, rmFile } = io(deps);
  const runFile = path.join(dir, RUN_FILE);
  if (!exists(runFile)) return { recovered: false, restored: 0, removed: 0 };
  const marker = safeJson(readFile(runFile)) || { backups: [] };
  let restored = 0, removed = 0;
  for (const b of marker.backups || []) {
    const abs = path.join(dir, b.path);
    if (b.created) {
      if (exists(abs)) { rmFile(abs); removed++; }
    } else if (b.backup) {
      const bkAbs = path.join(dir, BK_DIR, b.backup);
      if (exists(bkAbs)) { writeFile(abs, readFile(bkAbs)); restored++; }
    }
  }
  if (exists(runFile)) rmFile(runFile);
  const bkDir = path.join(dir, BK_DIR);
  if (exists(bkDir)) rm(bkDir);
  return { recovered: true, restored, removed, startedAt: marker.startedAt ?? null };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
