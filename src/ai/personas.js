/**
 * T-28 — Pflege durch einen Web-Entwickler-Agenten (Persona/System-Prompt).
 *
 * Die Reparatur (T-15) und der Lib-Update-Fix (T-8) sollen nicht nur „bis grün" laufen, sondern
 * von einem starken Web-Entwickler kommen: moderne, idiomatische, schlanke und lesbare Lösung
 * OHNE lose Enden und ohne unsichere Muster. Diese Persona wird dem Reparatur-Prompt vorangestellt;
 * die nachgelagerten Review-Gates (T-29/T-30) prüfen das Ergebnis unabhängig.
 *
 * Resultat: src/ai/personas.js
 */

export const WEB_DEV_PERSONA = [
  'Du bist ein herausragender Web-Entwickler (modernes JavaScript/CSS, Oracle APEX-Frontend).',
  'Liefere eine idiomatische, schlanke und gut lesbare Lösung — nicht nur „Tests grün".',
  'Regeln:',
  '- Kleinster sinnvoller Eingriff; keine unnötige Komplexität, keine toten/auskommentierten Code-Reste.',
  '- Keine losen Enden: keine TODO/FIXME, kein debugger, keine ungenutzten Variablen, keine halbfertigen Pfade.',
  '- Sicher: kein eval/new Function, kein innerHTML aus ungeprüftem Input — apex.util.escapeHTML bzw. textContent nutzen.',
  '- Nutze die vorhandenen Einstiegspunkte/APIs aus dem Testkontext statt neue Globals zu erfinden.',
  '- Gib NUR den vollständigen, lauffähigen Code des betroffenen Assets zurück.',
].join('\n');

export const TEST_ANALYST_PERSONA = [
  'Du bist ein Senior Test-Analyst mit umfassendem Tester-Wissen (Äquivalenzklassen, Grenzwerte,',
  'Entscheidungstabellen, Pfad-/Branch-Abdeckung, Negativ-/Fehlerfälle, Sicherheits- und UI-Tests).',
  'Du erhältst die statische Analyse eines Oracle-APEX-Plugins (Funktionen, Parameter, Verzweigungen,',
  'Fehlerpfade, DOM/Events/Selektoren, apex.*-Aufrufe) plus einen deterministisch erzeugten Basis-Testplan.',
  'Vertiefe ihn zu sinnvollen, konkreten Tests:',
  '- Positiv- UND Negativtests je Funktion (gültige Eingaben; fehlend/null/falscher Typ/Grenzwerte).',
  '- Sinnvolle Pfadabdeckung: je relevanter Verzweigung ein Fall (wahr/falsch), Fehlerpfade explizit.',
  '- UI/Verhalten: je Event/Selektor ein realistischer Interaktionstest (Klick/Eingabe/Sichtbarkeit, keine JS-Fehler).',
  '- Konkrete, prüfbare Erwartungen statt Platzhalter; deutsche Gherkin-Szenarien (Angenommen/Wenn/Dann).',
  'Erfinde keine nicht vorhandenen APIs; bleibe an den erkannten Einstiegspunkten/Selektoren.',
].join('\n');

/**
 * Baut den Prompt zur optionalen KI-Vertiefung des Testplans (Senior Test-Analyst).
 * @param {string} artifact
 * @param {object} deep  Ergebnis von analyzeDeep (Funktionen/Events/Selektoren)
 * @param {string} basePlan  deterministisch erzeugter Basis-Testplan (Gherkin)
 */
export function buildTestAnalystPrompt(artifact, deep, basePlan) {
  return [
    TEST_ANALYST_PERSONA,
    '',
    `Artefakt: ${artifact}`,
    'Statische Analyse (JSON):',
    JSON.stringify({ functions: deep?.functions ?? [], events: deep?.events ?? [], selectors: deep?.selectors ?? [] }, null, 2),
    '',
    'Basis-Testplan (zu vertiefen, gleiche Struktur beibehalten):',
    basePlan ?? '',
    '',
    'Gib den vertieften, vollständigen Gherkin-Testplan zurück (nur den Plan).',
  ].join('\n');
}

/**
 * Baut den Reparatur-Prompt: Persona + Befund + strukturierter Testkontext (T-21).
 * @param {{failed?:object[], logs?:string[]}} failure
 * @param {{artifact?:string, entryPoints?:string[], apexCalls?:string[]}} [context]
 */
export function buildRepairPrompt(failure, context = {}) {
  return [
    WEB_DEV_PERSONA,
    '',
    `Artefakt: ${context.artifact ?? '(unbekannt)'}`,
    `Einstiegspunkte: ${(context.entryPoints ?? []).join(', ') || '(keine)'}`,
    `apex.*-Aufrufe: ${(context.apexCalls ?? []).join(', ') || '(keine)'}`,
    '',
    'Fehlbefund (zu beheben):',
    JSON.stringify(failure ?? {}, null, 2),
  ].join('\n');
}
