---
name: devhub
description: Use when working in a project whose concept/backlog is managed in devhub — pulling the next slice/task via MCP, reporting status and verified test results back, and sending every design decision to devhub (the single source of truth for the concept). Covers the MCP tools, the vibe-coding loop, and the rules (locks, test gate, knowledge anchors, definition of done).
---

# devhub — die Single Source of Truth fürs Konzept

devhub verwaltet Konzept, Backlog, Tests und Wissen dieses Projekts. Es gilt ein
VERTRAG in beide Richtungen — unabhängig davon, auf welchem Rechner devhub läuft
(die Verbindung kommt aus der .mcp.json; die Tools heißen `mcp__devhub__*`;
Projekte, Slices und Items sind per NAME/CODE ansprechbar, z.B. Slice "MVP-Login", Task "T-12"):

## Zugang: devhub-Tools laden ODER CLI (ad-hoc)
Die `mcp__devhub__*`-Tools können im Client „deferred" sein (nicht sofort aufrufbar). Dann ZUERST per
ToolSearch laden (z.B. `select:mcp__devhub__claim_work`), DANN aufrufen — NIEMALS einen Bug „Tool nicht
verfügbar" anlegen; das Tool ist da, es muss nur geladen werden. (Claimen/Status brauchen KEINE KI.)

Alternativ die **CLI** — ad-hoc/headless, token-sparsam (kompakte Ausgabe statt Volltext), auch remote
auf dem Arbeitsrechner; gleiche DB/Logik wie MCP/Web. Aufruf aus jeder Session:
```
npx tsx D:/Firma/dev/src/cli.ts <verb> …        # oder im devhub-Repo: npm run devhub -- <verb> …
# Loop:  claim <project> <slice> · next <project> · status <project>
#        result <project> <item> <scenario> passed|failed|skipped · done <project> <item> · release <project> <slice>
#        <mcp_tool> key=value …   (generischer Passthrough; --full = Rohdaten)
# Lokal: sbom <project> [repo-pfad] · import <repo-pfad> [name] · test <project> <item>
```
Maschinen-lokale Funktionen (sbom/import/test) MÜSSEN dort laufen, wo das Repo liegt → dafür die CLI.

**RICHTUNG 1 — alles Konzept-Relevante geht ANS Tool (Pflicht):**
Jede Design-Entscheidung, jede erkannte Anforderung, jedes Gotcha aus der Arbeit
wird SOFORT nach devhub gemeldet — nie nur im Code-Kommentar, Chatverlauf oder
lokalen Dateien belassen. devhub ist die einzige Wahrheit über das Konzept;
der Code ist das Resultat, nicht die Dokumentation.
- Entscheidungen/Erkenntnisse: `add_knowledge` (genau EIN Anker: Task/Feature/Epic,
  Skill oder Projekt) oder `intake_knowledge` (Anker wird automatisch bestimmt).
- Neue/geänderte Anforderungen: `create_item` / `update_item` (+ `set_tests` für
  die Akzeptanz-Szenarien) — erst prüfen (`get_tree`, `search_knowledge`), keine Duplikate.
- Zielbild-Änderungen: `update_vision` / `add_mockup`.
- **Glossar (Begriffe) beachten:** Vor der Vergabe von Namen (Items, Slices, Code-Bezeichner, Felder)
  das Projekt-Glossar prüfen und die dort definierten Begriffe konsistent verwenden (analog LOVs).
  Neue verbindliche Begriffe gehören ins Glossar (im Wissen-Tab) — nicht freihändig abweichende Synonyme nutzen.

**RICHTUNG 2 — Arbeit kommt VOM Tool (Vibe-Coding-Loop):**
1. `get_workspace` → Projekt; `search_knowledge` + `get_short_term_memory` → Kontext laden.
2. Nächste Arbeit abfragen — in dieser Reihenfolge:
   a) `list_slices` → der nächste FREIE Slice (kleinste Ordnungsnummer, lock_state none,
      nicht fertig) → `claim_work(project, slice)` — Lock + komplettes Arbeitspaket
      (Items, Szenarien, Pfad-Wissen, Kurzzeitgedächtnis). `claim_work` setzt die offenen
      Tasks/Bugs des Slices dabei automatisch auf "in Arbeit" (Board/Report stimmen sofort).
   b) Kein freier Slice mehr? `get_next_task` → einzelne freie Tasks abarbeiten.
   c) Auch nichts? Dem Nutzer melden — NICHT selbst Arbeit erfinden.
3. Pro Task: VOR der ersten Codeänderung `update_item(status: in_progress)` (falls nicht
   schon durch claim_work geschehen) → umsetzen → Szenarien mit
   `set_test_result` abhaken (NUR echt Verifiziertes!) → `update_item(status: done)`.
   devhub MELDET ZURÜCK: das Test-Gate verweigert "done" bei offenen/fehlgeschlagenen
   Szenarien, LOCKED heißt "gehört gerade jemand anderem" — Antworten auswerten, nie umgehen.
4. Unterwegs: Erkenntnisse melden (Richtung 1), Bugs per `report_bug`, Unklarheiten
   `update_item(status: clarify, responsibleUsername: ...)` und am nächsten Task weiter.
5. Slice fertig (alle Tasks done inkl. Tests): `release_claim` + Abschluss-Erkenntnis.
   Danach zurück zu Schritt 2 — devhub bestimmt, was als Nächstes dran ist.

## Offene Punkte (Triage — wenn der Nutzer ein Problem, eine Lücke oder Idee meldet)
Erledige die Triage VOLLSTÄNDIG selbst, ohne Rückfragen:
1. ORIENTIEREN: `get_tree` + `search_knowledge` — gehört der Punkt zu etwas Existierendem?
2. ZUORDNEN:
   a) Fehlverhalten an bestehendem Task → `report_bug` mit dem Task als parent; zusätzlich
      ein Soll-Szenario via `set_tests` am betroffenen Task (Status offen lassen).
   b) Fehlende Fähigkeit an bestehendem Feature → neuer Task unter diesem Feature.
   c) Ganz Neues → unter dem fachlich passendsten Epic (notfalls neues Feature) Task/Bug anlegen.
   d) Wirklich unklar → Task unter dem plausibelsten Epic, `update_item(status: clarify,
      responsibleUsername: <Melder>)` — der Mensch entscheidet.
3. TESTS SIND PFLICHT: jeder neue Task/Bug bekommt SOFORT 2-4 Gherkin-Szenarien (`set_tests`).
4. Steckt eine Entscheidung/Erkenntnis im Punkt → `add_knowledge` am passenden Anker.
5. Kurz berichten: was wo angelegt/zugeordnet wurde (Codes) und WARUM dort.
Erst prüfen, keine Duplikate; nichts auf "fertig" setzen; Slices nicht anfassen.

## Planung (wenn der Nutzer entwerfen will)
- Hierarchie: epic → feature → task/bug; `create_slice` (Name pflichtig+eindeutig,
  order_no doppelt erlaubt = parallel), `assign_to_slice`.
- Tests als Gherkin (deutsch: Angenommen/Wenn/Dann) per `set_tests`.
- Beschreibung umgesetzter Tasks trägt die Konvention "Resultat: <Code-Ort>".
- Nach der Planung: `commit_concept` — generiert Tests für ungedeckte Tasks und
  aktiviert die Regel "ohne Tests startet kein Task" (kein Einfrieren des Backlogs).

## Pool & Secrets
- `get_pool` liefert zugewiesene Skills/Agenten-Vorlagen — gelten als Arbeitsregeln.
- `get_connection(name)` ist der EINZIGE Weg an Verbindungsdaten/Secrets —
  Secrets niemals ausgeben, loggen oder weiterschicken.

## Definition of Done (verbindlich — erst dann `update_item(status: done)`)
Ein TASK ist fertig, wenn ALLE Punkte erfüllt sind:
1. Die Umsetzung ist vollständig und liegt am dokumentierten Ort — die Beschreibung
   enthält/aktualisiert die Zeile "Resultat: <Code-Ort>".
2. ALLE Gherkin-Szenarien des Tasks sind ECHT VERIFIZIERT abgehakt: `passed` nur
   nach tatsächlicher Prüfung (Test gelaufen / Verhalten beobachtet), niemals auf
   Verdacht; nicht Prüfbares bewusst `skipped` mit Begründung im Gherkin/Wissen;
   Fehlschläge als `failed` mit verknüpftem Bug (`linkedBug`). Das Gate erzwingt das —
   es ist Hilfe, kein Hindernis.
3. Der Mock-Zustand stimmt: läuft die Umsetzung noch gemockt, bleibt `mock_state`
   auf `mock_active` sichtbar — ein Task mit aktivem Mock ist nur fertig, wenn das
   ausdrücklich so geplant ist (Mock-Variante = eigenes Arbeitspaket).
4. Erkenntnisse, Entscheidungen und Gotchas aus der Arbeit sind per `add_knowledge`
   am richtigen Anker gesichert — nichts bleibt nur im Chatverlauf.
5. Entdeckte Probleme sind gemeldet: Bugs per `report_bug`, offene Fragen als
   `clarify` mit Verantwortlichem — nichts stillschweigend liegen lassen.

Ein SLICE ist fertig, wenn: alle seine Tasks die DoD erfüllen, eine kurze
Abschluss-Erkenntnis am Slice-Kontext gesichert ist und `release_claim` den Lock
freigegeben hat.

## Regeln
- Fehler kommen strukturiert zurück (`{error:{code,message}}`) — auswerten, nicht raten.
  LOCKED = jemand anderes arbeitet dort; FORBIDDEN = kein Projektzugriff;
  TESTS_INCOMPLETE = erst Szenarien anlegen/abhaken.
- Locks anderer Nutzer respektieren; manuelles Lösen macht nur der Mensch in der UI.
- Erst prüfen (`get_tree`, `search_knowledge`), dann anlegen — keine Duplikate.
