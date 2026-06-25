/**
 * T-15 — Selbstheilungs-Loop: bei Rot KI-Reparatur, erneut testen, bis grün oder Limit.
 *
 * Bei rotem Gate (T-6) wird nicht abgebrochen, sondern iterativ repariert (Wissen #504):
 * Befund → KI-Korrektur → anwenden → erneut testen. Harte Grenzen gegen Endlosloop:
 *  (1) max. N Versuche (Default 5); (2) Stagnations-Abbruch bei 2× identischem Fehler;
 *  (3) bei Limit/Stagnation FEHLGESCHLAGEN, KEIN Push, Rollback. Jede Iteration wird
 * protokolliert. Idempotent: Versuche überschreiten nie das Limit; gepusht wird NIE hier
 * (nur bei Erfolg signalisiert — Push macht die Re-Injektion/Re-Upload T-25/T-8).
 *
 * Resultat: src/run/heal.js
 */

import { runSuite } from './gate.js';

function signature(gate) {
  return JSON.stringify(gate.failed.map((f) => `${f.name}:${f.error ?? ''}`).sort());
}

/**
 * @param {object} args
 * @param {object} args.suite                 Testsuite (für den Runner)
 * @param {object} args.ai                    KI-Backend (complete)
 * @param {(suite:object)=>Promise<object>} [args.runner]
 * @param {(patch:object, attempt:number)=>Promise<boolean>|boolean} args.apply  wendet Korrektur an (true=geändert)
 * @param {()=>any} [args.rollback]           Rücksetzen bei Fehlschlag
 * @param {(patch:object)=>{allowed:boolean,reason?:string}} [args.guard]  Rollentrennung (T-17)
 * @param {number} [args.limit=5]
 * @returns {Promise<{success:boolean, green:boolean, attempts:number, reason:string, protocol:object[], pushed:boolean}>}
 */
export async function selfHeal(args) {
  const { suite, ai, apply, runner, guard, rollback } = args;
  const limit = args.limit ?? 5;
  const protocol = [];

  let { gate } = await runSuite(suite, { runner });
  if (gate.pass) {
    return { success: true, green: true, attempts: 0, reason: 'bereits grün', protocol, pushed: false };
  }

  let prevSig = signature(gate);

  for (let attempt = 1; attempt <= limit; attempt++) {
    const failure = { failed: gate.failed, logs: gate.logs };
    let patch;
    try {
      const raw = await ai.complete('Repariere die fehlschlagenden Tests/den Code. Befund: ' + JSON.stringify(failure), { failure });
      patch = parsePatch(raw);
    } catch (err) {
      protocol.push({ attempt, action: 'ki-fehler', result: String(err?.message ?? err) });
      // KI nicht erreichbar → Versuch zählt, keine Änderung
      continue;
    }

    // Rollentrennung (T-17): geschützte Tests dürfen nicht geändert werden
    if (guard) {
      const g = guard(patch);
      if (!g.allowed) {
        protocol.push({ attempt, action: 'patch-abgelehnt', result: g.reason });
        continue;
      }
    }

    let changed = false;
    try {
      changed = await apply(patch, attempt);
    } catch (err) {
      protocol.push({ attempt, action: 'apply-fehler', result: String(err?.message ?? err) });
    }

    ({ gate } = await runSuite(suite, { runner }));

    if (gate.pass) {
      protocol.push({ attempt, action: patch.description ?? 'korrektur', result: 'grün' });
      return { success: true, green: true, attempts: attempt, reason: 'grün vor Limit', protocol, pushed: false };
    }

    const sig = signature(gate);
    protocol.push({ attempt, action: patch.description ?? 'korrektur', result: changed ? 'noch rot' : 'keine Änderung' });

    // (3) Stagnation: identischer Fehler ohne Fortschritt
    if (sig === prevSig) {
      if (rollback) rollback();
      return { success: false, green: false, attempts: attempt, reason: 'keine Verbesserung', protocol, pushed: false };
    }
    prevSig = sig;
  }

  // (b) Limit erreicht ohne Grün
  if (rollback) rollback();
  return { success: false, green: false, attempts: limit, reason: 'Limit erreicht', protocol, pushed: false };
}

function parsePatch(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { target: 'code', description: String(raw).slice(0, 120) };
  }
}
