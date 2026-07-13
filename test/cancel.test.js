import { describe, it, expect } from 'vitest';
import { cliBackend, abortAiChildren } from '../src/ai/backend.js';

describe('B-59 Abbruch: laufende KI-Kindprozesse werden wirklich beendet', () => {
  it('abortAiChildren killt einen laufenden CLI-Call → complete() rejectet (keine Endlos-Hängung)', async () => {
    // node hängt bewusst (kein Timeout — das ist gewollt); nur der Abbruch beendet ihn.
    const be = cliBackend({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    const outcome = be.complete('prompt').then(() => 'resolved', () => 'rejected');
    await new Promise((r) => setTimeout(r, 400)); // warten, bis der Child gespawnt ist
    const killed = abortAiChildren();
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(await outcome).toBe('rejected');
  });

  it('ohne laufende Kinder ist abortAiChildren ein No-op (0)', () => {
    expect(abortAiChildren()).toBe(0);
  });
});
