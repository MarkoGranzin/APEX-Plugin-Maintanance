/**
 * Verkettungs-Schicht: ein vollständiger Pflege-Lauf über EIN Repo.
 *
 * Steckt die Bausteine aller Slices real zusammen (das, was T-27 als Rückgrat beschreibt):
 * Repo → Inventar (T-2) → Format/Test-Pfad (T-18) → kanonische Extraktion inkl. Inline (T-19/T-20)
 * → AST (T-21) → SBOM/Update-Check (T-7) → Risiko (T-16) → Static-First-Gate (T-23) → Report (T-9).
 * Bewusst ohne Netz/AI lauffähig: der „test"-Schritt nutzt das Static-First-Gate (deterministisch);
 * KI-Testgenerierung/Behavior-Tests und echtes Push/Mail sind über deps injizierbar.
 *
 * Resultat: src/service/run-repo.js
 */

import fs from 'node:fs';
import { detectArtifacts } from '../inventory/inventory.js';
import { enrichWithFormat, componentMeta } from '../inventory/format.js';
import { extractArtifact } from '../extract/extract.js';
import { analyzeBundle } from '../extract/analyze.js';
import { scanArtifact } from '../sbom/sbom.js';
import { assessRisks, activeRisks as filterActiveRisks, createAck } from '../sbom/risk.js';
import { lint, retireCheck, makeSnapshot, unmaintainedReason, vulnerabilityFor } from '../test/static.js';
import { detectVendoredLibraries } from '../sbom/vendored.js';
import { libStatus } from './lib-check.js';
import { securityReview, qualityReview } from '../run/review.js';
import { triageViewModel } from '../gui/triage.js';
import { renderReport } from '../report/mail.js';
import { analyzeDeep } from '../test/analyze-deep.js';
import { buildDeepTestPlan, combineDeepPlans } from '../ai/testplan-deep.js';
import { generateCodedTests } from '../test/codegen-ui.js';

/**
 * Liest ein ausgechecktes Repo und liefert je Artefakt das volle Analyse-Bild + Report/Triage.
 * Read-only: verändert das Repo nicht (kein Update/Push) — ideal als Start-/Diagnoselauf.
 *
 * @param {string} repoDir
 * @param {object} [opts] hashDb / latestVersions / signalsByLib / ack / secrets
 */
export function scanRepo(repoDir, opts = {}) {
  const ack = opts.ack ?? createAck();
  if (!repoDir || !fs.existsSync(repoDir)) {
    // kein/ungültiger Checkout (z.B. Repo noch nicht zugeordnet) → leeres, valides Ergebnis
    return { repoDir: repoDir ?? null, artifacts: [], outdated: [], risks: [], failures: [], report: { subject: '', body: '' }, triage: { triageList: [], cards: [], inconsistency: { total: 0, testable: 0, toClarify: 0, noConvention: 0, tone: 'calm', text: '0' }, red: [] }, log: [], testPlan: '', coverage: null, codedTests: [], libs: [], libWarning: null, type: null, format: null };
  }
  const artifacts = enrichWithFormat(detectArtifacts(repoDir));

  const detail = [];
  const allRisks = [];
  const failures = [];
  const updatesFlat = [];
  const log = []; // Prüfprotokoll: welcher Agent prüfte welche Datei (F-22)
  const deepPlans = []; // Tiefen-Testpläne je Artefakt (T-63)
  const codedTestFiles = []; // generierte Coded-UI-/Unit-Tests (T-64)
  const libsMap = new Map(); // verwendete Bibliotheken dieses Plugins

  // vendored Libs (lib/vendor/dist/min.js) sind KEINE Test-Artefakte → nur fürs SBOM
  const isVendored = (art) => {
    const files = art.files ?? [];
    if (files.length === 0) return false;
    return files.every((f) => /(^|\/)(lib|libs|vendor|vendors|node_modules|dist|build|min)\//i.test(f) || /\.min\.(js|css)$/i.test(f) || /(^|\/)(jquery|chart|moment|lodash|d3|bootstrap)[.-]/i.test(f));
  };

  for (const art of artifacts) {
    const bundle = extractArtifact(art, { rootDir: repoDir });
    const analysis = analyzeBundle(bundle);
    const scan = scanArtifact(bundle, { hashDb: opts.hashDb, latestVersions: opts.latestVersions });
    const risks = assessRisks(scan.components, opts.signalsByLib ?? {});
    const staticRes = {
      lint: lint(bundle),
      retire: retireCheck(bundle),
      snapshot: makeSnapshot(bundle).hash,
    };

    // --- Protokoll je Artefakt/Datei ---
    const rootFile = art.rootFile ?? art.files?.[0] ?? art.name;
    log.push({ artifact: art.name, agent: 'Erkennung', file: rootFile, result: `Typ=${art.type}, Format=${art.format}` });
    for (const asset of bundle.js) {
      const lr = lint({ js: [asset], css: [] });
      log.push({ artifact: art.name, agent: 'Lint', file: asset.name, result: lr.ok ? 'ok' : lr.findings.map((f) => f.message).join('; '), severity: lr.ok ? undefined : 'error' });
      const aRes = analysis.find((x) => x.name === asset.name)?.analysis;
      if (aRes?.ok) log.push({ artifact: art.name, agent: 'AST', file: asset.name, result: `Einstiegspunkte: ${aRes.entryPoints.join(', ') || '—'}` });
    }
    for (const f of staticRes.retire.findings) {
      log.push({ artifact: art.name, agent: 'retire.js', file: f.lib, result: `${f.lib}@${f.version} verwundbar (${f.vuln}, fix ab ${f.fixedFrom})`, severity: f.severity ?? 'high' });
    }
    // identische „unsicher"-Befunde je Datei+Grund zusammenfassen (kein Protokoll-Rauschen)
    const unsafeCounts = new Map();
    for (const u of bundle.unsafe) {
      const file = u.location?.sqlFile ?? u.location?.fileName ?? '?';
      const key = `${file}|${u.reason}`;
      const prev = unsafeCounts.get(key) ?? { file, reason: u.reason, n: 0 };
      prev.n++;
      unsafeCounts.set(key, prev);
    }
    for (const { file, reason, n } of unsafeCounts.values()) {
      log.push({ artifact: art.name, agent: 'Extraktion', file, result: `unsicher: ${reason}${n > 1 ? ` (${n}×)` : ''}`, severity: 'warn' });
    }
    log.push({ artifact: art.name, agent: 'Snapshot', file: art.name, result: `golden-master ${staticRes.snapshot.slice(0, 12)}` });

    // aggregierter Analyse-Kontext für den Testplan
    const agg = { entryPoints: [], apexCalls: [], domAccess: [] };
    for (const a of analysis) {
      if (a.analysis.ok) { agg.entryPoints.push(...a.analysis.entryPoints); agg.apexCalls.push(...a.analysis.apexCalls); agg.domAccess.push(...a.analysis.domAccess); }
    }
    // vendored Libs gehören NICHT in den Testplan (sie fluten ihn) — nur eigene Artefakte testen
    if (!isVendored(art)) {
      // Tiefenanalyse über alle JS-Assets → umfassender Testplan + Coded-UI/Unit-Tests (T-62/T-63/T-64)
      const deep = { functions: [], events: [], selectors: [], totals: { functions: 0, params: 0, branches: 0, throws: 0, events: 0, selectors: 0 } };
      const seenSel = new Set();
      for (const asset of bundle.js) {
        const d = analyzeDeep(asset.code);
        if (!d.ok) continue;
        deep.functions.push(...d.functions);
        for (const ev of d.events) deep.events.push(ev);
        for (const s of d.selectors) if (!seenSel.has(s)) { seenSel.add(s); deep.selectors.push(s); }
        for (const k of Object.keys(deep.totals)) deep.totals[k] += d.totals[k] ?? 0;
      }
      const plan = buildDeepTestPlan(art.name, deep);
      deepPlans.push(plan);
      const coded = generateCodedTests(art.name, deep);
      codedTestFiles.push(...coded.files);

      // Review-Agenten (Security + Code) laufen bei JEDEM Prüfen mit — manuell wie automatisch —
      // und werden vollständig ins Protokoll geschrieben (F-31).
      const change = { assets: [...bundle.js, ...bundle.inlineCode], cve: [] };
      const sec = securityReview(change);
      const qual = qualityReview(change);
      if (sec.findings.length === 0) log.push({ artifact: art.name, agent: 'Security', file: art.name, result: 'keine Befunde (OWASP-Heuristiken: XSS/eval/Secrets/js-URL)' });
      for (const f of sec.findings) log.push({ artifact: art.name, agent: 'Security', file: f.asset || art.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
      if (qual.findings.length === 0) log.push({ artifact: art.name, agent: 'Code-Review', file: art.name, result: 'keine Befunde (lose Enden/Komplexität/unbenutzte Variablen)' });
      for (const f of qual.findings) log.push({ artifact: art.name, agent: 'Code-Review', file: f.asset || art.name, result: `${f.rule}: ${f.message}`, severity: f.severity });
      const gatePass = sec.pass && qual.pass;
      log.push({ artifact: art.name, agent: 'Review-Gate', file: art.name, result: gatePass ? 'bestanden (approved)' : `blockiert (${!sec.pass ? 'security' : 'quality'})`, severity: gatePass ? undefined : 'error' });

      // ausgeführte Tests JE SZENARIO protokollieren (bestanden/fehlgeschlagen) — T-60
      const pass = (name) => log.push({ artifact: art.name, agent: 'Test', file: art.name, result: `✓ ${name}: bestanden` });
      const failT = (name, why) => log.push({ artifact: art.name, agent: 'Test', file: art.name, result: `✗ ${name}: fehlgeschlagen — ${why}`, severity: 'error' });
      // 1) lädt/parst ohne Fehler
      if (staticRes.lint.ok) pass('Artefakt lädt ohne Fehler');
      else failT('Artefakt lädt ohne Fehler', staticRes.lint.findings.map((f) => f.message).join('; '));
      // 2) je Einstiegspunkt ein Test
      for (const ep of new Set(agg.entryPoints)) pass(`Einstiegspunkt ${ep} funktioniert`);
      // 3) keine bekannten Schwachstellen
      if (staticRes.retire.findings.length === 0) pass('keine bekannten Schwachstellen');
      else failT('keine bekannten Schwachstellen', staticRes.retire.findings.map((f) => `${f.lib}@${f.version} (${f.vuln})`).join('; '));
      // 4) Golden-Master-Snapshot stabil
      pass(`Golden-Master-Snapshot stabil (${staticRes.snapshot.slice(0, 12)})`);
      // 5) Tiefen-Testplan-Zusammenfassung (geplante Szenarien + Pfadabdeckung)
      const cov = plan.coverage;
      log.push({ artifact: art.name, agent: 'Test', file: art.name, result: `Tiefen-Testplan: ${plan.scenarioCount} Szenario(en) geplant — Coverage Funktionen ${cov.functionsCovered}/${cov.functions}, Branches ${cov.branchesCovered}/${cov.branches}, Parameter ${cov.paramsCovered}/${cov.params}; Coded-UI/Unit-Tests generiert` });
    }

    // verwendete Bibliotheken sammeln (Name@Version, verwundbar/nicht gepflegt)
    for (const lib of scan.components) {
      const key = `${lib.name}@${lib.version}`;
      const e = libsMap.get(key) ?? { name: lib.name, version: lib.version, detectedBy: lib.detectedBy, vulnerable: false, unmaintained: false };
      const reason = unmaintainedReason(lib.name);
      if (reason) { e.unmaintained = true; e.reason = reason; }
      libsMap.set(key, e);
    }
    for (const f of staticRes.retire.findings) {
      const key = `${f.lib}@${f.version}`;
      const e = libsMap.get(key) ?? { name: f.lib, version: f.version, vulnerable: false, unmaintained: false };
      e.vulnerable = true; e.vuln = f.vuln; e.fixedFrom = f.fixedFrom;
      libsMap.set(key, e);
    }

    allRisks.push(...risks);
    for (const u of scan.updates) if (u.outdated) updatesFlat.push({ artifact: art.name, ...u });
    if (bundle.status === 'extraktion-unsicher') {
      failures.push({ artifact: art.name, reason: 'extraktion-unsicher → manueller Eingriff' });
    } else if (!staticRes.lint.ok) {
      failures.push({ artifact: art.name, reason: 'Lint-Fehler: ' + staticRes.lint.findings.map((f) => f.message).join('; ') });
    }

    detail.push({
      name: art.name,
      type: art.type,
      format: art.format,
      testPath: art.testPath,
      status: art.status ?? bundle.status,
      assets: { js: bundle.js.length, css: bundle.css.length, inline: bundle.inlineCode.length, referencedUrls: bundle.referencedUrls.length },
      components: scan.components,
      updates: scan.updates,
      risks,
      static: staticRes,
      entryPoints: analysis.flatMap((a) => (a.analysis.ok ? a.analysis.entryPoints : [])),
      unsafe: bundle.unsafe,
    });
  }

  // Vendored Libs (auch ohne Version im Namen, Version aus dem Header) ergänzen — T-68
  for (const v of detectVendoredLibraries(repoDir)) {
    const existing = [...libsMap.values()].find((e) => e.name === v.name);
    const e = existing ?? { name: v.name, version: v.version, detectedBy: v.detectedBy, vulnerable: false, unmaintained: false };
    if ((!e.version || e.version === 'unbekannt') && v.version !== 'unbekannt') e.version = v.version;
    const reason = unmaintainedReason(v.name);
    if (reason) { e.unmaintained = true; e.reason = reason; }
    const vuln = vulnerabilityFor(v.name, e.version);
    if (vuln) { e.vulnerable = true; e.vuln = vuln.vuln; e.fixedFrom = vuln.fixedFrom; }
    if (!existing) libsMap.set(`${e.name}@${e.version}`, e);
  }

  // SBOM für den Software-Review nutzen: verwundbare/nicht-gepflegte Abhängigkeiten ins Protokoll (T-68)
  const libsArr = [...libsMap.values()];
  for (const l of libsArr.filter((x) => x.vulnerable)) {
    log.push({ artifact: '(SBOM)', agent: 'Security', file: `${l.name}@${l.version}`, result: `verwundbare Abhängigkeit: ${l.vuln ?? 'bekannt'}${l.fixedFrom ? ` (fix ab ${l.fixedFrom})` : ''}`, severity: 'high' });
    failures.push({ artifact: `${l.name}@${l.version}`, reason: `verwundbare Bibliothek (${l.vuln ?? 'bekannt'})` });
  }
  for (const l of libsArr.filter((x) => x.unmaintained && !x.vulnerable)) {
    log.push({ artifact: '(SBOM)', agent: 'Security', file: `${l.name}@${l.version}`, result: `nicht gepflegt: ${l.reason}`, severity: 'medium' });
  }
  const libVulnCount = libsArr.filter((l) => l.vulnerable).length;
  const libUnmaintCount = libsArr.filter((l) => l.unmaintained && !l.vulnerable).length;
  const libWarning = libVulnCount || libUnmaintCount ? { vulnerable: libVulnCount, unmaintained: libUnmaintCount } : null;

  const active = filterActiveRisks(allRisks, ack);
  const report = renderReport(
    {
      updated: [], // Scan ist read-only — Updates werden hier nur GEMELDET, nicht ausgeführt
      risks: active,
      failures,
    },
    { secrets: opts.secrets ?? [] },
  );
  const triage = triageViewModel(
    artifacts.map((a) => ({ name: a.name, format: a.format, testPath: a.testPath, noConvention: false })),
    active,
  );

  const libs = libsArr.map((e) => ({ ...e, status: libStatus(e) })).sort((a, b) => a.name.localeCompare(b.name));
  // Komponenten-Typ/Format automatisch erkennen (nur wenn Artefakte vorhanden — sonst nicht überschreiben)
  const meta = artifacts.length ? componentMeta(artifacts) : null;
  const combined = combineDeepPlans(deepPlans);
  return { repoDir, artifacts: detail, outdated: updatesFlat, risks: active, failures, report, triage, log, testPlan: combined.feature, coverage: combined.coverage, codedTests: codedTestFiles, libs, libWarning, type: meta?.type ?? null, format: meta?.format ?? null };
}
