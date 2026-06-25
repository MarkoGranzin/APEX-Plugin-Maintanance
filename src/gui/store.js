/**
 * T-32 — Komponenten-Registry: persistente CRUD + Notizen/Protokoll.
 *
 * Persistenter Speicher der verwalteten Plugins/Template-Komponenten (JSON-Datei, neustart-fest).
 * Hält je Komponente Stammdaten, letzte Änderung + Zusammenfassung, Notizen/Protokoll und
 * manuelle Reviews. Zeit/ID injizierbar → deterministisch testbar.
 *
 * Resultat: src/gui/store.js
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const clone = (o) => JSON.parse(JSON.stringify(o));

export function createComponentStore(opts = {}) {
  const file = opts.file ?? null;
  const now = opts.now ?? (() => new Date().toISOString());
  const idGen = opts.idGen ?? (() => crypto.randomUUID());

  let items = [];
  if (file && fs.existsSync(file)) {
    try {
      items = JSON.parse(fs.readFileSync(file, 'utf8')).items ?? [];
    } catch {
      items = [];
    }
  }

  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items }, null, 2));
  };
  const find = (id) => items.find((x) => x.id === id);

  return {
    list: () => items.map(clone),
    get: (id) => (find(id) ? clone(find(id)) : null),

    add: (data = {}) => {
      const c = {
        id: idGen(),
        name: data.name ?? 'Unbenannt',
        type: data.type === 'template_component' ? 'template_component' : 'plugin',
        repo: data.repo ?? null, // Herkunfts-Repo (F-18 Auto-Discovery)
        source: data.source ?? '', // Repo-URL/Pfad (F-21)
        visibility: data.visibility ?? 'öffentlich', // öffentlich | intern
        secretRef: data.secretRef ?? null, // Verweis auf verschlüsseltes Secret (T-12), nie Klartext
        path: data.path ?? '',
        critical: !!data.critical,
        format: data.format ?? 'unclear',
        status: data.status ?? 'neu',
        lastChange: data.lastChange ?? null, // { at, summary }
        lastLog: data.lastLog ?? null, // { at, entries:[{agent,file,result,severity?}] } (F-22)
        testPlan: data.testPlan ?? null, // Cucumber/Gherkin-Testplan (Text, Baseline)
        coverage: data.coverage ?? null, // Pfadabdeckung {functions,branches,params,scenarios,...} (F-26)
        codedTests: data.codedTests ?? [], // generierte Coded-UI/Unit-Tests [{name,content}] (T-64)
        libsCheckedAt: data.libsCheckedAt ?? null, // letzter Web-Lib-Check (T-59)
        uiTestUrl: data.uiTestUrl ?? null, // Test-URL für Coded-UI-Tests (T-73)
        reviewUrl: data.reviewUrl ?? null, // PR/Review-Link nach Upload (T-76)
        reviewBranch: data.reviewBranch ?? null,
        libs: data.libs ?? [], // verwendete Bibliotheken [{name,version,status,...}]
        libWarning: data.libWarning ?? null, // { vulnerable, unmaintained } (F-23)
        notes: [],
        reviews: [],
        createdAt: now(),
      };
      items.push(c);
      persist();
      return clone(c);
    },

    update: (id, patch = {}) => {
      const c = find(id);
      if (!c) return null;
      for (const k of ['name', 'type', 'repo', 'source', 'visibility', 'secretRef', 'path', 'critical', 'format', 'status', 'lastChange', 'lastLog', 'testPlan', 'coverage', 'codedTests', 'libs', 'libWarning', 'libsCheckedAt', 'uiTestUrl', 'reviewUrl', 'reviewBranch', 'baseline']) {
        if (k in patch) c[k] = patch[k];
      }
      persist();
      return clone(c);
    },

    remove: (id) => {
      const before = items.length;
      items = items.filter((x) => x.id !== id);
      persist();
      return items.length < before;
    },

    addNote: (id, { kind = 'hinweis', text = '' } = {}) => {
      const c = find(id);
      if (!c) return null;
      const note = { at: now(), kind, text };
      c.notes.push(note);
      persist();
      return clone(note);
    },

    addReview: (id, review = {}) => {
      const c = find(id);
      if (!c) return null;
      const entry = { at: now(), ...review };
      c.reviews.push(entry);
      persist();
      return clone(entry);
    },

    /** Trägt die letzte Änderung + Kurz-Zusammenfassung nach (z.B. aus einem Lauf). */
    setLastChange: (id, summary) => {
      const c = find(id);
      if (!c) return null;
      c.lastChange = { at: now(), summary };
      persist();
      return clone(c.lastChange);
    },

    save: persist,
  };
}
