## PFLICHT: Skill `devhub` benutzen — IMMER, ohne Ausnahme

Dieses Projekt wird in **devhub** geplant und dokumentiert (devhub-Projekt **"AIS Pluginpflege"**).
**Rufe bei Arbeitsbeginn — und vor jeder Planungs- oder Umsetzungsaufgabe — den Skill
`devhub` auf und befolge ihn.** Er ist der verbindliche Vertrag: devhub als Single
Source of Truth fürs Konzept, Arbeit von devhub holen statt erfinden, jede Entscheidung
sofort zurückmelden, Definition of Done. Keine Konzept- oder Umsetzungsarbeit ohne
diesen Skill.

### devhub NIE vergessen — feste Routine

devhub ist kein Schritt am Ende, sondern begleitet jede Aufgabe. Halte dich an diese
Routine, ohne dass der Nutzer dich erinnern muss:

1. **Vor der Arbeit (Pflicht-Einstieg):** Skill `devhub` aufrufen, dann den Stand holen
   (`get_tree` / `get_next_task` / `list_knowledge`). Arbeit kommt aus devhub, wird nicht erfunden.
2. **Während der Arbeit:** Status der Items pflegen (`open → in_progress → review → done`),
   Entscheidungen sofort als Wissen festhalten (`add_knowledge`), neue Anforderungen als
   Items anlegen (`create_item`).
3. **Nach JEDEM Commit (Pflicht-Abschluss):** den Code-Stand in devhub spiegeln, BEVOR
   die Antwort an den Nutzer geht. Konkret pro Änderung:
   - Fix/Feature → passendes Item bzw. `report_bug` unter dem richtigen Parent.
   - 2–4 Gherkin-Szenarien (`set_tests`), nach Verifikation abhaken (`set_test_result`).
   - Item auf `done` (`update_item`) — nur mit grünen Szenarien.
   - Lehre/Ursache → `add_knowledge`.
   **Ein Commit ohne devhub-Eintrag gilt als unfertig.**
4. **Selbstcheck am Ende jeder Antwort:** „Ist der devhub-Stand deckungsgleich mit dem
   Code/den Commits dieser Runde?" Wenn nein → erst devhub nachziehen, dann antworten.

Merksatz: **Kein Commit, kein „fertig", keine Abschlussmeldung ohne devhub.**
