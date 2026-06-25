/**
 * T-9 — Report-Mail zusammenstellen & versenden.
 *
 * Aktualisierte Artefakte (Git-Link, Diff-Beschreibung, Testergebnis) + Handlungsbedarf-Block
 * (T-16) + Fehlschläge sammeln, Mail rendern und an konfigurierte Adresse(n) senden. NIEMALS
 * Klartext-Secrets im Body (Wissen #503) — zusätzlich Defense-in-Depth-Redaction.
 *
 * Resultat: src/report/mail.js
 */

/** Entfernt etwaige Secret-Klartexte aus einem Text (Defense in Depth). */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

/**
 * Rendert den Report.
 * @param {object} run
 * @param {{artifact:string,gitLink:string,change:string,testResult:string}[]} run.updated
 * @param {{name:string,label:string,reasons:string[],gitLink?:string}[]} [run.risks]
 * @param {{artifact:string,reason:string}[]} [run.failures]
 * @param {{secrets?:string[]}} [opts]
 * @returns {{subject:string, body:string}}
 */
export function renderReport(run, opts = {}) {
  const updated = run.updated ?? [];
  const risks = run.risks ?? [];
  const failures = run.failures ?? [];

  const lines = [];
  lines.push(`AIS Pluginpflege — Lauf-Report`);
  lines.push('');

  if (risks.length) {
    lines.push(`⚠️ Handlungsbedarf (${risks.length})`);
    for (const r of risks) lines.push(`- ${r.label} ${r.name}: ${r.reasons.join('; ')}${r.gitLink ? ` (${r.gitLink})` : ''}`);
    lines.push('');
  }

  lines.push(`✅ Aktualisierte Artefakte (${updated.length})`);
  for (const u of updated) lines.push(`- ${u.artifact}: ${u.change} — ${u.testResult} — ${u.gitLink}`);

  if (failures.length) {
    lines.push('');
    lines.push(`❌ Fehlschläge (${failures.length})`);
    for (const f of failures) lines.push(`- ${f.artifact}: ${f.reason}`);
  }

  const body = redact(lines.join('\n'), opts.secrets);
  const subject = `[AIS Pluginpflege] ${updated.length} aktualisiert, ${risks.length} Handlungsbedarf, ${failures.length} Fehlschläge`;
  return { subject, body };
}

/**
 * Versendet den Report an alle Empfänger über einen injizierbaren Transport.
 * @param {{subject:string,body:string}} report
 * @param {object} opts
 * @param {string[]} opts.recipients
 * @param {(msg:{to:string,subject:string,body:string})=>Promise<any>|any} opts.transport
 */
export async function sendReport(report, opts) {
  const recipients = opts.recipients ?? [];
  if (recipients.length === 0) throw new Error('Keine Empfänger konfiguriert');
  const sent = [];
  for (const to of recipients) {
    await opts.transport({ to, subject: report.subject, body: report.body });
    sent.push(to);
  }
  return { sent };
}
