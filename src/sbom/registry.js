/**
 * T-59 — Web-Lookup für Bibliotheks-Aktualität gegen die npm-Registry.
 *
 * Liefert je Paket die neueste Version + Release-Zeitpunkte (registry.npmjs.org liefert im
 * Volldokument ein `time`-Objekt: Version → ISO-Datum). fetch ist injizierbar → deterministisch
 * testbar (Stub) und live (globales fetch, Node ≥ 18). Netzfehler werden als Exception nach oben
 * gereicht; der Aufrufer (lib-check) fängt sie ab und markiert die Lib als „unbekannt".
 *
 * Resultat: src/sbom/registry.js
 */

// Bekannte Alias-Zuordnungen erkannter Lib-/Datei-Name → npm-Paketname (nur wo abweichend). Das ist
// Paket-IDENTITÄT (Domänenwissen), keine Versions-Hardcodierung. Für alles Übrige greift die generische
// Normalisierung + der Kandidaten-Fallback in fetchNpmInfo.
const NPM_NAME = {
  jquery: 'jquery',
  'jquery-migrate': 'jquery-migrate',
  bootstrap: 'bootstrap',
  moment: 'moment',
  lodash: 'lodash',
  d3: 'd3',
  chart: 'chart.js',
  'chart.js': 'chart.js',
  angular: 'angular',
  angularjs: 'angular',
  purify: 'dompurify',
  dompurify: 'dompurify',
  billboard: 'billboard.js',
  nbillboard: 'billboard.js',
  maptopojson: 'topojson',
  topojson: 'topojson',
  masonry: 'masonry-layout', // echtes gepflegtes Paket (npm „masonry" ist verwaist bei 0.0.2)
  fullcalendarlocales: '@fullcalendar/core',
};

/** Entfernt Bündel-/Bau-Suffixe generisch (masonry.pkgd → masonry, foo.bundle.min → foo). */
function stripPackaging(key) {
  return key.replace(/\.(pkgd|bundle|standalone|slim|common|esm|umd|cjs|iife|browser|prod|production|min)(?=$|\.)/gi, '').replace(/\.+$/, '');
}

/** Mappt einen erkannten Lib-Namen auf den (primären) npm-Paketnamen. */
export function npmPackageName(name) {
  const key = String(name ?? '').toLowerCase();
  return NPM_NAME[key] ?? NPM_NAME[stripPackaging(key)] ?? stripPackaging(key);
}

/** Kandidaten-Paketnamen (generisch), die fetchNpmInfo der Reihe nach probiert, bis einer auflöst.
 *  Deckt Bündel-Dateinamen ab, ohne je Lib etwas fest zu verdrahten. */
export function npmNameCandidates(name) {
  const key = String(name ?? '').toLowerCase();
  const stripped = stripPackaging(key);
  const out = [NPM_NAME[key], NPM_NAME[stripped], stripped, key];
  // führendes Ein-Buchstaben-Präfix (z.B. „nbillboard" → „billboard") als letzter generischer Versuch
  if (/^[a-z][a-z]{3,}/.test(stripped) && stripped.length > 4) out.push(stripped.replace(/^[a-z]/, ''));
  return [...new Set(out.filter(Boolean))];
}

/**
 * Holt Registry-Infos für ein Paket.
 * @param {string} name  Lib-/Paketname
 * @param {{fetch?:Function}} [deps]
 * @returns {Promise<{name:string, latest:(string|null), releasedAt:(string|null), time:object}>}
 */
/** Normalisiert eine npm-repository-Angabe auf eine HTTPS-Quell-URL (z.B. GitHub). */
export function normalizeRepoUrl(repo) {
  let r = repo;
  if (r && typeof r === 'object') r = r.url;
  if (!r || typeof r !== 'string') return null;
  return r
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
}

/**
 * T-146 — zeitliche Korrelation: die zuletzt VOR/AM Referenzdatum stabil erschienene Version.
 * Idee: wenn die Version einer gebündelten Lib nicht direkt lesbar ist, aber der Bündel-Bauzeitpunkt
 * bekannt ist (z.B. aus den Release-Daten der lesbaren Geschwister-Libs), war die gesuchte Version die,
 * die zu diesem Zeitpunkt aktuell war. Pre-Releases (mit „-") werden ignoriert.
 * @param {object} time  npm-`time`-Map: Version → ISO-Datum
 * @param {string} refIso  Referenz-Datum (ISO)
 * @returns {string|null}
 */
export function versionAtDate(time, refIso) {
  if (!time || !refIso) return null;
  const ref = Date.parse(refIso);
  if (Number.isNaN(ref)) return null;
  const cand = Object.entries(time)
    .filter(([v]) => v !== 'created' && v !== 'modified' && !/-/.test(v))
    .map(([v, d]) => [v, Date.parse(d)])
    .filter(([, d]) => !Number.isNaN(d) && d <= ref)
    .sort((a, b) => a[1] - b[1]);
  return cand.length ? cand[cand.length - 1][0] : null;
}

export async function fetchNpmInfo(name, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error('kein fetch verfügbar');
  // Generischer Kandidaten-Fallback: bündel-Dateinamen (masonry.pkgd, nbillboard, maptopojson …) lösen
  // unter dem echten Paketnamen auf, ohne je Lib etwas fest zu verdrahten. Ersten Treffer nehmen.
  const candidates = npmNameCandidates(name);
  let doc = null; let pkg = candidates[0]; let lastStatus = null;
  for (const cand of candidates) {
    const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(cand)}`);
    if (res.ok) { doc = await res.json(); pkg = cand; break; }
    lastStatus = res.status;
  }
  if (!doc) throw new Error(`npm-Registry ${lastStatus ?? '404'}`);
  const time = doc?.time ?? {};
  // „letzte stabil released Version": dist-tags.latest ist i.d.R. stabil; falls es doch ein
  // Pre-Release ist (enthält „-", z.B. 2.0.0-beta), die höchste stabile Version aus time wählen.
  let latest = doc?.['dist-tags']?.latest ?? null;
  if (!latest || /-/.test(latest)) {
    const stable = Object.keys(time).filter((v) => v !== 'created' && v !== 'modified' && !/-/.test(v));
    if (stable.length) latest = stable.sort((a, b) => Date.parse(time[a]) - Date.parse(time[b])).pop();
  }
  const npm = `https://www.npmjs.com/package/${pkg}`;
  const links = { source: normalizeRepoUrl(doc?.repository) ?? null, homepage: doc?.homepage ?? null, npm };
  // Lizenz: bevorzugt aus dem latest-Manifest, sonst Root (T-95)
  const lic = doc?.versions?.[latest]?.license ?? doc?.license ?? null;
  const license = lic && typeof lic === 'object' ? (lic.type || lic.name || null) : lic;
  return { name: pkg, latest, releasedAt: latest ? time[latest] ?? null : null, time, links, license };
}
