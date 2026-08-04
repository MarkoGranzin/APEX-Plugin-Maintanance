/**
 * T-63 — Umfassender Cucumber-Testplan aus der Tiefenanalyse (T-62).
 *
 * Je Funktion: Positivtest (Happy Path), Negativtests je Parameter (fehlt/null/falscher Typ) als
 * Szenariogrundriss, Branch-Abdeckung (Bedingung wahr/falsch) als Szenariogrundriss, Fehlerpfad-
 * Szenario (falls throws), Edge-Case-Szenario. Liefert zusätzlich eine Coverage-Kennzahl
 * (Funktionen/Branches/Parameter abgedeckt). Caps halten den Plan auch bei großen Plugins handlich.
 *
 * Resultat: src/ai/testplan-deep.js
 */

const CAP = { functions: 40, paramsPerFn: 6, branchesPerFn: 10 };

const NEG_FORMS = ['fehlt', 'null', 'undefined', 'falscher Typ'];

/** Baut den Tiefen-Testplan für EIN Artefakt. */
export function buildDeepTestPlan(artifactName, deep, opts = {}) {
  const fns = (deep?.functions ?? []).slice(0, opts.maxFunctions ?? CAP.functions);
  const lines = [`Funktionalität: ${artifactName}`, ''];
  let scenarios = 0;
  let functionsCovered = 0;
  let branchesCovered = 0;
  let paramsCovered = 0;

  // immer: lädt ohne Fehler
  lines.push('  Szenario: Artefakt lädt ohne JavaScript-Fehler (Positiv)');
  lines.push('    Angenommen das Artefakt ist in der Seite eingebunden');
  lines.push('    Wenn die Seite gerendert wird');
  lines.push('    Dann tritt kein JavaScript-Fehler auf');
  lines.push('');
  scenarios++;

  for (const f of fns) {
    functionsCovered++;
    const params = f.params.slice(0, CAP.paramsPerFn);
    const sig = params.length ? `(${params.join(', ')})` : '()';

    lines.push(`  # ── ${f.name} ${sig} ──`);

    // Positiv
    lines.push(`  Szenario: ${f.name} mit gültigen Eingaben (Positiv)`);
    lines.push(`    Angenommen das Plugin ist initialisiert${params.length ? ` und gültige Werte für ${params.join(', ')}` : ''}`);
    lines.push(`    Wenn ${f.name}${sig} aufgerufen wird`);
    lines.push('    Dann läuft es ohne Fehler und verhält sich wie im Golden-Master');
    lines.push('');
    scenarios++;

    // Negativ je Parameter (Szenariogrundriss)
    if (params.length) {
      lines.push(`  Szenariogrundriss: ${f.name} — ungültiger Parameter <param> (Negativ)`);
      lines.push('    Angenommen <param> ist <wert>');
      lines.push(`    Wenn ${f.name} aufgerufen wird`);
      lines.push('    Dann wird der Fehler sauber behandelt (kein Absturz, definierte Reaktion)');
      lines.push('    Beispiele:');
      lines.push('      | param | wert |');
      for (const p of params) {
        for (const form of NEG_FORMS) lines.push(`      | ${p} | ${form} |`);
        paramsCovered++;
      }
      lines.push('');
      scenarios += params.length * NEG_FORMS.length;
    }

    // Branch-Abdeckung (Szenariogrundriss)
    const branches = Math.min(f.branches, CAP.branchesPerFn);
    if (branches > 0) {
      lines.push(`  Szenariogrundriss: ${f.name} — Pfadabdeckung Verzweigung <nr> (<bedingung>)`);
      lines.push('    Angenommen Eingaben, die Verzweigung <nr> auf <bedingung> bringen');
      lines.push(`    Wenn ${f.name} aufgerufen wird`);
      lines.push('    Dann wird der erwartete Zweig durchlaufen');
      lines.push('    Beispiele:');
      lines.push('      | nr | bedingung |');
      for (let i = 1; i <= branches; i++) {
        lines.push(`      | ${i} | wahr |`);
        lines.push(`      | ${i} | falsch |`);
        branchesCovered++;
      }
      lines.push('');
      scenarios += branches * 2;
    }

    // Fehlerpfad
    if (f.throws > 0) {
      lines.push(`  Szenario: ${f.name} wirft bei ungültigem Zustand einen definierten Fehler (Negativ)`);
      lines.push('    Angenommen ein ungültiger Zustand/ungültige Eingabe');
      lines.push(`    Wenn ${f.name} aufgerufen wird`);
      lines.push('    Dann wird ein aussagekräftiger Fehler geworfen und nicht verschluckt');
      lines.push('');
      scenarios++;
    }

    // DOM/Events
    for (const ev of f.events) {
      lines.push(`  Szenario: ${f.name} — Event ${ev.type}${ev.selector ? ` auf ${ev.selector}` : ''} reagiert (UI)`);
      lines.push(`    Angenommen das Element${ev.selector ? ` ${ev.selector}` : ''} ist vorhanden`);
      lines.push(`    Wenn das Event ${ev.type} ausgelöst wird`);
      lines.push('    Dann reagiert das Plugin korrekt und ohne JavaScript-Fehler');
      lines.push('');
      scenarios++;
    }

    // Edge
    lines.push(`  Szenario: ${f.name} mit Grenzwerten (Edge: leer / sehr groß / Sonderzeichen)`);
    lines.push('    Angenommen Grenzwert-Eingaben');
    lines.push(`    Wenn ${f.name} aufgerufen wird`);
    lines.push('    Dann bleibt das Verhalten stabil und definiert');
    lines.push('');
    scenarios++;
  }

  const coverage = {
    functions: deep?.totals?.functions ?? fns.length,
    functionsCovered,
    branches: deep?.totals?.branches ?? 0,
    branchesCovered,
    params: deep?.totals?.params ?? 0,
    paramsCovered,
    scenarios,
  };
  return { feature: lines.join('\n'), coverage, scenarioCount: scenarios };
}

/** Verdichtet mehrere Artefakt-Pläne zu einem .feature + Gesamt-Coverage. */
export function combineDeepPlans(plans) {
  const feature = plans.map((p) => p.feature).join('\n');
  const coverage = plans.reduce(
    (a, p) => ({
      functions: a.functions + p.coverage.functions,
      functionsCovered: a.functionsCovered + p.coverage.functionsCovered,
      branches: a.branches + p.coverage.branches,
      branchesCovered: a.branchesCovered + p.coverage.branchesCovered,
      params: a.params + p.coverage.params,
      paramsCovered: a.paramsCovered + p.coverage.paramsCovered,
      scenarios: a.scenarios + p.coverage.scenarios,
    }),
    { functions: 0, functionsCovered: 0, branches: 0, branchesCovered: 0, params: 0, paramsCovered: 0, scenarios: 0 },
  );
  return { feature, coverage };
}
