import { describe, it, expect } from 'vitest';
import { findCalls } from '../src/extract/extract.js';
import { replacePluginFileContent } from '../src/extract/reinject.js';

// Charakterisierungstests (T-89): sichern das Verhalten des SQL-Literal-Scanners VOR der Extraktion
// des gemeinsamen skipString-Primitivs. Kernregel: ) , || innerhalb von '..'-Literalen (inkl. ''-Escape)
// duerfen den balancierten Scan NICHT vorzeitig beenden.
describe('SQL-Literal-Scanner (Charakterisierung)', () => {
  it(`findCalls ignoriert Klammern, Kommas und ''-Escapes in String-Literalen`, () => {
    const sql = "x(p_a => 'a) , b ''q'' c', p_b => (1+2))";
    const calls = findCalls(sql, 'x');
    expect(calls).toHaveLength(1);
    expect(calls[0].argsText).toBe("p_a => 'a) , b ''q'' c', p_b => (1+2)");
  });

  it('findCalls findet mehrere Aufrufe, jeweils balanciert', () => {
    const sql = "f('a,b') g('c)d') f('e')";
    expect(findCalls(sql, 'f').map((c) => c.argsText)).toEqual(["'a,b'", "'e'"]);
    expect(findCalls(sql, 'g').map((c) => c.argsText)).toEqual(["'c)d'"]);
  });

  it(`replacePluginFileContent ersetzt NUR p_file_content, auch bei ) , und ''-Escape im Inhalt`, () => {
    const sql = "wwv_flow_api.create_plugin_file(p_file_name=>'app.js',p_file_content=>'old, with ) paren and ''esc''')";
    const out = replacePluginFileContent(sql, 'app.js', 'NEWB64');
    expect(out).toBe("wwv_flow_api.create_plugin_file(p_file_name=>'app.js',p_file_content=>'NEWB64')");
  });

  it('replacePluginFileContent trifft die richtige Datei bei mehreren Aufrufen', () => {
    const sql = "create_plugin_file(p_file_name=>'a.js',p_file_content=>'AAA')\ncreate_plugin_file(p_file_name=>'b.js',p_file_content=>'BBB')";
    const out = replacePluginFileContent(sql, 'b.js', 'NEU');
    expect(out).toContain("p_file_name=>'a.js',p_file_content=>'AAA'");
    expect(out).toContain("p_file_name=>'b.js',p_file_content=>'NEU'");
  });
});
