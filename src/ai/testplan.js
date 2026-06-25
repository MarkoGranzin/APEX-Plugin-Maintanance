/**
 * Testplan im Cucumber/Gherkin-Stil je Artefakt — analog den devhub-Szenarien.
 *
 * Aus dem deterministischen AST-Testkontext (T-21: Einstiegspunkte, apex.*-Aufrufe, DOM-Zugriffe)
 * werden Gherkin-Szenarien abgeleitet. Deterministisch (kein KI-Zwang); ein konfiguriertes KI-Backend
 * kann den Plan später anreichern. Wird beim „Prüfen" je Komponente erzeugt und angezeigt/heruntergeladen.
 *
 * Resultat: src/ai/testplan.js
 */

/** Gherkin-Feature für EIN Artefakt aus seinem (aggregierten) Analyse-Kontext. */
export function gherkinForArtifact(name, analysis = {}) {
  const eps = analysis.entryPoints ?? [];
  const apex = analysis.apexCalls ?? [];
  const dom = analysis.domAccess ?? [];
  const out = [`Funktionalität: ${name}`];

  if (eps.length === 0) {
    out.push(
      '',
      '  Szenario: Artefakt lädt ohne Fehler',
      '    Angenommen das Artefakt ist in der Seite eingebunden',
      '    Wenn die Seite gerendert wird',
      '    Dann tritt kein JavaScript-Fehler auf',
    );
  }
  for (const ep of eps) {
    out.push(
      '',
      `  Szenario: Einstiegspunkt ${ep} funktioniert`,
      '    Angenommen das Plugin ist initialisiert',
      `    Wenn ${ep} aufgerufen wird`,
      '    Dann verhält es sich wie im Golden-Master-Snapshot',
    );
  }
  if (apex.some((a) => /server\.(process|plugin)/.test(a))) {
    out.push(
      '',
      '  Szenario: Server-Callback liefert ein Ergebnis',
      '    Angenommen der APEX Server-Process ist erreichbar',
      '    Wenn apex.server.process aufgerufen wird',
      '    Dann wird die Antwort ohne Fehler verarbeitet',
    );
  }
  if (dom.length) {
    out.push(
      '',
      '  Szenario: DOM-Interaktion aktualisiert die Oberfläche',
      '    Angenommen das Ziel-Element existiert',
      '    Wenn die DOM-Logik ausgeführt wird',
      '    Dann wird das Element korrekt aktualisiert',
    );
  }
  return out.join('\n');
}

/** Kombinierter Testplan über mehrere Artefakte. @param {{name:string,analysis:object}[]} artifacts */
export function buildTestPlan(artifacts = []) {
  if (artifacts.length === 0) return '';
  return artifacts.map((a) => gherkinForArtifact(a.name, a.analysis)).join('\n\n');
}
