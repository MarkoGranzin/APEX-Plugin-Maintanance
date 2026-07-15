/**
 * T-34 — REST-API-Handler für die Komponenten-Verwaltung (testbar, transportunabhängig).
 *
 * Reine Funktion: (method, pathname, body, ctx) → { status, body }. start.js (serve) verdrahtet
 * sie mit node:http. So bleibt die Routing-/Aktionslogik ohne Server testbar.
 *
 * Routen (unter /api/components):
 *   GET    /                      Übersicht
 *   POST   /                      anlegen
 *   GET    /:id                   Detail
 *   PUT    /:id                   bearbeiten
 *   DELETE /:id                   löschen
 *   POST   /:id/notes             Notiz/Protokoll anhängen
 *   POST   /:id/review            manuelles Code-Review (Security+Code-Gate)
 *   POST   /:id/open              Verzeichnis im OS-Explorer öffnen
 *
 * Resultat: src/gui/api.js
 */

import { overviewViewModel, detailViewModel, manualReview, openDirectory } from './components.js';
import { setWorkDir, setAiBackend, setSmtp, setSchedule, setRecipients } from '../config/settings.js';
import { aiBackendView } from '../ai/configure.js';
import { runComponentOnce, runManaged } from '../service/run-component.js';
import { collectLibraries } from '../service/libraries.js';

export function apiHandler(method, pathname, body, ctx) {
  const store = ctx.store;
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] !== 'api' || parts[1] !== 'components') return { status: 404, body: { error: 'not found' } };

  const id = parts[2];
  const sub = parts[3];
  const notFound = { status: 404, body: { error: 'not found' } };

  if (!id) {
    if (method === 'GET') return { status: 200, body: overviewViewModel(store) };
    if (method === 'POST') return { status: 201, body: store.add(body ?? {}) };
    return { status: 405, body: { error: 'method not allowed' } };
  }

  if (!sub) {
    if (method === 'GET') { const d = detailViewModel(store, id); return d ? { status: 200, body: d } : notFound; }
    if (method === 'PUT') { const u = store.update(id, body ?? {}); return u ? { status: 200, body: u } : notFound; }
    if (method === 'DELETE') return store.remove(id) ? { status: 200, body: { ok: true } } : notFound;
    return { status: 405, body: { error: 'method not allowed' } };
  }

  if (sub === 'notes' && method === 'POST') {
    const n = store.addNote(id, body ?? {});
    return n ? { status: 200, body: n } : notFound;
  }
  if (sub === 'review' && method === 'POST') {
    const r = manualReview(store, id, { gather: ctx.gather, reviewGate: ctx.reviewGate, save: body?.save !== false });
    return r.error ? notFound : { status: 200, body: r };
  }
  if (sub === 'open' && method === 'POST') {
    const c = store.get(id);
    if (!c) return notFound;
    return { status: 200, body: openDirectory(c.path, ctx.opener ?? {}) };
  }
  if (sub === 'run' && method === 'POST') {
    const c = store.get(id);
    if (!c) return notFound;
    return { status: 200, body: runComponentOnce(store, c, { scan: ctx.scan, logSink: ctx.logSink, onTestPlan: ctx.onTestPlan, onSbom: ctx.onSbom }) };
  }

  return notFound;
}

/**
 * Async-Handler für Arbeitsverzeichnis & Repo-Anbindung (F-18).
 * Routen: GET/PUT /api/settings · GET/POST /api/repos · POST /api/repos/rescan
 * @param {object} ctx { settings, syncRepo(repoConfig) }
 * @returns {Promise<{status:number, body:any}>}
 */
export async function metaApiHandler(method, pathname, body, ctx) {
  const { settings } = ctx;
  const p = pathname.replace(/^\/+|\/+$/g, '');

  if (p === 'api/settings') {
    const view = () => ({
      workDir: settings.workDir,
      repos: settings.repos,
      recipients: settings.recipients,
      schedule: settings.schedule,
      scheduleEnabled: !!settings.scheduleEnabled,
      allowPush: !!settings.allowPush,
      autoRepair: !!settings.autoRepair,
      autoReplaceUnmaintained: !!settings.autoReplaceUnmaintained, // T-163 Opt-in (Default AUS)
      smtp: settings.smtp,
      aiBackend: aiBackendView(settings),
      apexTarget: settings.apexTarget, // T-134 (nicht-geheime APEX-Ziel-Konfig; Passwort separat via secretStore)
    });
    if (method === 'GET') return { status: 200, body: view() };
    if (method === 'PUT') {
      try {
        if (body?.workDir != null) setWorkDir(settings, body.workDir);
        if (body?.aiBackend) setAiBackend(settings, { ...(settings.aiBackend ?? {}), ...body.aiBackend });
        if (body?.smtp) setSmtp(settings, body.smtp);
        if (body?.recipients) setRecipients(settings, body.recipients);
        if (body?.schedule != null) setSchedule(settings, body.schedule);
        if (body?.scheduleEnabled != null) settings.scheduleEnabled = !!body.scheduleEnabled;
        if (body?.allowPush != null) settings.allowPush = !!body.allowPush;
        if (body?.autoRepair != null) settings.autoRepair = !!body.autoRepair;
        if (body?.autoReplaceUnmaintained != null) settings.autoReplaceUnmaintained = !!body.autoReplaceUnmaintained; // T-163
        return { status: 200, body: view() };
      } catch (err) {
        return { status: 400, body: { error: String(err?.message ?? err) } };
      }
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }

  if (p === 'api/repos') {
    if (method === 'GET') return { status: 200, body: settings.repos };
    if (method === 'POST') {
      if (!body?.name || !body?.source) return { status: 400, body: { error: 'name and source required' } };
      const res = await ctx.syncRepo({ name: body.name, source: body.source, secretRef: body.secretRef ?? null, auth: body.auth });
      if (!settings.repos.some((r) => r.name === body.name)) {
        settings.repos.push({ name: body.name, source: body.source, secretRef: body.secretRef ?? null });
      }
      return { status: 200, body: res };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  }

  if (p === 'api/repos/rescan' && method === 'POST') {
    const targets = body?.name ? settings.repos.filter((r) => r.name === body.name) : settings.repos;
    const results = [];
    for (const r of targets) results.push(await ctx.syncRepo(r));
    // nach dem Fetch/Detect direkt analysieren, damit lastChange/Status frisch sind
    if (ctx.store) runManaged({ store: ctx.store, scan: ctx.scan, recordRun: ctx.recordRun, logSink: ctx.logSink, onTestPlan: ctx.onTestPlan, onSbom: ctx.onSbom });
    return { status: 200, body: results };
  }

  // Bibliotheks-Übersicht (F-23): aggregiert Libs + setzt libWarning je Komponente
  if (p === 'api/libraries' && method === 'GET') {
    if (!ctx.store) return { status: 500, body: { error: 'no store' } };
    return { status: 200, body: collectLibraries(ctx.store, { scan: ctx.scan }) };
  }

  // Manueller Lauf über alle Komponenten (analysieren + lastChange/Status aktualisieren)
  if (p === 'api/run' && method === 'POST') {
    if (!ctx.store) return { status: 500, body: { error: 'no store' } };
    const res = runManaged({ store: ctx.store, scan: ctx.scan, recordRun: ctx.recordRun, repo: body?.repo, logSink: ctx.logSink, onTestPlan: ctx.onTestPlan, onSbom: ctx.onSbom });
    return { status: 200, body: res };
  }

  return { status: 404, body: { error: 'not found' } };
}
