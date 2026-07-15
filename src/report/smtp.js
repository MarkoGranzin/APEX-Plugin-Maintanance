/**
 * E-Mail-Versand des Reports per SMTP (nodemailer).
 *
 * SMTP-Daten kommen aus den Einstellungen (host/port/secure/user/from); das Passwort wird
 * verschlüsselt im SecretStore gehalten und nur zur Laufzeit aufgelöst. transport ist injizierbar
 * (für Tests ohne echten Server). Keine Secrets im Body (Report wird redigiert, T-9).
 *
 * Resultat: src/report/smtp.js
 */

import nodemailer from 'nodemailer';

export function createTransport(smtp, pass) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: pass ?? '' } : undefined,
  });
}

/**
 * Versendet einen gerenderten Report.
 * @param {{subject:string, body:string}} report
 * @param {{smtp:object, pass?:string, recipients:string[], transport?:object}} opts
 */
export async function sendReportMail(report, opts) {
  const recipients = opts.recipients ?? [];
  if (!recipients.length) throw new Error('No recipients configured');
  if (!opts.transport && !opts.smtp?.host) throw new Error('No SMTP host configured');
  const t = opts.transport ?? createTransport(opts.smtp, opts.pass);
  const info = await t.sendMail({
    from: opts.smtp?.from || opts.smtp?.user || 'aisp@local',
    to: recipients.join(', '),
    subject: report.subject,
    text: report.body,
  });
  return { sent: recipients, messageId: info?.messageId ?? null };
}
