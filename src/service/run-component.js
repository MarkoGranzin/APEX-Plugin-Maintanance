/**
 * F-19 (T-38) — Lauf-Anbindung: Komponenten-Status & letzte Änderung aus Läufen.
 *
 * Ein Lauf analysiert je Komponente das Repo (scanRepo) und schreibt das Ergebnis in die
 * Registry zurück: lastChange{at,summary} + Status. runManaged iteriert über die Komponenten
 * (optional je Repo) und legt EINEN History-Eintrag an. scan/now/idGen sind injizierbar.
 *
 * Resultat: src/service/run-component.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanRepo } from './run-repo.js';
import { libStatus, libWarningFrom } from './lib-check.js';
import { suggestReplacement } from './lib-replace.js';
import { buildSbom } from '../sbom/sbom.js';
import { buildSetupManifest } from '../../mcp-apex-deploy/lib/apex.js';
import { findPluginExport } from './apex-live.js';

/** Setup-Manifest („Rezept" für die APEX-Einrichtung) aus dem Plugin-Export schreiben (.maintenance/apex-setup.json).
 *  Wird bei jeder Analyse aufgefrischt → existiert von Anfang an, die Einrichtung liest nur noch das JSON. */
export function writeSetupManifest(component) {
  try {
    const exportFile = component?.path ? findPluginExport(component.path) : null;
    if (!exportFile) return null;
    const manifest = buildSetupManifest(fs.readFileSync(exportFile, 'utf8'));
    const dir = path.join(component.path, '.maintenance');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'apex-setup.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch { return null; }
}

/** Verdichtet ein Scan-Ergebnis zu einer Kurz-Zusammenfassung. */
export function summarize(result) {
  let vuln = 0;
  let lint = 0;
  let clarify = 0;
  for (const a of result.artifacts ?? []) {
    vuln += a.static?.retire?.findings?.length ?? 0;
    if (a.static?.lint && !a.static.lint.ok) lint++;
    if (a.status === 'extraktion-unsicher' || a.status === 'clarify') clarify++;
  }
  const outdated = result.outdated?.length ?? 0;
  const risks = result.risks?.length ?? 0;
  const libVuln = result.libWarning?.vulnerable ?? 0;
  const libUnmaint = result.libWarning?.unmaintained ?? 0;
  const libOutdated = result.libWarning?.outdated ?? 0;
  const libUnknown = result.libWarning?.unknown ?? 0;

  const parts = [];
  if (outdated || libOutdated) parts.push(`${outdated + libOutdated} outdated lib(s)`);
  if (vuln || libVuln) parts.push(`${vuln + libVuln} vulnerabilit${vuln + libVuln === 1 ? 'y' : 'ies'}`);
  if (libUnmaint) parts.push(`${libUnmaint} unmaintained lib(s)`);
  if (libUnknown) parts.push(`${libUnknown} lib(s) with unknown version`);
  if (risks) parts.push(`${risks} risk(s)`);
  if (lint) parts.push(`${lint} lint error(s)`);
  if (clarify) parts.push(`${clarify} to clarify`);
  const summary = parts.length ? parts.join(', ') : 'up to date, no issues';

  // Status-WERTE bleiben (GUI übersetzt via Label); veraltete/unbekannte Lib → handlungsbedarf (B-4)
  const status = lint || clarify ? 'zu klären' : outdated || vuln || risks || libVuln || libUnmaint || libOutdated || libUnknown ? 'handlungsbedarf' : 'ok';
  return { summary, status, counts: { outdated: outdated + libOutdated, vuln: vuln + libVuln, risks, lint, clarify, libUnmaint, libUnknown } };
}

/** Formatiert ein Protokoll als Text (für Logdatei/Download). */
export function formatLog(component, lastLog) {
  const head = `Plugin Maintenance — Check protocol\nComponent: ${component.name}\nTime: ${lastLog.at}\n`;
  const body = (lastLog.entries ?? [])
    .map((e) => `[${e.agent}] ${e.file} → ${e.result}${e.severity ? ` (${e.severity})` : ''}`)
    .join('\n');
  return `${head}\n${body}\n`;
}

/** Analysiert EINE Komponente (an ihrem Pfad) und schreibt das Ergebnis in den Store. */
export function runComponentOnce(store, component, opts = {}) {
  const scan = opts.scan ?? scanRepo;
  const now = opts.now ?? (() => new Date().toISOString());
  const result = scan(component.path);
  const cur = store.get(component.id);

  // Web-Anreicherung (latest/Alter/Quelle aus T-59) je name@version über den Scan hinweg erhalten
  const prevByKey = new Map((cur?.libs ?? []).map((l) => [`${l.name}@${l.version}`, l]));
  const prevByName = new Map((cur?.libs ?? []).map((l) => [l.name, l]));
  const mergedLibs = (result.libs ?? []).map((l) => {
    let prev = prevByKey.get(`${l.name}@${l.version}`);
    // B-35 (T-146): frisch erkannte Version ist 'unbekannt', aber ein früherer Lauf hat sie zeitlich
    // inferiert bzw. KI-validiert → Inferenz ÜBERNEHMEN statt verwerfen (Match per NAME — der
    // name@version-Key kann hier nie treffen, weil die frische Seite 'unbekannt' trägt).
    if (!prev && (!l.version || l.version === 'unbekannt')) {
      const p = prevByName.get(l.name);
      if (p && p.version && p.version !== 'unbekannt' && (p.versionInferred || p.detectedBy === 'inferred-by-date' || p.detectedBy === 'ai-validated')) {
        prev = p;
        l = { ...l, version: p.version, versionInferred: p.versionInferred, versionInferredFrom: p.versionInferredFrom, detectedBy: p.detectedBy };
      }
    }
    if (!prev) return l;
    const { latest, releasedAt, ageDays, installedReleasedAt, installedAgeDays, outdated, webStatus, source, homepage, npm } = prev;
    const merged = { ...l, latest, releasedAt, ageDays, installedReleasedAt, installedAgeDays, outdated, webStatus, source, homepage, npm };
    merged.status = libStatus(merged); // Status inkl. Web-Outdated konsistent halten (Re-Test darf ihn nicht zurücksetzen)
    return merged;
  }).map((l) => {
    // Unmaintained Lib → permissiven Ersatz vorschlagen (für GUI/Migration). null wenn gepflegt oder kein Vorschlag.
    if (l.unmaintained || l.status === 'nicht gepflegt') { const rep = suggestReplacement(l.name); if (rep) return { ...l, replacement: rep }; }
    return l;
  });
  // Status/Zusammenfassung aus den GEMERGTEN Libs (inkl. veraltet/unbekannt aus dem Web-Check)
  const libWarning = libWarningFrom(mergedLibs);
  const { summary, status, counts } = summarize({ ...result, libWarning });

  const lastLog = { at: now(), entries: result.log ?? [] };
  // Testplan-Baseline: einmal erzeugt „in Stein" — nur bei explizitem regenerateTestPlan neu
  const regen = !cur?.testPlan || opts.regenerateTestPlan;
  const testPlan = regen ? (result.testPlan ?? null) : cur.testPlan;
  // Coverage + Coded-Tests folgen der Testplan-Baseline (gemeinsam „in Stein", bis neu erzeugt).
  // T-147: aus Fehler-Reports abgeleitete Regressionstests (feedback-*) bleiben AUCH beim Neu-Erzeugen
  // erhalten — sie sind dauerhafter Regressionsschutz, keine generierte Baseline.
  const coverage = regen ? (result.coverage ?? null) : (cur.coverage ?? null);
  const codedTests = regen
    ? [...(result.codedTests ?? []), ...((cur?.codedTests ?? []).filter((t) => /^feedback-/i.test(t.name) && !(result.codedTests ?? []).some((r) => r.name === t.name)))]
    : (cur.codedTests ?? []);
  store.setLastChange(component.id, summary);
  const patch = { status, lastLog, libs: mergedLibs, testPlan, coverage, codedTests, libWarning };
  // Typ/Format automatisch erkannt → zurückschreiben (nur wenn erkannt, sonst alten Wert behalten)
  if (result.format) patch.format = result.format;
  if (result.type) patch.type = result.type;
  store.update(component.id, patch);
  writeSetupManifest(component); // Analyse → Setup-JSON generisch mitschreiben (Rezept für die Einrichtung)
  if (opts.logSink) {
    try { opts.logSink(component, formatLog(component, lastLog)); } catch { /* Logfehler nicht eskalieren */ }
  }
  if (testPlan && testPlan !== cur?.testPlan && opts.onTestPlan) {
    try { opts.onTestPlan(component, testPlan); } catch { /* Datei-Fehler nicht eskalieren */ }
  }
  if (opts.onSbom) {
    try {
      const sbom = buildSbom(component.name, mergedLibs.map((l) => ({ name: l.name, version: l.version, detectedBy: l.detectedBy || 'erkannt', evidence: l.source || l.evidence || '' })));
      opts.onSbom(component, sbom);
    } catch { /* Datei-Fehler nicht eskalieren */ }
  }
  return { component: component.name, summary, status, counts, log: lastLog, testPlanChanged: testPlan !== cur?.testPlan };
}

/**
 * Analysiert alle (oder je Repo gefilterten) Komponenten und schreibt EINEN History-Eintrag.
 * @param {object} args { store, scan?, history?, recordRun?, idGen?, repo? }
 */
export function runManaged(args) {
  const { store, history, recordRun, repo } = args;
  const scan = args.scan ?? scanRepo;
  const comps = store.list().filter((c) => !repo || c.repo === repo);

  const updated = [];
  const failures = [];
  for (const c of comps) {
    try {
      const r = runComponentOnce(store, c, { scan, now: args.now, logSink: args.logSink, onTestPlan: args.onTestPlan, onSbom: args.onSbom });
      updated.push({ artifact: c.name, change: r.summary, status: r.status });
    } catch (err) {
      failures.push({ artifact: c.name, reason: String(err?.message ?? err) });
    }
  }

  const id = args.idGen ? args.idGen() : `run-${Date.now()}`;
  const runEntry = { id, status: failures.length ? (updated.length ? 'partial' : 'red') : 'green', updated, failures, repo: repo ?? null };
  if (recordRun) recordRun(runEntry);
  else if (history) {
    // erlaubt sowohl recordRun-Funktion als auch History-Objekt
    history.runs?.push?.(runEntry);
  }
  return { count: comps.length, updated, failures, run: runEntry };
}
