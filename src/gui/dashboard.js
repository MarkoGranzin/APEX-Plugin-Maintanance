/**
 * T-14 — GUI: Repo-Verwaltung & Dashboard (View-Model + Handler hinter der Oberfläche).
 *
 * Repos hinzufügen/entfernen, Status je Repo, letzter Lauf/Ergebnis, „Jetzt prüfen", Link in
 * die History. Die Präsentation (HTML) rendert dieses View-Model; die Logik ist hier testbar
 * gekapselt und nutzt settings.js (T-12), history.js (T-10) und den Scheduler (T-13).
 *
 * Resultat: src/gui/dashboard.js
 */

import { addRepo as addRepoSetting, removeRepo as removeRepoSetting } from '../config/settings.js';
import { listRuns } from '../report/history.js';

/** Letzter Lauf, der ein Repo betraf (über die zugehörigen Artefakte). */
function lastRunFor(history, repoName) {
  const runs = listRuns(history).filter((r) => (r.repo ? r.repo === repoName : true));
  return runs.length ? runs[runs.length - 1] : null;
}

/**
 * Dashboard-View-Model: je Repo Status, letzter Lauf, ob gerade ein Lauf läuft.
 */
export function dashboardViewModel({ settings, history, scheduler }) {
  return {
    repos: settings.repos.map((r) => {
      const last = lastRunFor(history, r.name);
      return {
        name: r.name,
        source: r.source,
        running: scheduler ? scheduler.isRunning(r.name) : false,
        lastRun: last ? { id: last.id, status: last.status, at: last.at } : null,
        historyLink: last ? `#/history/${last.id}` : null,
        actions: { checkNow: `triggerNow:${r.name}` },
      };
    }),
  };
}

/** Handler: Repo hinzufügen. */
export function addRepo(settings, repo) {
  return addRepoSetting(settings, repo);
}

/** Handler: Repo entfernen. */
export function removeRepo(settings, name) {
  return removeRepoSetting(settings, name);
}

/** Handler: „Jetzt prüfen" — löst über den Scheduler einen Lauf aus (kein Doppellauf, T-13). */
export function triggerNow(scheduler, repoName, now) {
  return scheduler.submit(repoName, { now, trigger: 'manual' });
}
