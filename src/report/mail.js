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
 * @param {{artifact:string,gitLink:string,change:string,testResult:string,reviewUrl?:string,mockUrl?:string,apexUrl?:string}[]} run.updated
 * @param {{name:string,label:string,reasons:string[],gitLink?:string}[]} [run.risks]
 * @param {{artifact:string,reason:string}[]} [run.failures]
 * @param {{secrets?:string[]}} [opts]
 * @returns {{subject:string, body:string}}
 */
export function renderReport(run, opts = {}) {
  const updated = run.updated ?? [];
  const risks = run.risks ?? [];
  const failures = run.failures ?? [];
  const rebuilt = run.rebuilt ?? [];     // T-94: neu gebaute/migrierte Komponenten
  const licenses = run.licenses ?? [];   // T-95: Lizenz-Auffälligkeiten
  const licenseChanges = run.licenseChanges ?? []; // T-156: geänderte Lizenzen (installiert→neu)

  const lines = [];
  lines.push(`Plugin Maintenance — Run report`);
  lines.push('');

  if (risks.length) {
    lines.push(`⚠️ Action needed (${risks.length})`);
    for (const r of risks) lines.push(`- ${r.label} ${r.name}: ${r.reasons.join('; ')}${r.gitLink ? ` (${r.gitLink})` : ''}`);
    lines.push('');
  }

  if (rebuilt.length) {
    lines.push(`🚀 Rebuilt (verified as before) (${rebuilt.length})`);
    for (const r of rebuilt) lines.push(`- ${r.artifact}: rebuilt on ${r.to || 'latest'}${r.at ? ` (${r.at})` : ''}${r.reviewUrl ? ` — ${r.reviewUrl}` : ''}`);
    lines.push('');
  }

  // T-156: Lizenzänderungen — rechtlich wichtig, daher IMMER und prominent (auch wenn sonst alles grün).
  if (licenseChanges.length) {
    const risky = licenseChanges.filter((c) => c.riskier).length;
    lines.push(`⚖️ License changes (${licenseChanges.length}${risky ? `, ${risky} riskier ⛔` : ''})`);
    for (const c of licenseChanges) {
      lines.push(`- ${c.plugin ? c.plugin + ' · ' : ''}${c.name}: ${c.from} (${c.fromClass}) → ${c.to} (${c.toClass})${c.riskier ? '  ⛔ RISKIER — rechtlich prüfen!' : ''}`);
    }
    lines.push('');
  }

  if (licenses.length) {
    lines.push(`⚖️ License attention (${licenses.length})`);
    for (const l of licenses) lines.push(`- ${l.name}: ${l.id} — ${l.reason}`);
    lines.push('');
  }

  lines.push(`✅ Updated artifacts (${updated.length})`);
  for (const u of updated) {
    lines.push(`- ${u.artifact}: ${u.change} — ${u.testResult}${u.gitLink ? ` — ${u.gitLink}` : ''}${u.rebuilt ? ' — 🚀 rebuilt (verified as before)' : ''}`);
    if (u.reviewUrl) lines.push(`    → Open review/PR: ${u.reviewUrl}`);
    // Zwei Links zum Nachprüfen der Pflege: der Mock (Review-Artefakt) und die echte APEX-Testseite des Plugins.
    if (u.mockUrl) lines.push(`    → Mockup (Review): ${u.mockUrl}`);
    if (u.apexUrl) lines.push(`    → APEX plugin page: ${u.apexUrl}`);
  }

  if (failures.length) {
    lines.push('');
    lines.push(`❌ Failures (${failures.length})`);
    for (const f of failures) lines.push(`- ${f.artifact}: ${f.reason}`);
  }

  const body = redact(lines.join('\n'), opts.secrets);
  const subject = `[Plugin Maintenance] ${updated.length} updated, ${rebuilt.length} rebuilt, ${risks.length} action needed${licenseChanges.length ? `, ${licenseChanges.length} license change(s)` : ''}, ${failures.length} failures`;
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
