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

// Fingerprint-/Anzeigename → npm-Paketname (nur wo abweichend).
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
};

/** Mappt einen erkannten Lib-Namen auf den npm-Paketnamen. */
export function npmPackageName(name) {
  const key = String(name ?? '').toLowerCase();
  return NPM_NAME[key] ?? key;
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

export async function fetchNpmInfo(name, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new Error('kein fetch verfügbar');
  const pkg = npmPackageName(name);
  const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
  if (!res.ok) throw new Error(`npm-Registry ${res.status}`);
  const doc = await res.json();
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
  return { name: pkg, latest, releasedAt: latest ? time[latest] ?? null : null, time, links };
}
