/**
 * T-23 — Static-First-Hybrid: Lint + retire.js + Characterization-Snapshot je Artefakt;
 *          Verhaltenstests nur für kritische Plugins (Wissen #512).
 *
 * Für uneinheitlichen Fremdcode zahlt sich Static-First besser aus als überall Unit-Tests:
 * JEDES Artefakt bekommt sofort billige statische Prüfungen + einen Golden-Master-Snapshot.
 * NUR als kritisch markierte Artefakte bekommen zusätzlich echte Verhaltenstests
 * (jsdom-A oder Playwright-B über T-22). So skaliert Abdeckung mit dem Bestand.
 *
 * Resultat: src/test/static.js
 */

import crypto from 'node:crypto';
import { analyzeJs } from '../extract/analyze.js';
import { chooseTestEnv } from './testenv.js';
import { versionFromUrl } from '../extract/extract.js';

/** Billiger Lint über den AST: Syntax + ein paar harte Regeln. */
export function lint(bundle) {
  const findings = [];
  for (const asset of bundle.js) {
    const a = analyzeJs(asset.code);
    if (!a.ok) {
      findings.push({ asset: asset.name, rule: 'parse', severity: 'error', message: a.error });
      continue;
    }
    if (/\beval\s*\(/.test(asset.code)) {
      findings.push({ asset: asset.name, rule: 'no-eval', severity: 'warn', message: 'eval() verwendet' });
    }
    if (/\bwith\s*\(/.test(asset.code)) {
      findings.push({ asset: asset.name, rule: 'no-with', severity: 'warn', message: 'with-Statement verwendet' });
    }
  }
  return { ok: findings.every((f) => f.severity !== 'error'), findings };
}

const cmpVersion = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const libNameFromUrl = (url) =>
  (url.split('/').pop() || '').replace(/[-.]?\d+\.\d+\.\d+.*$/, '').replace(/\.(min\.)?(js|css)$/i, '') ||
  null;

/**
 * retire.js-artige Schwachstellenprüfung auf referenzierten Libs.
 * @param {import('../extract/extract.js').CanonicalBundle} bundle
 * @param {object} [opts]
 * @param {Record<string,{below:string,id:string,severity?:string}[]>} [opts.vulnDb]
 */
export function retireCheck(bundle, opts = {}) {
  const db = opts.vulnDb ?? DEFAULT_VULN_DB;
  const findings = [];
  for (const ref of bundle.referencedUrls ?? []) {
    const name = libNameFromUrl(ref.url);
    const version = ref.version ?? versionFromUrl(ref.url);
    if (!name || !version || !db[name]) continue;
    for (const v of db[name]) {
      if (cmpVersion(version, v.below) < 0) {
        findings.push({ lib: name, version, vuln: v.id, severity: v.severity ?? 'medium', fixedFrom: v.below });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

// Minimaler eingebauter Datensatz; das vollständige SBOM-Fingerprinting kommt in T-7 (Slice 24).
export const DEFAULT_VULN_DB = {
  jquery: [{ below: '3.5.0', id: 'CVE-2020-11022', severity: 'medium' }],
  'chart': [{ below: '2.9.4', id: 'GHSA-chart-proto', severity: 'low' }],
};

/** Bekannte Schwachstelle für name@version (oder null) — auch für vendored Libs nutzbar (T-68). */
export function vulnerabilityFor(name, version, db = DEFAULT_VULN_DB) {
  const entries = db[String(name ?? '').toLowerCase()];
  if (!entries || !version) return null;
  for (const v of entries) {
    if (cmpVersion(version, v.below) < 0) return { vuln: v.id, severity: v.severity ?? 'medium', fixedFrom: v.below };
  }
  return null;
}

/**
 * Bekannte nicht mehr gepflegte / EOL-Bibliotheken (heuristische Liste; voller Score via T-16/
 * externe Signale). name (lowercase) → Grund.
 */
export const DEFAULT_UNMAINTAINED = {
  angular: 'AngularJS (1.x) — EOL seit Jan 2022, nicht mehr gepflegt',
  angularjs: 'AngularJS (1.x) — EOL seit Jan 2022, nicht mehr gepflegt',
  'jquery-migrate': 'jQuery Migrate — nur Übergangshilfe, langfristig entfernen',
  bower: 'Bower — eingestellt, durch npm/yarn ersetzen',
  moment: 'Moment.js — im Maintenance-Mode, Nachfolger empfohlen',
  momentjs: 'Moment.js — im Maintenance-Mode, Nachfolger empfohlen',
  mxgraph: 'mxGraph — 2020 eingestellt/archiviert (kein Support, keine Sicherheitsfixes), Migration zu maxGraph empfohlen',
  mxclient: 'mxGraph (mxClient) — 2020 eingestellt/archiviert, Migration zu maxGraph empfohlen',
  flash: 'Adobe Flash — End-of-Life seit 2020, nicht mehr nutzbar/sicher',
  yui: 'YUI — von Yahoo eingestellt, nicht mehr gepflegt',
  protractor: 'Protractor — eingestellt (E2E), zu Playwright/Cypress migrieren',
};

/** Unmaintained-Grund für einen Lib-Namen oder null. */
export function unmaintainedReason(name, db = DEFAULT_UNMAINTAINED) {
  if (!name) return null;
  return db[String(name).toLowerCase()] ?? null;
}

/** Golden-Master-Snapshot: stabiler Hash über die normalisierten Assets. */
export function makeSnapshot(bundle) {
  const norm = (arr) =>
    [...arr]
      .map((x) => ({ name: x.name, code: x.code.replace(/\r\n/g, '\n').trimEnd() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const payload = JSON.stringify({ js: norm(bundle.js), css: norm(bundle.css) });
  return { hash: crypto.createHash('sha256').update(payload).digest('hex'), at: null };
}

/** Vergleicht einen früheren Snapshot mit dem aktuellen Bündel (Charakterisierung). */
export function compareSnapshot(previousHash, bundle) {
  const cur = makeSnapshot(bundle).hash;
  return { changed: previousHash !== cur, hash: cur, baseline: previousHash == null };
}

/**
 * Plant die Tests eines Artefakts: Static-First IMMER + Verhaltenstests IMMER.
 * Es wird stets alles getestet (damit das Plugin wie zuvor funktioniert) — kein „kritisch"-Schalter mehr.
 * @param {object} artifactBundle  kanonisches Bündel (+ optional .analysis je js)
 */
export function planArtifactTests(bundle) {
  const staticSteps = ['lint', 'retire', 'snapshot'];
  const plan = { artifact: bundle.artifact, static: staticSteps, behavior: [] };

  for (const asset of bundle.js) {
    const analysis = analyzeJs(asset.code);
    if (analysis.ok) {
      plan.behavior.push({ asset: asset.name, ...chooseTestEnv(analysis) });
    }
  }
  return plan;
}
