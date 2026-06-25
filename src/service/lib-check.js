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
import { fetchNpmInfo } from '../sbom/registry.js';

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
  for (const lib of libs ?? []) {
    const e = { ...lib };
    try {
      const info = await fetchInfo(lib.name, deps);
      e.latest = info.latest ?? null;
      e.releasedAt = info.releasedAt ?? null;
      e.source = info.links?.source ?? null; // Quelle (z.B. GitHub)
      e.homepage = info.links?.homepage ?? null;
      e.npm = info.links?.npm ?? null;
      e.ageDays = info.releasedAt ? Math.max(0, Math.floor((now() - Date.parse(info.releasedAt)) / DAY)) : null;
      const instTime = info.time?.[lib.version];
      e.installedReleasedAt = instTime ?? null;
      e.installedAgeDays = instTime ? Math.max(0, Math.floor((now() - Date.parse(instTime)) / DAY)) : null;
      e.outdated = !!(info.latest && lib.version && lib.version !== 'unbekannt' && info.latest !== lib.version);
      e.webStatus = e.outdated ? 'veraltet' : info.latest ? 'aktuell' : 'unbekannt';
      e.status = libStatus(e); // Gesamtstatus konsistent halten
    } catch (err) {
      e.webStatus = 'unbekannt';
      e.webError = String(err?.message ?? err);
    }
    out.push(e);
  }
  return out;
}
