import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginRun, persistBackups, finishRun, hasInterruptedRun, recoverInterruptedRun } from '../src/service/run-guard.js';

describe('B-58 Run-Guard: crash-sicherer Rollback unterbrochener Läufe', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runguard-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'OLD');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persistiert Backups → recover stellt geänderte Datei wieder her und löscht neu angelegte', () => {
    beginRun(dir, { startedAt: 't', component: 'P' });
    // Simuliere ein angewandtes Update: alte Datei überschrieben (Backup=OLD) + eine NEU angelegte Datei (Backup=null)
    const abs = path.join(dir, 'lib', 'jquery.min.js');
    const newAbs = path.join(dir, 'lib', 'jquery-3.7.1.min.js');
    const backups = new Map([[abs, 'OLD'], [newAbs, null]]);
    persistBackups(dir, backups);
    // Der Lauf „läuft": Dateien sind bereits im neuen Zustand …
    fs.writeFileSync(abs, 'NEW');
    fs.writeFileSync(newAbs, 'BRAND-NEW');
    // … dann Crash. Nächster Start:
    expect(hasInterruptedRun(dir)).toBe(true);
    const r = recoverInterruptedRun(dir);
    expect(r.recovered).toBe(true);
    expect(r.restored).toBe(1);
    expect(r.removed).toBe(1);
    expect(fs.readFileSync(abs, 'utf8')).toBe('OLD');          // wiederhergestellt
    expect(fs.existsSync(newAbs)).toBe(false);                 // neu angelegte Datei entfernt
    expect(hasInterruptedRun(dir)).toBe(false);                // Marker geräumt
  });

  it('finishRun räumt den Marker → kein Rollback nach sauberem Abschluss', () => {
    beginRun(dir, { startedAt: 't' });
    persistBackups(dir, new Map([[path.join(dir, 'lib', 'jquery.min.js'), 'OLD']]));
    finishRun(dir);
    expect(hasInterruptedRun(dir)).toBe(false);
    // Datei bleibt wie sie ist (NEW), da der Lauf sauber endete
    fs.writeFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'NEW');
    const r = recoverInterruptedRun(dir);
    expect(r.recovered).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib', 'jquery.min.js'), 'utf8')).toBe('NEW');
  });

  it('ohne Marker/ohne Lauf: recover ist ein No-op', () => {
    expect(hasInterruptedRun(dir)).toBe(false);
    expect(recoverInterruptedRun(dir)).toMatchObject({ recovered: false });
  });
});
