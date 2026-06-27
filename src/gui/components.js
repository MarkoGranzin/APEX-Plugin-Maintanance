/**
 * T-33 — Übersicht/Detail-View-Model + Aktionen (Verzeichnis öffnen, manuelles Review).
 *
 * Liefert die Daten für die Komponenten-GUI und zwei Aktionen:
 *  - openDirectory: das Verzeichnis der Komponente im OS-Explorer öffnen (plattformabhängig, injizierbar).
 *  - manualReview: das Review-Gate (T-31, Security + Code) über die extrahierten Assets der Komponente
 *    laufen lassen, Findings liefern und auf Wunsch als Review-Notiz an der Komponente sichern.
 *
 * Resultat: src/gui/components.js
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { detectArtifacts } from '../inventory/inventory.js';
import { extractArtifact } from '../extract/extract.js';
import { reviewGate as defaultReviewGate } from '../run/review.js';

const FORMAT_BADGE = { export: 'APEX-SQL-Export', source: 'JS+CSS roh', mixed: 'gemischt', unclear: 'noch nicht erkannt' };

/** Übersichts-View-Model: eine kompakte Zeile je Komponente. */
export function overviewViewModel(store) {
  return store.list().map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    repo: c.repo ?? null,
    formatBadge: FORMAT_BADGE[c.format] ?? 'unklar',
    status: c.status,
    critical: c.critical,
    lastChange: c.lastChange ?? null,
    changeSummary: c.lastChange?.summary ?? '—',
    libs: c.libs ?? [],
    libWarning: c.libWarning ?? null,
    rebuilt: !!c.rebuilt,
    rebuiltTo: c.rebuiltTo ?? null,
    mockUrl: c.mockUrl ?? null,   // F-29: „Open mock"-Button direkt in der Liste
    mockMode: c.mockMode ?? null,
    mockNote: c.mockNote ?? null,        // Fallback-Grund sichtbar machen (statt still „static")
    mockSelfCheck: c.mockSelfCheck ?? null, // Self-Test-Ergebnis (views/total/failed) fürs Listen-Badge
    notesCount: c.notes.length,
    reviewsCount: c.reviews.length,
  }));
}

/** Detail-View-Model: volle Komponente mit zeitlich absteigenden Notizen/Reviews. */
export function detailViewModel(store, id) {
  const c = store.get(id);
  if (!c) return null;
  const desc = (a, b) => String(b.at).localeCompare(String(a.at));
  return { ...c, formatBadge: FORMAT_BADGE[c.format] ?? 'unklar', notes: [...c.notes].sort(desc), reviews: [...c.reviews].sort(desc) };
}

const OPENERS = {
  win32: (p) => ['explorer', [p]],
  darwin: (p) => ['open', [p]],
  linux: (p) => ['xdg-open', [p]],
};

/** Öffnet das Verzeichnis im OS-Explorer. spawn/platform injizierbar. */
export function openDirectory(targetPath, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const builder = OPENERS[platform] ?? OPENERS.linux;
  const [cmd, args] = builder(targetPath);
  if (!targetPath) return { ok: false, error: 'kein Pfad' };
  try {
    (opts.spawn ?? defaultSpawn)(cmd, args);
    return { ok: true, command: `${cmd} ${args.join(' ')}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), command: cmd };
  }
}

function defaultSpawn(cmd, args) {
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/** Sammelt die zu prüfenden Assets einer Komponente aus ihrem Pfad (Default-Gather). */
export function defaultGather(component) {
  const dir = component.path;
  if (!dir || !fs.existsSync(dir)) return { assets: [], cve: [] }; // kein/ungültiger Pfad → keine Assets
  const arts = detectArtifacts(dir);
  const match = arts.find((a) => a.name === component.name) ?? arts[0];
  if (!match) return { assets: [], cve: [] };
  const bundle = extractArtifact(match, { rootDir: dir });
  return { assets: [...bundle.js, ...bundle.css, ...bundle.inlineCode], cve: [] };
}

/**
 * Manuelles Code-Review einer Komponente: Assets sammeln → Review-Gate → optional als Notiz sichern.
 * @param {object} store
 * @param {string} id
 * @param {object} [opts] gather/reviewGate (injizierbar), save (bool)
 */
export function manualReview(store, id, opts = {}) {
  const component = store.get(id);
  if (!component) return { error: 'Komponente nicht gefunden' };
  const gather = opts.gather ?? defaultGather;
  const change = gather(component);
  if (!change.assets || change.assets.length === 0) {
    return { gate: null, empty: true, message: component.source ? 'No verifiable assets found.' : 'No repo assigned — please assign a repo first.' };
  }
  const gate = (opts.reviewGate ?? defaultReviewGate)(change, opts.gateDeps ?? {});
  const now = opts.now ?? (() => new Date().toISOString());

  const findings = [...(gate.security?.findings ?? []), ...(gate.quality?.findings ?? [])];

  // Review ins Protokoll schreiben (welcher Agent prüfte welche Datei) — F-22-Integration
  const reviewEntries = [];
  for (const f of gate.security?.findings ?? []) reviewEntries.push({ agent: 'Security', file: f.asset || component.name, result: `${f.rule || ''}: ${f.message || ''}`.trim(), severity: f.severity });
  for (const f of gate.quality?.findings ?? []) reviewEntries.push({ agent: 'Code-Review', file: f.asset || component.name, result: `${f.rule || ''}: ${f.message || ''}`.trim(), severity: f.severity });
  reviewEntries.push({ agent: 'Review-Gate', file: component.name, result: gate.pass ? 'bestanden (approved)' : `blockiert (${gate.stage})`, severity: gate.pass ? undefined : 'error' });
  const keepers = (store.get(id).lastLog?.entries ?? []).filter((e) => !['Security', 'Code-Review', 'Review-Gate'].includes(e.agent));
  store.update(id, { lastLog: { at: now(), entries: [...keepers, ...reviewEntries] } });

  let saved = null;
  if (opts.save) {
    saved = store.addReview(id, {
      kind: 'manuell',
      pass: gate.pass,
      stage: gate.stage,
      findingsCount: findings.length,
      findings,
    });
  }
  return { gate, saved, logEntries: reviewEntries };
}
