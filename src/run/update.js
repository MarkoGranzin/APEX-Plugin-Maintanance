/**
 * T-8 — Update durchführen, testen, bei grün pushen.
 *
 * Veraltete Lib aktualisieren → kanonisches Asset patchen → (T-25 Re-Injektion durch den
 * Aufrufer/Push-Schritt) → Tests laufen lassen; bei Rot greift der Selbstheilungs-Loop (T-15).
 * Nur bei FINAL GRÜN wird committet/gepusht — Auslieferung als Pull Request (Wissen #508),
 * kein Push ohne grünes Gate (Wissen #503). Bei Limit/Fehlschlag: kein Push, Rollback,
 * Eintrag in History/Report.
 *
 * Resultat: src/run/update.js
 */

import { selfHeal } from './heal.js';

/**
 * @param {object} args
 * @param {object} args.artifact            Artefakt-Info (Name etc.)
 * @param {object} args.suite               Testsuite (für Runner/Gate)
 * @param {()=>Promise<any>|any} args.applyUpdate  führt das Lib-Update am Arbeitsstand durch
 * @param {object} args.ai                  KI-Backend für den Reparatur-Loop
 * @param {(patch:object,attempt:number)=>any} args.healApply  wendet KI-Korrektur an
 * @param {(artifact:object)=>Promise<any>|any} args.push  committet+PR (nur bei grün), liefert prRef
 * @param {(suite:object)=>Promise<object>} [args.runner]
 * @param {()=>any} [args.rollback]
 * @param {(patch:object)=>{allowed:boolean}} [args.guard]
 * @param {number} [args.limit]
 * @returns {Promise<{pushed:boolean, success:boolean, attempts:number, reason:string, prRef?:any, protocol:object[]}>}
 */
export async function autoUpdateArtifact(args) {
  const { artifact, suite, applyUpdate, ai, healApply, push, runner, rollback, guard, limit } = args;

  await applyUpdate();

  const heal = await selfHeal({ suite, ai, apply: healApply, runner, rollback, guard, limit });

  if (!heal.success) {
    // Rollback hat selfHeal bereits ausgeführt; KEIN Push
    return {
      pushed: false,
      success: false,
      attempts: heal.attempts,
      reason: heal.reason,
      protocol: heal.protocol,
    };
  }

  // Review-Gate (T-31): Pflege grün, aber Security- UND Code-Review müssen ebenfalls grün sein
  if (args.review) {
    const gate = await args.review();
    if (!gate.pass) {
      if (rollback) rollback();
      return {
        pushed: false,
        success: false,
        attempts: heal.attempts,
        reason: `review-blockiert (${gate.stage})`,
        review: gate,
        protocol: heal.protocol,
      };
    }
  }

  const prRef = await push(artifact);
  return {
    pushed: true,
    success: true,
    attempts: heal.attempts,
    reason: heal.green ? 'grün → Push' : 'grün',
    prRef,
    protocol: heal.protocol,
  };
}
