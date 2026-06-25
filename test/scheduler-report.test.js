import { describe, it, expect } from 'vitest';
import { cronMatches } from '../src/service/cron.js';
import { sendReportMail } from '../src/report/smtp.js';
import { createSettings, setSmtp } from '../src/config/settings.js';
import { createComponentStore } from '../src/gui/store.js';
import { runComponentOnce } from '../src/service/run-component.js';

describe('Cron-Zeitplan', () => {
  it('Wildcard matcht immer', () => {
    expect(cronMatches('* * * * *', new Date())).toBe(true);
  });
  it('konkreter Zeitpunkt: Mo 03:00', () => {
    const mon0300 = new Date(2026, 0, 5, 3, 0); // 5.1.2026 ist ein Montag
    expect(cronMatches('0 3 * * 1', mon0300)).toBe(true);
    expect(cronMatches('0 3 * * 1', new Date(2026, 0, 5, 4, 0))).toBe(false);
    expect(cronMatches('0 3 * * 2', mon0300)).toBe(false);
  });
  it('Schrittweite */15', () => {
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 10, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 0, 1, 10, 31))).toBe(false);
  });
  it('ungültiger Ausdruck → false', () => {
    expect(cronMatches('kaputt', new Date())).toBe(false);
  });
});

describe('SMTP-Report', () => {
  it('sendet an alle Empfänger über injizierten Transport', async () => {
    const sent = [];
    const transport = { sendMail: async (m) => { sent.push(m); return { messageId: 'x1' }; } };
    const r = await sendReportMail({ subject: 'S', body: 'B' }, { recipients: ['a@x.de', 'b@x.de'], transport });
    expect(r.sent).toEqual(['a@x.de', 'b@x.de']);
    expect(sent[0].to).toBe('a@x.de, b@x.de');
    expect(sent[0].subject).toBe('S');
  });
  it('ohne Empfänger → Fehler', async () => {
    await expect(sendReportMail({ subject: 'S', body: 'B' }, { recipients: [], transport: { sendMail: async () => ({}) } })).rejects.toThrow(/Empfänger/);
  });
  it('setSmtp übernimmt Host/Port/secure', () => {
    const s = createSettings();
    setSmtp(s, { host: 'smtp.x', port: '465', secure: true, user: 'u', from: 'f' });
    expect(s.smtp).toMatchObject({ host: 'smtp.x', port: 465, secure: true, user: 'u', from: 'f' });
  });
});

describe('Testplan-Baseline & libs', () => {
  const scanA = () => ({ log: [], testPlan: 'PLAN-A', libs: [{ name: 'jquery', version: '3.4.1', status: 'verwundbar' }], artifacts: [], outdated: [], risks: [], failures: [] });
  const scanB = () => ({ log: [], testPlan: 'PLAN-B', libs: [], artifacts: [], outdated: [], risks: [], failures: [] });

  it('Testplan bleibt Baseline, bis explizit neu erzeugt', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    runComponentOnce(store, store.get('c1'), { scan: scanA });
    expect(store.get('c1').testPlan).toBe('PLAN-A');
    runComponentOnce(store, store.get('c1'), { scan: scanB }); // ohne regenerate
    expect(store.get('c1').testPlan).toBe('PLAN-A'); // unverändert
    runComponentOnce(store, store.get('c1'), { scan: scanB, regenerateTestPlan: true });
    expect(store.get('c1').testPlan).toBe('PLAN-B');
  });

  it('verwendete Bibliotheken werden je Komponente gespeichert', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    runComponentOnce(store, store.get('c1'), { scan: scanA });
    expect(store.get('c1').libs).toEqual([{ name: 'jquery', version: '3.4.1', status: 'verwundbar' }]);
  });

  it('onTestPlan-Sink wird bei (Neu-)Erzeugung gerufen', () => {
    const store = createComponentStore({ now: () => 't', idGen: () => 'c1' });
    store.add({ name: 'x', path: '/x' });
    let sink = null;
    runComponentOnce(store, store.get('c1'), { scan: scanA, onTestPlan: (_c, t) => { sink = t; } });
    expect(sink).toBe('PLAN-A');
  });
});
