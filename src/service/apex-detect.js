/**
 * T-165 — Portable APEX-Ziel-Konfig: die instanzspezifischen Werte (App-ID, Workspace-ID, Owner)
 * holt sich das Tool SELBST aus der Ziel-Instanz, statt sie den Nutzer aus Export-Dateien
 * abschreiben zu lassen. Ablauf: Login (bestehende UI-Automation) → Workspace-Info per
 * SQL-Commands (markierter String, markup-unabhängig) → Apps-Liste von den Builder-Kacheln →
 * App per ID/Name/Alias auflösen. GUARDRAIL unverändert: bei uneindeutigem/fehlendem Treffer
 * wird NIE automatisch eine App gewählt — die Liste geht zur Auswahl an den Nutzer zurück.
 *
 * Reine, injizierbare Orchestrierung (login/listApps/runSql als deps) → ohne Browser testbar.
 *
 * Resultat: src/service/apex-detect.js
 */

/** Markierter SQL-Ausdruck: Ergebnis erscheint als AISPP|<workspace_id>|<owner>|<workspace> im Seitentext. */
export const WORKSPACE_INFO_SQL =
  "select 'AISPP|'||workspace_id||'|'||sys_context('userenv','current_schema')||'|'||workspace as info from apex_workspaces";

/** Parst die Workspace-Info aus dem sichtbaren Ergebnis-Text von SQL Commands. @returns {null|{workspaceId,owner,workspace}} */
export function parseWorkspaceInfo(text) {
  const m = String(text || '').match(/AISPP\|(\d{3,})\|([A-Za-z0-9_$#]+)\|(\S+)/);
  if (!m) return null;
  return { workspaceId: m[1], owner: m[2], workspace: m[3] };
}

/**
 * Löst eine App aus der Liste per Hint auf: exakte ID, exakter Name (case-insensitiv) oder
 * EINDEUTIGER Teilstring. Uneindeutig/kein Treffer → null (Guardrail: keine Auto-Wahl).
 * @param {Array<{id:number,name:string}>} apps @param {string|number} hint
 */
export function matchApp(apps, hint) {
  const list = apps || [];
  const h = String(hint ?? '').trim();
  if (!h) return null;
  if (/^\d+$/.test(h)) return list.find((a) => a.id === Number(h)) ?? null;
  const lc = h.toLowerCase();
  const exact = list.filter((a) => String(a.name || '').toLowerCase() === lc);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((a) => String(a.name || '').toLowerCase().includes(lc));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Detect-Flow: Login → Workspace-Info → Apps-Liste → App-Auflösung (optional).
 * workspaceId/owner werden IMMER geliefert (unabhängig von der App-Wahl); appId nur bei
 * eindeutigem Treffer. Kein Treffer → apps[] zur Auswahl + needsAppChoice.
 * @param {{baseUrl,workspace,loginUser,pass,appHint?}} cfg
 * @param {{login:Function, listApps:Function, runSql:Function}} deps
 */
export async function detectApexTarget(cfg = {}, deps = {}) {
  const { login, listApps, runSql } = deps;
  if (typeof login !== 'function' || typeof listApps !== 'function' || typeof runSql !== 'function') {
    return { ok: false, error: 'login/listApps/runSql must be injected.' };
  }
  const l = await login({ baseUrl: cfg.baseUrl, workspace: cfg.workspace, user: cfg.loginUser, pass: cfg.pass });
  if (!l?.ok) return { ok: false, error: l?.error || 'Login failed.' };

  const sqlRes = await runSql(WORKSPACE_INFO_SQL);
  const info = sqlRes?.ok ? parseWorkspaceInfo(sqlRes.text) : null;
  if (!info) return { ok: false, error: sqlRes?.error || 'Could not read workspace info from SQL Commands (result not recognized).' };

  let apps = [];
  try { apps = await listApps(); } catch { apps = []; }
  const hit = matchApp(apps, cfg.appHint);
  return {
    ok: true,
    workspaceId: info.workspaceId,
    owner: info.owner,
    workspace: info.workspace,
    apps,
    appId: hit ? hit.id : null,
    appName: hit ? hit.name : null,
    needsAppChoice: !hit,
  };
}

/**
 * Systemwechsel-Diagnose: wechselt die Ziel-App real (alte UND neue ID vorhanden, verschieden),
 * zeigen die pro Komponente registrierten Testseiten (apexPageId) auf Seiten der ALTEN App —
 * sie werden zurückgesetzt, damit der nächste Deploy sauber neu registriert (ab 20000) statt in
 * der neuen App nicht-existente Seiten zu suchen/löschen. Nur eine Plan-Berechnung (pure).
 * @returns {{reset:string[], reason:string|null}}
 */
export function pageRegisterResetPlan(components, oldAppId, newAppId) {
  const o = Number(oldAppId), n = Number(newAppId);
  if (!o || !n || o === n) return { reset: [], reason: null };
  const reset = (components || []).filter((c) => c && c.apexPageId).map((c) => c.id);
  return { reset, reason: reset.length ? `target app changed ${o} → ${n}: ${reset.length} page register(s) point to the old app` : null };
}
