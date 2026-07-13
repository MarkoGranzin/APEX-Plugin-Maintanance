# Vision — AIS Pluginpflege

**AIS Pluginpflege** — Service mit Web-GUI, der Oracle-APEX-Plugins & Template Components aus mehreren Git-Repos (GitHub/lokal) automatisch pflegt: einlesen, mit **stabilen Tests** absichern, wöchentlich auf veraltete *und* nicht mehr gepflegte Bibliotheken prüfen, sichere Updates durchführen, per **Pull Request** ausliefern und einen E-Mail-Report mit Git-Link + Änderungsbeschreibung senden. History und Repo-Verwaltung in der GUI.

**Leitprinzip (aus der Architektur-Runde):** *Deterministische Pipeline mit KI nur an den Urteils-Stellen.* Scheduler → Inventar/SBOM → Dep-/Risiko-Scan → Test-Runner sind deterministisch und nachvollziehbar; KI sitzt nur dort, wo Urteil nötig ist (Testvorschläge, Reparatur, Report-Texte, Risiko-Bewertung) und ist über einen Provider-Adapter (CLI **oder** API-Key) austauschbar.

**Tragende Säulen:**
- **SBOM statt Manifest:** APEX-Plugins haben kein package.json, JS/CSS liegt vendored vor → Bibliotheken per Fingerprinting erkennen, Ergebnis als CycloneDX-SBOM je Artefakt (eine SBOM, mehrere Auswertungen).
- **Normalisierung in beide Richtungen:** jedes Artefakt wird vor allem anderen in EIN kanonisches Bündel extrahiert (format-blind) — und nach Fix/Update über die sourceMap **byte-genau wieder ins Original-Format zurückgeschrieben** (Re-Injektion). Ohne diese Gegenrichtung lässt sich kein SQL-Export-Plugin liefern.
- **Stabile Tests, zweigeteilt:** PL/SQL → utPLSQL, JS/Render → jsdom-Shim (Default) bzw. Playwright (laufzeitgebunden); Golden-Master-Snapshots + Quarantäne (neuer Test erst nach 3× grün ins Gate).
- **Risiko ≠ Update:** „nicht mehr gepflegt" ist eine quittierbare Warnung (eigener Block), die das Update-Gate nicht blockiert.
- **Sicheres Loopen:** bei Rot begrenzte KI-Reparatur auf Arbeits-Branch; bei finalem Rot kein PR, roter Report.
- **Ein Lauf als Zustandsautomat:** jedes Artefakt durchläuft Scan→Extrakt→Test→Update→Re-Injektion→PR→Mail; Teil-Fehler isolieren ein Artefakt statt den Lauf, Resume nach Crash, höchstens ein offener PR je (Artefakt+Lib+Version), genau ein gebündelter Report je Lauf.
