/**
 * T-7 — Libs per Fingerprinting erkennen → CycloneDX-SBOM erstellen & gegen aktuelle Version prüfen.
 *
 * APEX-Plugins haben kein Manifest, JS/CSS liegt vendored vor (Wissen #505). Daher: Bibliotheken
 * per Fingerprinting (Hash) erkennen — Header-/Dateinamen-/URL-Heuristik nur als Fallback. Ergebnis
 * je Artefakt als CycloneDX-SBOM = stabile interne API für Update-Check (T-8) UND Risiko-Check (T-16):
 * EIN wöchentlicher Scan, mehrere Auswertungen. PL/SQL-Packages kämen separat über DB-Metadaten.
 *
 * Resultat: src/sbom/sbom.js
 */

import crypto from 'node:crypto';
import { versionFromUrl } from '../extract/extract.js';
import { cmpSemver as cmp } from '../util/version.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Dateiname/Heuristik-basierte Lib-Erkennung (Fallback, bricht bei minify/rename). */
function fromFilename(name) {
  const m = name.match(/^([a-zA-Z][\w.-]*?)[-.@](\d+\.\d+\.\d+)(?:[.-]min)?\.(?:js|css)$/);
  if (m) return { name: m[1].replace(/[.-]$/, ''), version: m[2] };
  return null;
}

/**
 * Erkennt Bibliotheken in einem kanonischen Bündel.
 * @param {import('../extract/extract.js').CanonicalBundle} bundle
 * @param {object} [opts]
 * @param {Record<string,{name:string,version:string}>} [opts.hashDb]  sha256 → Lib
 * @returns {{name:string,version:string,detectedBy:string,evidence:string}[]}
 */
export function fingerprint(bundle, opts = {}) {
  const hashDb = opts.hashDb ?? {};
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const key = `${c.name}@${c.version}`;
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  };

  for (const asset of [...(bundle.js ?? []), ...(bundle.css ?? [])]) {
    const h = sha256(asset.code);
    if (hashDb[h]) {
      add({ ...hashDb[h], detectedBy: 'hash', evidence: asset.name });
      continue;
    }
    const byName = fromFilename(asset.name);
    if (byName) add({ ...byName, detectedBy: 'filename', evidence: asset.name });
  }

  for (const ref of bundle.referencedUrls ?? []) {
    const version = ref.version ?? versionFromUrl(ref.url);
    const name = (ref.url.split('/').pop() || '').replace(/[-.@]?\d.*$/, '').replace(/\.(min\.)?(js|css)$/i, '');
    if (name && version) add({ name, version, detectedBy: 'url', evidence: ref.url });
  }

  return out;
}

/** Baut eine CycloneDX-SBOM (1.5) aus erkannten Komponenten. */
export function buildSbom(artifactName, components) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: { component: { type: 'application', name: artifactName } },
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      purl: `pkg:generic/${c.name}@${c.version}`,
      properties: [
        { name: 'detectedBy', value: c.detectedBy },
        { name: 'evidence', value: c.evidence },
      ],
    })),
  };
}

/**
 * Prüft erkannte Komponenten gegen aktuelle Versionen.
 * @param {{name:string,version:string}[]} components
 * @param {Record<string,string>} latestVersions  name → neueste Version
 * @returns {{name:string,current:string,latest:(string|null),outdated:boolean}[]}
 */
export function checkUpdates(components, latestVersions = {}) {
  return components.map((c) => {
    const latest = latestVersions[c.name] ?? null;
    return {
      name: c.name,
      current: c.version,
      latest,
      outdated: latest != null && cmp(c.version, latest) < 0,
    };
  });
}

/** Komfort: Fingerprint → SBOM → Update-Check in einem Schritt. */
export function scanArtifact(bundle, opts = {}) {
  const components = fingerprint(bundle, opts);
  return {
    sbom: buildSbom(bundle.artifact, components),
    components,
    updates: checkUpdates(components, opts.latestVersions ?? {}),
  };
}
