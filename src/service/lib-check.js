/**
 * T-59 — Bibliotheks-Erkennung + Web-Aktualitätsprüfung.
 *
 *  - libraryFiles(dir): welche DATEIEN im Repo sind Fremd-Bibliotheken (vendored)?
 *  - checkLibrariesOnline(libs): reichert die erkannten Libs (Name@Version) aus dem Web (npm) an:
 *    neueste Version, Release-Datum, Alter in Tagen, outdated-Status. Netzfehler je Lib werden
 *    abgefangen → Status „unbekannt", der Lauf bricht NICHT ab.
 *
 * Resultat: src/service/lib-check.js
 */

import fs from 'node:fs';
import { listFiles } from '../inventory/inventory.js';
import { isLibraryFile } from '../inventory/format.js';
import { fetchNpmInfo, versionAtDate } from '../sbom/registry.js';
import { resolveVersionWithAi } from './ai-version-resolve.js';
import { classifyLicense, licenseChange } from '../sbom/licenses.js';

const DAY = 86400000;

/** Zählt die Lib-Probleme einer Komponente (für libWarning/Status). null, wenn alles sauber. */
export function libWarningFrom(libs) {
  const isVuln = (l) => l.vulnerable || l.status === 'verwundbar';
  const isUnmaint = (l) => l.unmaintained || l.status === 'nicht gepflegt';
  const isOutdated = (l) => l.outdated || l.status === 'veraltet';
  const isUnknown = (l) => !l.version || l.version === 'unbekannt';
  const vulnerable = (libs ?? []).filter(isVuln).length;
  const unmaintained = (libs ?? []).filter((l) => isUnmaint(l) && !isVuln(l)).length;
  const outdated = (libs ?? []).filter((l) => isOutdated(l) && !isVuln(l) && !isUnmaint(l)).length;
  const unknown = (libs ?? []).filter((l) => isUnknown(l) && !isVuln(l) && !isUnmaint(l) && !isOutdated(l)).length;
  return vulnerable || unmaintained || outdated || unknown ? { vulnerable, unmaintained, outdated, unknown } : null;
}

/** Einheitliche Status-Ableitung: verwundbar > nicht gepflegt > veraltet > unbekannt > aktuell. */
export function libStatus(e) {
  if (e.vulnerable || e.status === 'verwundbar') return 'verwundbar';
  if (e.unmaintained || e.status === 'nicht gepflegt') return 'nicht gepflegt';
  if (e.outdated || e.webStatus === 'veraltet') return 'veraltet';
  if (!e.version || e.version === 'unbekannt') return 'unbekannt';
  return 'aktuell';
}

/** Listet die Bibliotheks-Dateien eines ausgecheckten Repos. */
export function libraryFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return listFiles(dir).filter(isLibraryFile);
}

/**
 * Reichert erkannte Libs aus dem Web an.
 * @param {Array<{name:string,version:string,status?:string}>} libs
 * @param {{fetchInfo?:Function, fetch?:Function, now?:Function}} [deps]
 * @returns {Promise<Array>} libs + {latest, releasedAt, ageDays, installedAgeDays, outdated, webStatus, webError?}
 */
export async function checkLibrariesOnline(libs, deps = {}) {
  const fetchInfo = deps.fetchInfo ?? fetchNpmInfo;
  const now = deps.now ?? (() => Date.now());
  const out = [];
  const timeByIdx = new Map(); // idx → npm-time-Map, für die Datums-Inferenz unbekannter Versionen (T-146)
  for (const lib of libs ?? []) {
    const e = { ...lib };
    try {
      const info = await fetchInfo(lib.name, deps);
      if (!(lib.version && lib.version !== 'unbekannt')) timeByIdx.set(out.length, info.time || {});
      e.latest = info.latest ?? null;
      e.releasedAt = info.releasedAt ?? null;
      e.source = info.links?.source ?? null; // Quelle (z.B. GitHub)
      e.homepage = info.links?.homepage ?? null;
      e.npm = info.links?.npm ?? null;
      e.ageDays = info.releasedAt ? Math.max(0, Math.floor((now() - Date.parse(info.releasedAt)) / DAY)) : null;
      const instTime = info.time?.[lib.version];
      e.installedReleasedAt = instTime ?? null;
      e.installedAgeDays = instTime ? Math.max(0, Math.floor((now() - Date.parse(instTime)) / DAY)) : null;
      const knownVersion = !!(lib.version && lib.version !== 'unbekannt');
      e.outdated = !!(info.latest && knownVersion && info.latest !== lib.version);
      // Unbekannte installierte Version ist NICHT „aktuell" — auch wenn latest bekannt ist (B-5-Klasse)
      e.webStatus = e.outdated ? 'veraltet' : (knownVersion && info.latest) ? 'aktuell' : 'unbekannt';
      if (info.license != null) e.license = info.license; // Lizenz aus der Registry (T-95)
      e.licenseInfo = classifyLicense(e.license); // kommerziell ok? Pflichten?
      // T-156: Lizenzwechsel installiert→latest erkennen (rechtlich wichtig). Nur bei bekannter installierter
      // Version UND vorliegender Lizenz beider Versionen; riskier=true, wenn die Lizenzklasse schlechter wird.
      const fromLic = knownVersion ? info.licenseByVersion?.[lib.version] : null;
      if (fromLic && info.license) { const chg = licenseChange(fromLic, info.license); if (chg) e.licenseChange = chg; }
      e.status = libStatus(e); // Gesamtstatus konsistent halten
    } catch (err) {
      e.webStatus = 'unbekannt';
      e.webError = String(err?.message ?? err);
    }
    out.push(e);
  }
  // T-146 — zeitliche Korrelation für Libs mit unbekannter Version: Referenzdatum = jüngstes Release-Datum
  // der Libs mit BEKANNTER Version (Untergrenze der Bündel-Bauzeit; die gebündelten Files stammen aus
  // derselben Zeit), optional per deps.buildDate übersteuert (z.B. Plugin-Datum aus apexplugin.json).
  // Daraus die Version ableiten, die zu diesem Zeitpunkt aktuell war — transparent als „inferred" markiert.
  const knownDates = out.map((e) => e.installedReleasedAt).filter(Boolean).map((d) => Date.parse(d)).filter((n) => !Number.isNaN(n));
  const refIso = deps.buildDate || (knownDates.length ? new Date(Math.max(...knownDates)).toISOString() : null);
  if (refIso) {
    for (const [idx, time] of timeByIdx) {
      const e = out[idx];
      if (e.version && e.version !== 'unbekannt') continue;
      const v = versionAtDate(time, refIso);
      if (!v) continue;
      e.version = v;
      e.versionInferred = true; // NICHT direkt gelesen, sondern aus dem Bau-Zeitpunkt abgeleitet
      e.versionInferredFrom = refIso;
      e.detectedBy = 'inferred-by-date';
      const instTime = time[v];
      e.installedReleasedAt = instTime ?? e.installedReleasedAt;
      e.installedAgeDays = instTime ? Math.max(0, Math.floor((now() - Date.parse(instTime)) / DAY)) : e.installedAgeDays;
      e.outdated = !!(e.latest && e.latest !== v);
      e.webStatus = e.outdated ? 'veraltet' : (e.latest ? 'aktuell' : 'unbekannt');
      e.status = libStatus(e);
    }
  }
  // T-146 (Schicht 3) — KI-Fallback für weiterhin unbekannte Versionen: nur wenn ein echtes Backend
  // konfiguriert ist (deps.ai, kein Stub). Der KI-Vorschlag wird gegen die Registry VALIDIERT übernommen.
  if (deps.ai && deps.ai.kind && deps.ai.kind !== 'stub') {
    for (const e of out) {
      if (e.version && e.version !== 'unbekannt') continue;
      if (!e.evidenceHead) continue;
      const r = await resolveVersionWithAi(e, { ai: deps.ai, fetchInfo, fetch: deps.fetch });
      if (!r) continue;
      e.version = r.version;
      e.detectedBy = r.detectedBy; // 'ai-validated'
      e.versionAiResolved = true;
      e.outdated = !!(e.latest && e.latest !== r.version);
      e.webStatus = e.outdated ? 'veraltet' : (e.latest ? 'aktuell' : 'unbekannt');
      e.status = libStatus(e);
    }
  }
  return out;
}
