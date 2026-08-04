/**
 * Ersatz für UNMAINTAINED Bibliotheken: statt nur zu warnen, schlägt die Software einen gepflegten,
 * PERMISSIV lizenzierten (kommerziell nutzbar, pflichtenarm) Nachfolger vor — oder, wenn es keinen gibt,
 * einen selbst gebauten Minimal-Ersatz (MIT, nur die genutzte Funktionalität).
 *
 * Lizenz-Leitplanke: nur Nachfolger mit commercialOk und ohne Copyleft werden automatisch vorgeschlagen.
 * obligations 'none' (MIT/ISC/…) bevorzugt; 'attribution' (Apache/BSD) erlaubt, aber markiert; 'copyleft'/'unknown' → kein Auto-Ersatz.
 *
 * Resultat: src/service/lib-replace.js
 */

import { classifyLicense } from '../sbom/licenses.js';

/**
 * Bekannte gepflegte Nachfolger für unmaintained Libs (Name → Ersatz).
 * to: Paket/Lib-Name · license: SPDX des Nachfolgers · cdn: offizielles Browser-Bundle (für realen Lib-Load) ·
 * note: API-Migrationshinweis für den KI-Agenten · runtime: false = Build-/Test-Tooling (kein Laufzeit-Swap im Mock) ·
 * equivalent: true = macht funktional DASSELBE, nur etwas anders (Adapter genügt; T-164-Regel).
 */
export const REPLACEMENTS = {
  moment: { to: 'dayjs', license: 'MIT', equivalent: true, cdn: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js', note: 'dayjs has a moment-like, immutable API: dayjs(input).format(...), .add()/.subtract(). For non-ISO parsing, load the CustomParseFormat plugin.', runtime: true },
  momentjs: { to: 'dayjs', license: 'MIT', equivalent: true, cdn: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js', note: 'dayjs has a moment-like, immutable API: dayjs(input).format(...). For non-ISO parsing, load the CustomParseFormat plugin.', runtime: true },
  mxgraph: { to: '@maxgraph/core', license: 'Apache-2.0', equivalent: true, cdn: 'https://cdn.jsdelivr.net/npm/@maxgraph/core/dist/maxgraph.umd.min.js', note: 'maxGraph is the official successor to mxGraph (same architecture). mx* classes → @maxgraph/core exports (e.g. mxGraph→Graph, mxClient→…).', runtime: true },
  mxclient: { to: '@maxgraph/core', license: 'Apache-2.0', equivalent: true, cdn: 'https://cdn.jsdelivr.net/npm/@maxgraph/core/dist/maxgraph.umd.min.js', note: 'mxClient → @maxgraph/core (official successor).', runtime: true },
  jsonpath: { to: 'jsonpath-plus', license: 'MIT', equivalent: true, cdn: 'https://cdn.jsdelivr.net/npm/jsonpath-plus/dist/index-browser-umd.cjs', note: 'jsonpath-plus: JSONPath({ path, json }) instead of jsonpath.query(json, path). Near drop-in.', runtime: true },
  request: { to: 'node-fetch', license: 'MIT', equivalent: true, cdn: null, note: 'In the browser use native fetch(); in Node use node-fetch. request(opts,cb) → fetch(url,opts).then(r=>r.json()).', runtime: true },
  protractor: { to: 'playwright', license: 'Apache-2.0', equivalent: true, cdn: null, note: 'E2E test runner — migrate specs to @playwright/test (no runtime swap).', runtime: false },
};

/**
 * T-164-Regel — liefert einen Ersatzvorschlag NUR, wenn der Nachfolger als ALTERNATIVE zulässig ist:
 * kommerziell frei UND PFLICHTENFREI (obligations 'none' — Attribution ist bereits eine Pflicht!) UND
 * funktional gleichwertig (equivalent). Dann genügt ein ADAPTER (alte API-Oberfläche bereitstellen,
 * Plugin-Code unangetastet). Alles andere → null = Interface-basierter Neubau (self-build/rewrite).
 * @param {string} name @param {{classify?:Function}} [deps]
 * @returns {null|{from,to,license,licenseInfo,cdn,note,runtime,attribution:false,strategy:'replace',approach:'adapter'}}
 */
export function suggestReplacement(name, deps = {}) {
  const classify = deps.classify ?? classifyLicense;
  const e = REPLACEMENTS[String(name || '').toLowerCase()];
  if (!e) return null;
  const licenseInfo = classify(e.license);
  if (!licenseInfo.commercialOk || licenseInfo.obligations !== 'none' || e.equivalent !== true) return null;
  return { from: name, to: e.to, license: e.license, licenseInfo, cdn: e.cdn ?? null, note: e.note, runtime: e.runtime !== false, attribution: false, strategy: 'replace', approach: 'adapter' };
}

/**
 * T-163 — Zustimmungs-Tor für den Ersatz/Nachbau UNMAINTAINED Libs. Der Austausch einer nicht mehr
 * gepflegten Lib (permissiver Nachfolger ODER MIT-Self-Build, beide interface-erhaltend) ist ein großer,
 * riskanter Eingriff und darf NICHT still im Full-/geplanten Lauf passieren — er braucht eine explizite
 * Extra-Zustimmung (Approve-Aktion pro Lauf ODER Opt-in-Setting). Reine Funktion: bewertet die migrate-
 * Schritte eines Laufs und meldet, ob (und wofür) Zustimmung fehlt. Sichere Updates/Major-Only-Migrationen
 * (ohne `replace`) fallen NICHT unter das Tor.
 * @param {Array<{step?:string,replace?:boolean,name?:string,to?:string|null,strategy?:string,reason?:string}>} migrateSteps
 * @param {{consent?:boolean}} [opts] consent = Extra-Zustimmung erteilt (Approve/Setting)
 * @returns {{needsConsent:boolean, proposals:Array<{lib:string,to:string|null,strategy:'replace'|'self-build',interfacePreserving:true,reason?:string}>}}
 */
export function replaceConsentGate(migrateSteps, opts = {}) {
  const proposals = (migrateSteps ?? [])
    .filter((s) => s && s.step === 'migrate' && s.replace)
    .map((s) => ({ lib: s.name, to: s.to ?? null, strategy: s.to ? 'replace' : 'self-build', interfacePreserving: true, reason: s.reason }));
  return { needsConsent: proposals.length > 0 && !opts.consent, proposals };
}

/**
 * Ersatz-Plan für eine erkannte Lib-Liste: je unmaintained Lib entweder ein permissiver Nachfolger
 * (strategy 'replace') oder, wenn keiner bekannt ist, ein Self-Build-Hinweis (strategy 'self-build').
 * @param {Array<{name:string,version?:string,unmaintained?:boolean,status?:string}>} libs @param {{classify?:Function}} [deps]
 */
export function planReplacements(libs, deps = {}) {
  const out = [];
  for (const l of libs ?? []) {
    const isUnmaint = l.unmaintained || l.status === 'nicht gepflegt';
    if (!isUnmaint) continue;
    const rep = suggestReplacement(l.name, deps);
    if (rep) out.push({ ...rep, version: l.version });
    else {
      // T-164: bekannter Nachfolger existiert, ist aber NICHT pflichtenfrei/gleichwertig → ehrlich benennen,
      // warum der Adapter-Pfad nicht offensteht; der Weg ist der Interface-basierte Neubau (rewrite).
      const known = REPLACEMENTS[String(l.name || '').toLowerCase()];
      const rejected = known ? { to: known.to, license: known.license } : null;
      out.push({
        from: l.name, to: null, strategy: 'self-build', approach: 'rewrite', version: l.version, rejected,
        note: rejected
          ? `Known successor ${rejected.to} (${rejected.license}) is not obligation-free → re-implement the used interface yourself (MIT), verified against the acceptance contract.`
          : 'No known obligation-free, equivalent successor — re-implement the used interface yourself (MIT), verified against the acceptance contract.',
      });
    }
  }
  return out;
}
