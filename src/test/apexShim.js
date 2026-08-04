/**
 * apex.*-Shim für den billigen jsdom-Testpfad (Teil von T-22).
 *
 * Bildet die DOM-/Logik-lastigen apex.*-Funktionen nach, die OHNE laufende APEX-Instanz
 * sinnvoll mockbar sind (apex.item, apex.event, apex.message, apex.util ...). Echte
 * Runtime-Abhängigkeiten (apex.server.process/plugin) sind bewusst NICHT lauffähig
 * nachgebildet — sie werfen einen klar erkennbaren Fehler, damit der Lauf nicht still
 * "grün" wird, sondern auf den Playwright-Pfad (B) verweist.
 *
 * Resultat: src/test/apexShim.js
 */

/** Pfade (ohne 'apex.'-Präfix), die echte APEX-Runtime brauchen → Playwright-Pfad. */
export const RUNTIME_PATHS = new Set([
  'server.process',
  'server.plugin',
  'server.chunk',
]);

class RuntimeRequiredError extends Error {
  constructor(path) {
    super(`apex.${path} benötigt echte APEX-Runtime (jsdom-Shim deckt das nicht ab → Playwright nötig)`);
    this.name = 'RuntimeRequiredError';
    this.apexPath = path;
  }
}

/**
 * Erzeugt einen apex.*-Shim. items: { 'P1_NAME': 'wert', ... } als Anfangszustand.
 * @param {object} [opts]
 * @param {Record<string,any>} [opts.items]
 */
export function createApexShim(opts = {}) {
  const store = { ...(opts.items ?? {}) };
  const listeners = [];

  const item = (name) => ({
    getValue: () => store[name] ?? '',
    setValue: (v) => {
      store[name] = v;
    },
    show: () => {},
    hide: () => {},
    disable: () => {},
    enable: () => {},
  });

  const apex = {
    item,
    items: (names) => names.map(item),
    event: {
      trigger: (sel, name, data) => listeners.forEach((l) => l.name === name && l.cb(data)),
      gReady: true,
    },
    message: {
      showErrors: () => {},
      clearErrors: () => {},
      alert: () => {},
    },
    util: {
      escapeHTML: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
      htmlBuilder: () => ({ markup: () => '', toString: () => '' }),
    },
    debug: { info: () => {}, error: () => {}, log: () => {} },
    submit: () => {},
    server: {
      // Runtime-Abhängigkeiten: nicht still mocken, sondern klar verweisen
      process: () => {
        throw new RuntimeRequiredError('server.process');
      },
      plugin: () => {
        throw new RuntimeRequiredError('server.plugin');
      },
    },
    // Test-Hilfen (nicht Teil der echten apex-API)
    __store: store,
    __on: (name, cb) => listeners.push({ name, cb }),
  };
  return apex;
}

/** Prüft, ob ein gepunkteter apex.*-Pfad vom Shim abgedeckt wird (Existenz im Shim-Objekt). */
export function shimCovers(apexPath) {
  const rel = apexPath.replace(/^apex\./, '');
  // Runtime-Pfade (auch verkettet) sind bewusst nicht lauffähig abgedeckt
  for (const rp of RUNTIME_PATHS) {
    if (rel === rp || rel.startsWith(rp + '.')) return false;
  }
  const shim = createApexShim();
  let cur = shim;
  for (const part of rel.split('.')) {
    // Eine erreichte Factory/Funktion deckt ihre Methoden-Kette ab (z.B. apex.item().getValue())
    if (typeof cur === 'function') return true;
    if (cur == null || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

export { RuntimeRequiredError };
