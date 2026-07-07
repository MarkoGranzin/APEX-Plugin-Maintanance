/**
 * T-146 (Schicht 3) — KI-Fallback für die Versions-Identifikation: wenn deterministische Banner-Erkennung
 * UND zeitliche Korrelation eine Lib-Version nicht klären, schlägt die Analyse-KI aus dem Datei-Kopf/Banner
 * Paketname + Version vor. ENTSCHEIDEND (Nutzer-Vorgabe „suchen UND validieren"): der KI-Vorschlag wird
 * NICHT blind übernommen, sondern gegen die npm-Registry validiert — nur wenn die vorgeschlagene Version
 * für das Paket wirklich existiert, wird sie übernommen (detectedBy='ai-validated'). Alles injizierbar.
 *
 * Resultat: src/service/ai-version-resolve.js
 */

import { fetchNpmInfo } from '../sbom/registry.js';

const PROMPT = (name, head) => `You identify a bundled/minified JavaScript library and its EXACT released version from its header/banner. Answer ONLY with strict JSON, no prose.
Format: {"package":"<exact npm package name or null>","version":"<x.y.z or null>"}
If you are not confident, use null. Do not invent versions.
File name hint: ${name}
Header/banner (first bytes):
${String(head || '').slice(0, 1400)}`;

/**
 * Klärt EINE Lib per KI + Registry-Validierung. Gibt {version, package, detectedBy} zurück oder null.
 * @param {{name:string, evidenceHead?:string}} lib
 * @param {{ai?:object, fetchInfo?:Function, fetch?:Function}} deps  ai.complete(prompt)->string; ai.kind
 */
export async function resolveVersionWithAi(lib, deps = {}) {
  const ai = deps.ai;
  if (!ai || ai.kind === 'stub' || typeof ai.complete !== 'function') return null; // ohne echtes Backend kein Raten
  if (!lib || !lib.evidenceHead) return null;
  const fetchInfo = deps.fetchInfo ?? fetchNpmInfo;

  let out;
  try { out = await ai.complete(PROMPT(lib.name, lib.evidenceHead), { maxTokens: 120 }); } catch { return null; }
  const m = String(out ?? '').match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const version = parsed && parsed.version;
  if (!version || !/^\d+\.\d+(\.\d+)?$/.test(String(version))) return null;

  // VALIDIEREN: existiert diese Version für das (vorgeschlagene) Paket wirklich?
  try {
    const info = await fetchInfo(parsed.package || lib.name, deps);
    if (info && info.time && info.time[version]) {
      return { version: String(version), package: info.name, detectedBy: 'ai-validated' };
    }
  } catch { /* Paket/Netz unklar → nicht übernehmen */ }
  return null; // nicht validiert → kein blindes KI-Ergebnis übernehmen
}

/**
 * Klärt alle noch unbekannten Libs einer Liste per KI-Fallback (nur die mit evidenceHead). Mutiert nicht;
 * gibt die Anzahl geklärter Libs zurück und ruft onResolved(lib, result) je Treffer. */
export async function resolveUnknownVersionsWithAi(libs, deps = {}, onResolved) {
  let n = 0;
  for (const lib of libs ?? []) {
    if (lib && (!lib.version || lib.version === 'unbekannt') && lib.evidenceHead) {
      const r = await resolveVersionWithAi(lib, deps);
      if (r) { if (onResolved) onResolved(lib, r); n++; }
    }
  }
  return n;
}
