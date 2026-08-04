import { describe, it, expect } from 'vitest';
import { resolveVersionWithAi, resolveUnknownVersionsWithAi } from '../src/service/ai-version-resolve.js';
import { checkLibrariesOnline } from '../src/service/lib-check.js';

const aiSaying = (text) => ({ kind: 'provider', complete: async () => text });
const fetchInfo = async (pkg) => ({ name: pkg, latest: '2.0.0', time: { '1.0.0': '2020-01-01', '1.5.0': '2021-06-01', '2.0.0': '2023-01-01' } });

describe('T-146 KI-Fallback für Versions-Identifikation (suchen UND validieren)', () => {
  const lib = { name: 'mystery', version: 'unbekannt', evidenceHead: '/* Mystery lib banner */' };

  it('KI-Vorschlag wird uebernommen, WENN die Version in der Registry existiert (validiert)', async () => {
    const r = await resolveVersionWithAi(lib, { ai: aiSaying('{"package":"mystery","version":"1.5.0"}'), fetchInfo });
    expect(r).toMatchObject({ version: '1.5.0', package: 'mystery', detectedBy: 'ai-validated' });
  });

  it('KI-Vorschlag wird VERWORFEN, wenn die Version fuer das Paket nicht existiert (kein blindes Raten)', async () => {
    const r = await resolveVersionWithAi(lib, { ai: aiSaying('{"package":"mystery","version":"9.9.9"}'), fetchInfo });
    expect(r).toBe(null);
  });

  it('Muell/kein JSON/kein Semver → null', async () => {
    expect(await resolveVersionWithAi(lib, { ai: aiSaying('keine ahnung'), fetchInfo })).toBe(null);
    expect(await resolveVersionWithAi(lib, { ai: aiSaying('{"package":"x","version":null}'), fetchInfo })).toBe(null);
  });

  it('Stub-Backend oder fehlende Evidenz → null (kein Rateversuch)', async () => {
    expect(await resolveVersionWithAi(lib, { ai: { kind: 'stub', complete: async () => '{"version":"1.5.0"}' }, fetchInfo })).toBe(null);
    expect(await resolveVersionWithAi({ name: 'x', version: 'unbekannt' }, { ai: aiSaying('{"version":"1.5.0"}'), fetchInfo })).toBe(null);
  });

  it('resolveUnknownVersionsWithAi: nur unbekannte mit Evidenz werden geklaert', async () => {
    const libs = [
      { name: 'a', version: '1.0.0' },                                   // bekannt → ignorieren
      { name: 'b', version: 'unbekannt', evidenceHead: 'B v1.0.0' },     // klaerbar
      { name: 'c', version: 'unbekannt' },                              // keine Evidenz → ignorieren
    ];
    const hits = [];
    const n = await resolveUnknownVersionsWithAi(libs, { ai: aiSaying('{"package":"b","version":"1.0.0"}'), fetchInfo }, (l, r) => hits.push([l.name, r.version]));
    expect(n).toBe(1);
    expect(hits).toEqual([['b', '1.0.0']]);
  });

  it('checkLibrariesOnline: unbekannte Lib wird per KI-Fallback validiert geklaert', async () => {
    const libs = [{ name: 'mystery', version: 'unbekannt', evidenceHead: '/* Mystery v1.5.0 */' }];
    const out = await checkLibrariesOnline(libs, {
      fetchInfo: async () => ({ name: 'mystery', latest: '2.0.0', releasedAt: '2023-01-01', time: { '1.5.0': '2021-06-01', '2.0.0': '2023-01-01' }, links: {} }),
      ai: aiSaying('{"package":"mystery","version":"1.5.0"}'),
      now: () => Date.parse('2024-01-01'),
    });
    const e = out[0];
    expect(e.version).toBe('1.5.0');
    expect(e.detectedBy).toBe('ai-validated');
    expect(e.versionAiResolved).toBe(true);
    expect(e.webStatus).toBe('veraltet'); // 1.5.0 < latest 2.0.0
  });
});
