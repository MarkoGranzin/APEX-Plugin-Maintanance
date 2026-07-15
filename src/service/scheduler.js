/**
 * T-13 — Wöchentlicher Scheduler + manueller Trigger; verhindert Doppelläufe pro Repo.
 *
 * Cron-artiger Zeitplan (wöchentlich) plus manuelles Auslösen. Pro Repo läuft höchstens ein
 * Lauf gleichzeitig: ein weiterer Trigger wird eingereiht statt parallel gestartet (Wissen #503).
 * Deterministisch & injizierbar (runJob, Zeit) → testbar ohne echte Timer.
 *
 * Resultat: src/service/scheduler.js
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Ist ein wöchentlicher Lauf fällig? (vereinfachte Wochen-Logik, Zeit injizierbar) */
export function isDue(lastRunAt, now, intervalMs = WEEK_MS) {
  if (lastRunAt == null) return true;
  return now - new Date(lastRunAt).getTime() >= intervalMs;
}

export function createScheduler({ runJob }) {
  const running = new Set();
  const queues = new Map(); // repo -> [resolve-able job markers]
  const lastRun = new Map();

  async function drain(repo) {
    const q = queues.get(repo);
    if (!q || q.length === 0) { running.delete(repo); return; }
    const next = q.shift();
    await execute(repo, next);
  }

  async function execute(repo, meta) {
    running.add(repo);
    try {
      await runJob(repo, meta);
    } finally {
      lastRun.set(repo, meta.now ?? null);
      await drain(repo);
    }
  }

  return {
    /** Manuell/geplant auslösen. Läuft das Repo schon → einreihen, nicht parallel. */
    submit(repo, meta = {}) {
      if (running.has(repo)) {
        if (!queues.has(repo)) queues.set(repo, []);
        queues.get(repo).push(meta);
        return { accepted: true, queued: true, reason: 'Run already in progress — queued' };
      }
      const p = execute(repo, meta);
      return { accepted: true, queued: false, done: p };
    },

    /** Geplanter Tick: alle fälligen Repos auslösen. */
    tick(repos, now) {
      const started = [];
      for (const repo of repos) {
        if (isDue(lastRun.get(repo) ?? null, now)) {
          this.submit(repo, { now, trigger: 'schedule' });
          started.push(repo);
        }
      }
      return started;
    },

    isRunning: (repo) => running.has(repo),
    queueLength: (repo) => (queues.get(repo)?.length ?? 0),
    markRun: (repo, at) => lastRun.set(repo, at),
  };
}
