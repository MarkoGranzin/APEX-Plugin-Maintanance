/**
 * F-23 (T-46) — Bibliotheks-Übersicht: über alle Komponenten aggregieren.
 *
 * Scannt die zugeordneten Repos und fasst die verwendeten Bibliotheken zusammen: Version,
 * „verwendet von" welchen Plugins, sowie Status: verwundbar (retire.js), nicht gepflegt
 * (EOL-Liste), veraltet (Update verfügbar) oder aktuell. Setzt je Komponente ein libWarning
 * {vulnerable, unmaintained} im Store (für das Warn-Badge in der Plugin-Übersicht).
 *
 * Resultat: src/service/libraries.js
 */

import { scanRepo } from './run-repo.js';
import { unmaintainedReason } from '../test/static.js';
import { libStatus as STATUS, libWarningFrom } from './lib-check.js';

/**
 * @param {object} store
 * @param {object} [opts] scan (default scanRepo), persist (default true → schreibt libWarning)
 * @returns {{libraries:object[]}}
 */
export function collectLibraries(store, opts = {}) {
  const scan = opts.scan ?? scanRepo;
  const persist = opts.persist !== false;
  const libs = new Map(); // name@version -> entry

  const upsert = (name, version) => {
    const key = `${name}@${version}`;
    let e = libs.get(key);
    if (!e) {
      e = { name, version, usedBy: new Set(), vulnerable: false, unmaintained: false, outdated: false };
      libs.set(key, e);
    }
    return e;
  };

  for (const comp of store.list()) {
    if (!comp.path) {
      if (persist) store.update(comp.id, { libWarning: null });
      continue;
    }

    // Bevorzugt die bereits ermittelten, web-angereicherten Libs der Komponente (inkl. vendored +
    // Outdated aus dem Web-Check). Nur wenn noch keine vorliegen, als Fallback frisch scannen.
    // libWarning IMMER über libWarningFrom (eine Quelle) — sonst Drift (outdated/unknown fehlen).
    const stored = comp.libs ?? [];
    if (stored.length) {
      for (const lib of stored) {
        const e = upsert(lib.name, lib.version);
        e.usedBy.add(comp.name);
        if (lib.vulnerable || lib.status === 'verwundbar') { e.vulnerable = true; if (lib.vuln) e.vuln = lib.vuln; if (lib.fixedFrom) e.fixedFrom = lib.fixedFrom; }
        if (lib.unmaintained || lib.status === 'nicht gepflegt') { e.unmaintained = true; if (lib.reason) e.reason = lib.reason; }
        if (lib.outdated || lib.webStatus === 'veraltet') { e.outdated = true; if (lib.latest) e.latest = lib.latest; }
        if (lib.source && !e.source) e.source = lib.source;
        if (lib.npm && !e.npm) e.npm = lib.npm;
        if (lib.ageDays != null && e.ageDays == null) e.ageDays = lib.ageDays;
      }
      if (persist) store.update(comp.id, { libWarning: libWarningFrom(stored) });
      continue;
    }

    const compLibs = []; // diese Komponente, für eine konsistente libWarning-Ableitung
    let res;
    try {
      res = scan(comp.path);
    } catch {
      continue;
    }
    for (const art of res.artifacts ?? []) {
      for (const lib of art.components ?? []) {
        const e = upsert(lib.name, lib.version);
        e.usedBy.add(comp.name);
        const reason = unmaintainedReason(lib.name);
        if (reason) { e.unmaintained = true; e.reason = reason; }
        compLibs.push({ name: lib.name, version: lib.version, unmaintained: !!reason });
      }
      for (const f of art.static?.retire?.findings ?? []) {
        const e = upsert(f.lib, f.version);
        e.usedBy.add(comp.name);
        e.vulnerable = true; e.vuln = f.vuln; e.fixedFrom = f.fixedFrom;
        compLibs.push({ name: f.lib, version: f.version, vulnerable: true });
      }
      for (const u of art.updates ?? []) {
        if (u.outdated) {
          const e = upsert(u.name, u.current);
          e.usedBy.add(comp.name);
          e.outdated = true; e.latest = u.latest;
          compLibs.push({ name: u.name, version: u.current, outdated: true });
        }
      }
    }

    if (persist) store.update(comp.id, { libWarning: libWarningFrom(compLibs) });
  }

  const libraries = [...libs.values()]
    .map((e) => ({ ...e, usedBy: [...e.usedBy], status: STATUS(e) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  return { libraries };
}
