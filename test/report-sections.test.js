import { describe, it, expect } from 'vitest';
import { renderReport } from '../src/report/mail.js';

describe('T-94/T-95 Report-Abschnitte', () => {
  it('kennzeichnet rebuilt-Komponenten inkl. Ziel-Version', () => {
    const { subject, body } = renderReport({
      updated: [{ artifact: 'APEX-Vanta', change: 'three bump', testResult: 'ok', rebuilt: true }],
      rebuilt: [{ artifact: 'APEX-Vanta', to: 'three@0.185.0', at: '2026-06-25' }],
    });
    expect(body).toMatch(/🚀 Rebuilt \(verified as before\)/);
    expect(body).toMatch(/three@0\.185\.0/);
    expect(body).toMatch(/🚀 rebuilt \(verified as before\)/); // Markierung in der updated-Zeile
    expect(subject).toMatch(/1 rebuilt/);
  });

  it('listet Lizenz-Auffälligkeiten', () => {
    const { body } = renderReport({
      updated: [],
      licenses: [{ name: 'P/three', id: 'GPL-3.0', reason: 'copyleft — commercially risky / source obligations' }],
    });
    expect(body).toMatch(/⚖️ License attention/);
    expect(body).toMatch(/GPL-3\.0/);
    expect(body).toMatch(/copyleft/);
  });

  it('ohne rebuilt/licenses keine Abschnitte', () => {
    const { body } = renderReport({ updated: [{ artifact: 'X', change: 'c', testResult: 'ok' }] });
    expect(body).not.toMatch(/Rebuilt/);
    expect(body).not.toMatch(/License attention/);
  });
});
