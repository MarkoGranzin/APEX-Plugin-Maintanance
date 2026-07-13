# Wissen / Entscheidungen — AIS Pluginpflege (devhub-Export)

136 Einträge. Reale Infrastruktur-Bezeichner sind redigiert (`<instance>`, `<region>`, `<workspace-id>`).


## Projekt-Wissen (18)

### Kernregeln: Test-Gate vor Push, keine Secrets im Report, KI-Backend wählbar
_2026-06-24 12:49:53 · Tags: leitplanken,architektur,sicherheit_

Verbindliche Leitplanken aus der Erstdiskussion:\n1) Kein Re-Upload (Push) ohne grünen Testlauf — bei rot Rollback + Fehler melden.\n2) Report-Mail enthält nie Klartext-Secrets (API-Keys/Git-Tokens verschlüsselt, in Anzeige maskiert).\n3) KI-Backend ist wählbar: lokale CLI ODER Provider+API-Key (einheitliche Aufruf-Abstraktion).\n4) Auslöser: wöchentlicher Scheduler + manueller Trigger; pro Repo kein Doppellauf.\n5) Jeder Lauf landet in der History; der Report listet aktualisierte Artefakte mit Git-Link + Änderungsbeschreibung.

### Slice 23 (MVP Repo→Inventar→Tests) abgeschlossen — Node-Pipeline steht, 63 Tests grün
_2026-06-24 15:14:09 · Tags: slice-23,mvp,abschluss,pipeline,architektur_

Slice 23 vollständig umgesetzt (Node 24, ESM, Vitest). Durchgehende Pipeline:
repo (T-1, src/repo/repository.js, simple-git, Auth nie persistiert) → inventory (T-2 src/inventory/inventory.js) → format/Test-Pfad (T-18 src/inventory/format.js) → diff/Trigger (T-3 src/diff/diff.js) → kanonische Extraktion + sourceMap (T-19 src/extract/extract.js) → AST-Testkontext (T-21 src/extract/analyze.js, acorn) → Testebene-Wahl jsdom/Playwright (T-22 src/test/testenv.js + apexShim.js) → Static-First Lint/retire/Snapshot (T-23 src/test/static.js) → KI-Testgenerierung initial+Delta (T-4/T-5 src/ai/generate.js, Backend-Abstraktion src/ai/backend.js) → Gate (T-6 src/run/gate.js) → Selbstheilung (T-15 src/run/heal.js) → Quarantäne/Flaky/Rollentrennung (T-17 src/run/quarantine.js).
Offene Anschlüsse für Folge-Slices: KI-Backend real verdrahten (Slice 26/T-11+T-12, T-4/T-5 stehen auf mock_active); Re-Injektion über sourceMap (T-25, Slice 24); SBOM-Fingerprinting (T-7, Slice 24); Lauf-Orchestrierung als Zustandsautomat, die diese Bausteine verkettet und generierte Vitest/jsdom-Suites real ausführt (T-27, Slice 25). Alle Bausteine sind über opts injizierbar (ai/runner/git) → testbar ohne Netz/Instanz.

### Slice 26 (KI-Konfig & Secrets) abgeschlossen — Backend umschaltbar, Secrets verschlüsselt
_2026-06-24 15:18:01 · Tags: slice-26,abschluss,ki-backend,secrets_

Slice 26 fertig. T-11: src/ai/backend.js um createBackend/cliBackend/providerBackend erweitert — einheitliche Schnittstelle {kind, complete, testConnection, requiresApiKey}, CLI ohne Key (spawn injizierbar), Provider mit Bearer-Key (http injizierbar), ungültiger/fehlender Key blockiert produktive Läufe. T-12: src/config/secrets.js (AES-256-GCM+scrypt, SecretStore, mask) — Persistenz nur Chiffrate, maskierte Anzeige, falscher Master-Key scheitert; src/config/settings.js (Repos/Empfänger/Cron/KI-Backend, Repos nur mit secretRef). Damit ist der in Slice 23 als Seam gebaute KI-Aufruf (ai/backend.js stubBackend) jetzt mit echten Backends bestückbar; die Verdrahtung in den End-to-End-Lauf passiert in der Orchestrierung T-27 (Slice 25). Secret-Auflösung im Betrieb weiter über devhub get_connection / SecretStore — nie Klartext loggen.

### Slice 24 (Wächter: Update→Push→Mail) abgeschlossen — Round-Trip & Auto-Update stehen
_2026-06-24 15:27:09 · Tags: slice-24,abschluss,auto-update,re-injektion,report_

Slice 24 fertig (108 Tests gesamt grün). Bausteine: T-25 Re-Injektion (src/extract/reinject.js, Round-Trip byte-identisch, minimaler Diff, extraktion-unsicher→manuell); T-7 SBOM-Fingerprinting (src/sbom/sbom.js, CycloneDX, Update-Check); T-16 Risiko-Score+Quittierung (src/sbom/risk.js, blockiert Gate nicht, Verschärfung reaktiviert); T-8 Auto-Update (src/run/update.js, applyUpdate→selfHeal→nur grün→Push als PR); T-26 PR-Dedup/Idempotenz (src/run/dedup.js, stabiler branchKey, kein Doppel-PR/-Push); T-9 Report-Mail (src/report/mail.js, alle Empfänger, keine Secrets, redact); T-10 Lauf-History (src/report/history.js, idempotent, Filter/Detail). Alles injizierbar (push/transport/applyUpdate/ai/runner). Offen für Slice 25 (T-27): die Lauf-Orchestrierung als Zustandsautomat, die diese Bausteine + Slice-23-Pipeline real verkettet (Scan→Extrakt→Test→Update→Re-Injektion→PR→Mail) inkl. Resume; GUI/Scheduler (T-13/T-14/T-24).

### Slice 25 (Service, Scheduler & GUI) abgeschlossen — alle 4 Slices fertig, 122 Tests grün
_2026-06-24 15:32:11 · Tags: slice-25,abschluss,orchestrierung,scheduler,gui,projekt-komplett_

Slice 25 fertig → das gesamte Backlog ist umgesetzt (4/4 Slices). T-13 Scheduler (src/service/scheduler.js, wöchentlich fällig + manuell, kein Doppellauf je Repo via Serialisierung/Queue); T-27 Orchestrierung (src/run/orchestrate.js, Zustandsautomat je Artefakt, Teil-Fehler-Isolation, Resume ab persistiertem Zustand, EIN Report + EIN History-Eintrag je Lauf); T-14 Dashboard (src/gui/dashboard.js, View-Model Repos/Status/letzter-Lauf/Jetzt-prüfen); T-24 Triage (src/gui/triage.js, Steckbrief+Triage-Liste unklar-oben+1-Klick-Korrektur, ruhige Inkonsistenz-Kennzahl, Rot nur für Risiko). T-27 ist das Rückgrat, das Slice 23 (Extraktion/AST/Tests/Gate/Heilung) + Slice 24 (SBOM/Risk/Update/Re-Injektion/PR-Dedup/Report/History) + Slice 26 (KI-Backend/Secrets) über injizierbare Steps verkettet. Gesamt: 20 Testdateien, 122 Tests grün. Nur GUI-Präsentation (HTML/Server) und echte externe Backends (Provider-HTTP, SMTP, ephemere APEX-Instanz/Playwright, T-20 Inline-PL/SQL) sind bewusst als Adapter/Folgearbeit offen — die gesamte Logik ist deterministisch testbar gekapselt.

### QA-Durchlauf der Pflege-Software: 198 Unit + 23 E2E grün; Bibliotheks-Sicht + Warn-Badge verifiziert
_2026-06-24 19:05:47 · Tags: qa,e2e,verifikation,abschluss_

Vollständiger QA-Lauf gegen den laufenden Dienst (qa-e2e.mjs, danach entfernt): GUI-Skript syntaxgeprüft (node --check) + 23 End-to-End-Checks über alle Endpunkte (/, /readme.html, settings GET/PUT, components CRUD, assign-repo öffentlich + 400 ohne source, run→lastLog, libraries→libWarning, review-gate, update→PR, run-all, notes, 404-Fälle, delete) — 23/23 PASS; plus 198 Unit-Tests grün. Bestätigt u.a.: B-1 (Crash bei Review ohne Repo) behoben; F-23 Bibliotheks-Übersicht zeigt verwundbare/nicht-gepflegte Libs, libWarning erscheint bei Verwundbarkeit und VERSCHWINDET nach erfolgreichem Auto-Update (Lib im PR-Branch gebumpt) — gewolltes Verhalten. Kein offener Software-Fehler. Hinweis: /api/components/:id/open (Explorer) wurde im automatisierten QA bewusst ausgelassen (öffnet Fenster).

### GUI-Vereinfachung + Auto-Repair/Push dauerhaft AN (Nutzerentscheidung)
_2026-06-25 20:22:14_

Nutzerwunsch (2026-06-25): „mach es eindeutig, unnötige Buttons raus, die Checkboxen will ich eigentlich immer". Umgesetzt: (1) Drawer-Gruppe „Writes files / Git" von 4 auf 2 Buttons reduziert — „⬆ Update libs to latest" (safe direkt; breaking → Force/verifizierte Migration) und „📤 Upload (branch + PR)". Die Fix-/AI-Review-Aktionen leben nur noch in „🧰 Full maintenance now" (waren Teilmengen). (2) Settings-Checkboxen autoRepair + allowPush ENTFERNT; beide werden in start.js beim Start dauerhaft auf true gezwungen (settings.autoRepair=true; settings.allowPush=true) — unabhaengig vom persistierten Wert. WICHTIG/SICHERHEIT: Push ist damit IMMER erlaubt. Interaktiver Upload fragt weiterhin per confirm; ABER der wöchentliche Scheduler-Job pusht jetzt bei grüner Pflege autonom ohne Rückfrage. Falls unerwünscht: Scheduler-Push wieder gaten. QA-HINWEIS: Da allowPush jetzt default an ist, MUSS QA weiterhin AISPP_DATA_DIR setzen UND allowPush zur Laufzeit per PUT auf false setzen (Force at-load gilt nur beim Start, Runtime-PUT überschreibt). lib-update Reststrings auf EN. Build 2026-06-25.13.

### KI-Mock: warum „still statisch" — und die drei Härtungen
_2026-06-26 11:17:51_

Symptom: trotz aiReady=true kam für ApexFlowChart nur der statische Mock. Diagnose immer am LAUFENDEN Dienst read-only: /api/health (Build/Playwright/aiReady) + /api/ai/test (echter CLI-Aufruf). Hier war /api/ai/test ok=false „claude not callable" — der Server-Prozess fand die gebündelte claude.exe nicht, weil seine env APPDATA/USERPROFILE nicht wie erwartet hatte.

Drei Härtungen (gehören zusammen):
1) NIE still zurückfallen: generateAiMock liefert fallbackReason; comp.mockMode/mockNote werden persistiert und die GUI zeigt „Auto-mock [AI-written | static fallback — <Grund>]". Ohne sichtbaren Grund sucht man am falschen Ende.
2) KI-Antwort säubern: Modelle stellen der HTML gern Prosa voran („I now understand…") und packen ```-Fences drumherum. generateAiMock entfernt Fences und extrahiert das Dokument von erstem <!doctype>/<html> bis letztem </html>; fehlt der window.__ok-Vertrag, wird er injiziert.
3) CLI robust auflösen: findBundledClaude nutzt env-Pfade UND os.homedir() UND scannt notfalls alle Profile unter C:\Users\*\AppData\{Roaming,Local}\Claude\claude-code (höchste Version gewinnt) — findet die exe selbst bei leerer env. Sofort-Workaround für Nutzer: in Settings den absoluten claude.exe-Pfad eintragen.

Lehre: „aiReady" am Health-Endpoint heißt nur „Backend konfiguriert", nicht „CLI wirklich aufrufbar". Für KI-Features immer /api/ai/test (echter Spawn) prüfen.

### Statischer Mock trotz korrektem Code: lang laufender Server-Prozess kann claude nicht spawnen (ENOENT) → Neustart
_2026-06-26 11:39:22_

Beim Live-Test (ApexFlowChart importieren → Mock validieren) kam trotz Build .10 (mit robustem findBundledClaude) wieder der STATISCHE Mock. Ursache war diesmal NICHT der Code, sondern der lang laufende Server-PROZESS:

Diagnose (read-only, am laufenden Dienst):
- /api/health: build .10, aiReady=true.
- /api/ai/test: ok=false. Erst „CLI 'claude' not callable" (bares claude über cmd nicht gefunden), nach Eintragen des absoluten Pfads dann: „spawn C:\\…\\claude.exe ENOENT" — obwohl die Datei existiert.
- Gegenprobe: ein FRISCH gestarteter node-Prozess (auch der System-Node v24, sogar mit komplett leerer env) spawnt dieselbe claude.exe problemlos → exit 0, „2.1.181". Nur der alte Server-Prozess (PID, gestartet in einer früheren Sitzung) bekam ENOENT.

Schluss: der Server-Prozess war in einem kaputten Zustand (stale state — vermutlich ungültig gewordenes Arbeitsverzeichnis/Handles aus einer früheren Sitzung). Kein Code-, Pfad- oder env-Problem.

Lösung: Server NEU STARTEN (Prozess auf Port beenden, dann `node start.js serve` frisch aus dem Projektverzeichnis). Danach /api/ai/test ok=true, Re-Import → mockMode=ai (kein Fallback), Mock rendert echten mxGraph-Flowchart mit 8 Daten-Zeilen, __ok=true/__rendered=true/0 Fehler.

Merksatz: Wenn die KI-CLI plötzlich „not callable/ENOENT" ist, obwohl ein frischer node-Prozess sie startet → SERVER NEU STARTEN, nicht den Code suchen. Diagnose-Rezept: frischen node-Spawn der exe gegen den Server-Prozess gegentesten. [[ki-mock-warum-still-statisch]]

### works-as-before-Gate: grüner Browser-Render ≠ grüne Playwright-Baseline (2 Fallen)
_2026-06-26 12:30:34_

Wenn die Migration mit „Mock baseline not green" übersprungen wird, der Mock aber im Browser grün rendert, liegt es fast sicher an der Baseline-MESSUNG, nicht am Plugin:

1) Playwright lehnt eine Spec-Datei mit DOPPELTEN test()-Titeln komplett ab → 0 Szenarien → Baseline 0/0 → noGreenBaseline. Generatoren müssen Titel eindeutig halten (dedupe Selektoren/Events + uniqueTitle-Guard).

2) __ok-Race: Mocks setzen window.__ok unterschiedlich (spät gesetzt vs. früh false→true). Auf `__ok !== undefined` zu warten greift beim false-Initialwert zu früh. Richtig: auf `__ok === true` warten (Timeout), bei Timeout finalen Wert lesen.

Diagnose-Rezept: /api/components/:id/ui-tests liefert den ROH-Playwright-Output → dort sieht man „duplicate test title" bzw. die fehlgeschlagene __ok-Assertion. Headless-Gegenprobe: chromium.launch + goto + waitForTimeout(1500) + window.__ok/__rendered dumpen.

Wichtig: /testplan-Regeneration ersetzt codedTests komplett und VERDRÄNGT den Mock-Spec → Reihenfolge: erst /testplan (Codegen-Specs), DANN Mock-Rebuild (fügt Mock-Spec wieder hinzu). Bestätigt: danach Baseline grün, Migration adoptiert verifiziert. Siehe Commit d4843e7. [[ki-mock-warum-still-statisch]]

### GUI: „läuft gerade" serverseitig via /api/running (nicht nur Frontend-BUSY)
_2026-06-26 12:46:23_

Der Frontend-BUSY-Spinner zeigte nur in DIESEM Tab gestartete Aktionen — nach Reload oder bei woanders/per API gestartetem Lauf war nicht sichtbar, dass etwas läuft (führte zu „läuft das noch?"-Verwirrung). Lösung (F-29): Server hält ein RUNNING-Set (in start.js), das die langen Operationen via withComponentRunning markiert (assign-repo/update/baseline/redevelop/autofix/maintain/ui-tests); GET /api/running liefert die IDs. Die GUI pollt alle 2,5s und mergt das in den Zeilen-Spinner (SRUN ∪ BUSY) + Label „running…". Damit ist „läuft gerade" robust und überlebt Reloads. Analog: nach „Save" eines Repo-Imports schließt der Dialog sofort und ein zentrales Overlay zeigt „Cloning … & building mock…" bis assign-repo fertig ist, dann load(). [[works-as-before-gate-gruener-browser-render-ne-gruene-playwright-baseline]]

### Gated-Adopt: „🚀 rebuilt" trotz alter Lib-Badges ist korrekt (Migration liegt auf Branch, nicht gemergt)
_2026-06-26 12:58:40_

Beobachtung beim Live-Upgrade von ApexFlowChart: nach erfolgreichem Lauf steht rebuilt=true/verifiedAsBefore=true mit rebuiltTo=jquery@4.0.0/jsonpath@1.3.0/mxgraph@4.2.2 — die LIBRARIES-Spalte und die Badges zeigen aber WEITER die alten Versionen (jquery 1.12.4, mxgraph unbekannt, „1 vulnerable/outdated").

Das ist KEIN Fehler, sondern das gated-Adopt-Design: redevelopComponent committet die verifizierte Migration auf einen Review-Branch (aisp/pflege-<ts>) und ruft uploadFor(true). Bei allowPush=false (QA bzw. Default-Sicherheit ohne Bestätigung) wird NICHT in die Arbeitskopie/master gemergt oder gepusht. Die Lib-Erkennung scannt aber die Arbeitskopie (master) → zeigt die alten Versionen. Erst nach Merge/Push des Branches (Upload, bestätigungspflichtig) + erneutem „Check" verschwinden die Badges.

Lesart: „🚀 rebuilt" = „verifizierte Migration liegt bereit (auf Branch)", nicht „live übernommen". Für QA wichtig (siehe [[qa-niemals-push-endpoints-live]]): so bleibt die Migration prüfbar, ohne ungefragt das echte Plugin zu verändern. Mögliche UX-Verbesserung (offen): rebuiltTo-Versionen direkt anzeigen bzw. Hinweis „merge to apply" am Badge. Bestätigt im Live-Lauf, Build .12.

### E2E-Verifikation an großem Plugin: Material-Kanban-Board (Import→Mock→Upgrade)
_2026-06-26 13:32:37_

Voller GUI-Durchlauf am großen Plugin McRange/Material-Kanban-Board (Build .13) erfolgreich:
- IMPORT: „+ Plugin" → URL → Save → Dialog zu + Overlay „Cloning … & building mock…" (F-29) → Liste aktualisiert; Klon+KI-Mock ~100s.
- MOCK-KONTROLLE: „Open mock" (Listen-Button, F-29) → /mock/material-kanban-board/ rendert ein vollständiges Material-Kanban-Board mit 3 Spalten und 19 Beispielkarten; Statuszeile __ok=true/__rendered=true/kb-cards=19/errors=0. Die KI hat das große Plugin analysiert und einen funktionierenden Mock mit realistischen Daten geschrieben.
- UPGRADE: „Full maintenance now" → „running…"-Indikator (F-29, serverseitig). Breaking Libs erkannt (1 vulnerable, 1 outdated) → KI-Migration ~17,5 Min → works-as-before-Gate grün → ADOPT: rebuilt=true, verifiedAsBefore=true, migriert auf bootstrap 5.3.8, font-awesome 4.7.0, jquery 4.0.0 (3 Assets). Review-Branch aisp/pflege-20260626133108, allowPush=false → kein Push (Commit nur lokal).

Belegt, dass die Pipeline (F-28 Mock/Gate + F-29 GUI) auch bei großen, andersartigen Plugins (Kanban statt Flowchart) trägt — generischer KI-Mock + verifizierte Migration. Gated-Adopt-Nuance wie gehabt: Lib-Badges zeigen weiter alt, weil die Migration auf dem Branch liegt (siehe [[gated-adopt-rebuilt-trotz-alter-lib-badges-ist-korrekt-migration-liegt-auf-branch-nicht-gemergt]]).

### Standalone-Pflege: fullMaintain ist die eine Orchestrierung (Button = Scheduler = Cron)
_2026-06-26 14:28:03_

Das Tool pflegt jetzt standalone vollständig. Eine Funktion fullMaintain(component,{autoUpload}) in start.js kapselt die komplette Pflege: Mock sicherstellen → maintainComponent (check/safe-updates/autofix/re-test) → bei breaking Libs Baseline gegen den Mock + redevelopComponent (B-17: tauscht Libs real, verifiziert „wie zuvor") → adopt/rollback. Darauf zeigen ALLE Auslöser:
- /maintain-Route (Button „Full maintenance now")
- Scheduler-Job (runJob je Repo, autoUpload:true)
- Cron-Tick (settings.schedule) → fullMaintain für JEDE angebundene Komponente + Report, mit Reentrancy-Guard (scheduledRunning).

fullMaintain managt selbst das RUNNING-Set (try/finally) → der „running…"-Indikator (F-29) greift auch bei autonomen Läufen.

Live verifiziert (Build .16): Zeitplan in Settings aktiviert (Cron „* * * * *") → Cron triggert ohne Zutun „geplanter Pflege-Lauf läuft", /api/running zeigt die laufende Komponente, ApexColorPalette/APEX-Vanta-js-Plugin werden autonom auf „OK/up to date" gepflegt. Danach Zeitplan wieder aus. Push bleibt durch allowPush gegated. Bug B-18, verwandt T-66/T-82, [[gated-adopt-rebuilt-trotz-alter-lib-badges-ist-korrekt-migration-liegt-auf-branch-nicht-gemergt]].

### AI-UI-Prüfung (Vision) via Claude-CLI: Screenshots MÜSSEN im Arbeitsverzeichnis liegen
_2026-06-26 15:45:22_

Das optische Gate (T-104) lässt die Claude-CLI zwei PNG-Screenshots (BEFORE/AFTER) vergleichen, indem die PNG-PFADE im Prompt stehen — Claude Code liest die Dateien selbst (echte Vision, kein base64 nötig). ABER: Claude Code läuft im Print-Modus SANDBOXED und liest nur Dateien INNERHALB seines Arbeitsverzeichnisses (= cwd des Server-Prozesses = Projektordner). Screenshots in os.tmpdir() (außerhalb) → „permission not granted / read denied" → aiVisualCheck liefert ran:false (kein Verdikt) ODER ein looksSame=false aus dem FALSCHEN Grund (Datei nicht lesbar) — irreführend.

Live verifiziert: Screenshots unter data/ (projekt-intern) → Claude liest sie und urteilt korrekt: gleich→{looksSame:true}, verschieden/leer→{looksSame:false, issues:[konkrete optische Mängel]}. Deshalb speichern baseline.js (baseline-shot.png) und redev.js (after-shot.png) die Shots unter specsDir = DATA_DIR/ui-tests/<slug>; solange DATA_DIR projekt-relativ (./data, Default) ist, sind sie lesbar. Falls AISPP_DATA_DIR auf ein externes Temp zeigt (QA), kann die Vision nicht lesen → visual.ran=false → Gate fällt sauber auf das Funktions-Gate zurück (blockt nicht fälschlich). Merksatz: für CLI-Vision die Bilder immer in den cwd-Baum legen. [[update-immer-ueber-die-gui]]

### Mock-Grundsatz: Daten mocken, Funktionalität niemals
_2026-06-26 17:08:33 · Tags: mock,prinzip,libraries,testing_

Verbindlicher Grundsatz für ALLE Plugin-/Template-Mocks (statisch wie KI-generiert):

GEMOCKT werden dürfen/müssen NUR: (a) die APEX-Laufzeitumgebung (apex.*, $v/$s) und (b) die DATEN, die das Plugin konsumiert (Server-Process-Antworten, Item-Werte, Plugin-Attribute/Optionen).

NIEMALS gemockt/gefaked/geshimt werden: Bibliotheken oder die Funktionalität/das Verhalten des Plugins selbst. Die echten Lib-Dateien werden real geladen (korrekte Reihenfolge, z.B. three vor vanta vor Plugin), und der echte Plugin-Code läuft. Eine gefakete Bibliothek (z.B. ein statisches Bild statt echter Animation) = UNGÜLTIGER Mock. Fehlt eine Lib wirklich im Repo, wird sie vom offiziellen CDN echt geladen – nicht nachgebaut.

Durchsetzung im Code:
- src/test/mock.js scanExtraLibFiles erfasst lib-artige .js, die der Fingerprint nicht erkennt (vanta/*, three, dist/build), → extraLibFiles werden real per <script src> geladen und neben die Seite kopiert.
- aiMockPrompt trägt die Regel als HARD RULE „MOCK DATA, NEVER FUNCTIONALITY".
- Self-Test-Harness erzwingt echte Wirkung: Animation muss sich über die Zeit ändern (eingefroren = Fehlschlag), Buttons/Mode-Switches müssen real umschalten + weiter animieren. Diese window.__features-Checks sind die Testfälle, die eine Migration grün halten muss.

So wird das Problem für jedes weitere Plugin verhindert: der Sammler holt echte Libs automatisch, der Prompt verbietet das Faken, und die Self-Tests fliegen auf, sobald Funktionalität nur vorgetäuscht ist.

### Genericity-Audit: App arbeitet plugin-unabhängig (keine Beispiel-Hardcodierung)
_2026-06-28 10:24:12 · Tags: genericity,audit,standalone,plugin-unabhängig_

Audit von src/ (Build .62): Das Tool arbeitet generisch mit jedem Plugin/Template — Beispiele sind nur Testobjekte.

Belege:
- Kein Plugin-Name-Special-Casing: kein `name === 'ApexFlowChart'`, kein switch auf Namen, keine fest verdrahteten Modus-/Sicht-Listen. (name===-Vergleiche sind generisch: APEX-Call-Namen, Asset↔Finding, Repo-Dedup.)
- Ableitung aus dem konkreten Plugin: Schnittstelle/Modi aus dem APEX-Attribut-Vertrag (scanPluginAttributes) + KI-Analyse des echten Codes; Mock-Self-Tests prüfen Ist-Werte; Lib-Erkennung mit generischem Fallback (nameFromFile Basename, isCandidate für jeden lib/vendor/dist-Ordner), unbekannte Versionen generisch als 'unbekannt'.
- Beispiel-Namen (mxgraph/vanta/jsonpath/fancytree) nur als generische Referenzdaten (EOL-Liste, Vuln-DB, Fingerprints, Nachfolger-Map) oder als illustrative Prompt-Beispiele — gelten für jedes Plugin mit diesen Libs.

Empirisch: 6 verschiedene Plugins → 6 verschiedene Schnittstellen (1/7/13 Parameter; Typen SELECT LIST, PLSQL, CHECKBOX, PAGE ITEM, JAVASCRIPT) und unterschiedliche Lib-Sets.

Kleine Beobachtung (unkritisch): libDir-Heuristik in mock.js nennt zusätzlich vanta|three als Verzeichnis-Hinweise (additiv, schadet nicht). Optional bereinigbar.

### Security-Review-Runde + GitHub-Publikationsvorbereitung (Juli 2026)
_2026-07-11 11:55:04 · Tags: security,review,publication,gitignore_

13 Review-Befunde von 4 Agenten (Security Tester E-9, Code Reviewer E-10, Spec Tester E-11) abgearbeitet, Duplikate zusammengeführt, Publikation vorbereitet.

DUPLIKATE (durch unterschiedliche Reviewer): B-54≡B-49, B-55≡B-50, B-57≡B-51, B-56≡B-52, B-53≈B-45 → auf die kanonischen Bugs geschlossen.

REAL BEHOBEN (+ Regressionstests in test/security-fixes.test.js):
- B-42 mask(): kurze Secrets (<12) voll maskiert (src/config/secrets.js)
- B-43 reinject: Default-FS auf rootDir eingesperrt via resolveWithin (src/extract/reinject.js)
- B-44 Spec-Write: nur path.basename (src/test/run-ui.js)
- B-41 Provider-Endpoint: assertSafeEndpoint erzwingt https, localhost darf http (src/ai/backend.js)
- B-49 buildInstallScript: exportFile mit "/CR/LF abgelehnt (mcp-apex-deploy/lib/apex.js)
- B-50 findRepoSource: withinRepo-Containment (mcp-apex-deploy/lib/plugin-assets.js)

AKZEPTIERT (by-design, local single-operator trust model → SECURITY.md): B-46 (operator-CLI-spawn), B-52 (lokaler MCP ohne Auth). B-48 (HIGH: Ausführen KI-generierter Specs) auf clarify → Nutzer entscheidet, Traversal-Teil ist via B-44 entschärft.

FEHLBEFUND: B-47 (src/diff/diff.js/changedFilesSince existiert nicht).

FIXTURE (kein Laufzeit-Risiko): B-45/B-53 (examples/.../colorpicker.sql jQuery 3.4.1 via Platzhalter cdn.example.com — absichtlich als Outdated-Erkennungs-Beispiel, von 6 Tests genutzt).

PUBLIKATION: Leak-Audit sauber — .mcp.json und data/ NIE committet (ganze History geprüft), keine echten Secrets/Keys/PII in getrackten Dateien. Neu: LICENSE (MIT, © 2026 maras), SECURITY.md, .mcp.json.example (Platzhalter), README+Bedienungsanleitung+docs/img (Screenshots mit unscharfen Eingaben), package.json license=MIT + engl. description. .gitignore kritisch überarbeitet (Trailing-Kommentare sind in .gitignore UNWIRKSAM — nur eigene Zeilen!); .claude/ inkl. skills nicht mehr versioniert. Testsuite 522 grün (516 + 6 neue).


## Item-bezogenes Wissen (118)

### Regel: Selbstheilungs-Loop bei Rot — begrenzt, protokolliert, ohne Push bei Fehlschlag
_2026-06-24 13:06:43 · Item #831 · Tags: loop,test-gate,self-healing,auto-update_

Bei rotem Test wird nicht abgebrochen, sondern iterativ repariert: Befund→KI-Korrektur→erneut testen, bis grün. Harte Grenzen gegen Endlosloop: (1) max. N Versuche (konfigurierbar, Default 5); (2) Stagnations-Abbruch bei 2x identischem Fehler ohne Fortschritt; (3) bei Limit/Stagnation FEHLGESCHLAGEN markieren, KEIN Push/Re-Upload, Artefakt/Branch sauber zurücksetzen. Jede Iteration (Versuch-Nr., Aktion, Ergebnis) wird in der Lauf-History persistiert und fließt in den E-Mail-Report. Loop ist idempotent (Crash/Neustart erzeugt keine Doppel-Pushes). Greift sowohl bei KI-Testpflege (E-2) als auch beim Auto-Update (T-8).

### Kein package.json in APEX — SBOM per Fingerprinting als stabile interne API
_2026-06-24 13:11:15 · Item #799 · Tags: sbom,fingerprinting,apex,cyclonedx,architektur_

APEX-Plugins/Template Components liefern JS/CSS meist *vendored* mit, ohne Manifest und ohne Versions-Klartext. „npm outdated" greift daher nicht. Entscheidung:
1) **Fingerprinting (retire.js / OWASP Dependency-Check)** per Hash/Signatur → bekannte Lib+Version = Pflicht. Header-/Dateinamen-Heuristik nur als Fallback (bricht bei minify/rename). Reine Manifest-Erkennung deckt die APEX-Mehrheit nicht ab.
2) Ergebnis je Artefakt = **CycloneDX-SBOM**. Diese SBOM ist die *stabile interne Schnittstelle* für Update-Check, Unmaintained-Check und Report: **ein wöchentlicher Scan, mehrere Auswertungen** (Antwort auf die Architekt-Rückfrage).
3) PL/SQL-Abhängigkeiten (Packages) separat über DB-Metadaten.
Tool-Reife/Abdeckung wird in der nächsten Recherche-Runde web-belegt verifiziert.

### Stabile Tests: zweigeteilt (utPLSQL + Playwright), Golden-Master, Quarantäne 3× grün
_2026-06-24 13:11:21 · Item #798 · Tags: stable-tests,utplsql,playwright,golden-master,quarantine,flaky_

„Stabil" = deterministisch + idempotent, sonst ist das Gate wertlos. Ein APEX-Artefakt ist zweigeteilt → zwei Testebenen:
- **PL/SQL** (Render-/AJAX-Callbacks, Packages) → **utPLSQL** in Wegwerf-Schema/Container-DB (23ai), Setup/Teardown pro Test.
- **JS/Render** → **Playwright** headless gegen eine ephemere APEX-Instanz.
Stabilität strukturell erzwungen:
(a) **Characterization-/Golden-Master-Snapshot** beim Erst-Einlesen als Bezug; jede Änderung prüft dagegen.
(b) Fixierte Zeit/Seed, **keine SYSDATE-Abhängigkeit** (sonst flaky), gepinnte Versionen.
(c) **Quarantäne:** ein neuer KI-generierter Test muss **3× grün hintereinander**, bevor er ins Gate aufgenommen wird; flaky fliegt automatisch raus + Badge „instabil".
**Rollentrennung:** die *reparierende* KI darf Snapshot-/Akzeptanztests NICHT ändern (kein „grün gemogelt"). Die KI *schlägt* Tests vor, der deterministische Harness macht sie stabil.

### Unmaintained ≠ veraltet: eigener Score, informativ (kein Gate-Block), quittierbar
_2026-06-24 13:11:27 · Item #809 · Tags: unmaintained,risiko,osv,scorecard,depsdev,endoflife,report_

„Nicht mehr gepflegt" ist eine **Risiko-Warnung, kein Update-Fall** — eine archivierte Lib kann man nicht updaten, nur ersetzen. Auswertung über dieselbe wöchentliche SBOM, **Score aus mehreren Quellen** statt einer Regel: GitHub `archived`/letztes Release+Commit, deps.dev (Health), OSV (CVE ohne Fix), npm `deprecated`-Feld, OpenSSF Scorecard, endoflife.date (Runtime-EOL).
**Drei Stufen:** 🟡 stale (lange kein Release) · 🟠 unmaintained (archiviert/deprecated) · 🔴 vulnerable+unfixed. Schwellen (z.B. 18 Monate) in der Config, nicht hartcodiert.
**Verhalten (Antwort auf UX-Rückfrage):** blockiert das Update-Gate NICHT — Updates laufen normal durch. Eigener Block „⚠️ Handlungsbedarf" *über* dem Erfolgsblock in Report + GUI; **Pflicht-Begründung** + Git-Link je Warnung; **quittierbar** („akzeptiertes Risiko") gegen Alarm-Müdigkeit, quittierte Warnung erscheint nicht erneut.

### Auslieferung als Pull Request (Default), nicht direkt auf den Branch
_2026-06-24 13:11:32 · Item #824 · Tags: pull-request,auslieferung,git-workflow,review-gate_

Konsens aller drei Agenten: KI-Updates/-Fixes landen auf einem **Arbeits-Branch** (ein Commit je Reparaturversuch) und werden als **Pull Request** geliefert — menschliches Gate, jede KI-Änderung reviewbar, passt zum Git-Workflow. Direkter Push nur, wenn der Nutzer das später pro Repo explizit freischaltet. Bei finalem Rot: Branch stehen lassen + roter Report, **kein** PR/Merge. (Dies setzt die in der Erstrunde gestellte Push-vs-PR-Frage auf PR als Default — offen für ausdrücklichen Widerruf des Nutzers.)

### Speicherformat entscheidet über Testbarkeit (Export vs. Quellcode)
_2026-06-24 13:13:40 · Item #834_

Die testbare Architektur hängt am Speicherformat der Artefakte im Git:
- **Export-fertig (f4000/wwv_flow_api):** JS/CSS eingebettet → Tests brauchen i.d.R. eine ephemere APEX-Instanz (23ai-Container) für utPLSQL + Playwright.
- **Roher Quellcode (.sql/.js/.css getrennt):** PL/SQL direkt per utPLSQL im Wegwerf-Schema, JS isoliert per Vitest — ohne laufende APEX-Instanz.
Format wird pro Artefakt entschieden (Mischform je Repo möglich), als Inventar-Feld geführt und ist Eingang für T-4/T-6 (Tests) und T-7 (SBOM). Offene Annahme war der einzige Test-Blocker → jetzt explizit als T-18.

### Normalisierung vor allem: kanonisches Bündel als einzige stabile API
_2026-06-24 13:20:41 · Item #835 · Tags: architektur,extraktion,apex_

"Uneinheitlich, weil von vielen Leuten" ist primär ein Normalisierungs- statt Testproblem. JS steckt in APEX an drei Orten: (1) base64-BLOB via wwv_flow_api.create_plugin_file, (2) inline-String im PL/SQL-Render-Code (add_inline_code/htp.p), (3) nur referenziert (CDN/#PLUGIN_FILES#). Lose .js/.css sind der einfache Fall. Lösung: EIN kanonisches Bündel { js[], css[], inlineCode[], referencedUrls[], sourceMap } VOR Fingerprinting/SBOM/Test/Report — danach ist alles dahinter format-blind. Nicht sauber Extrahierbares wird markiert, nicht geraten. Wegen Stil-Heterogenität AST-basiert (acorn/espree) statt namens-/musterbasiert.

### MVP-Schnitt der Extraktion: dekodierbare Dateien + lose JS/CSS zuerst, Inline-PL/SQL nachgelagert
_2026-06-24 13:20:47 · Item #835 · Tags: entscheidung,scope,mvp_

Entscheidung (Architekten-Rückfrage beantwortet, Default gesetzt, widerrufbar): Der Extraktor startet MVP-mäßig mit base64-Plugin-Dateien + losen .js/.css + referenzierten URLs (T-19, Slice MVP). Inline-im-PL/SQL eingebettetes JS (T-20) ist der teuerste Fall und kommt als eigener, nachgelagerter Task — bei "von vielen Leuten gebaut" wahrscheinlich häufig, aber er soll den MVP nicht blockieren. Sobald T-19 echte Repos sieht, wird der Anteil der reinen Inline-Fälle gemessen und der Vorzug von T-20 ggf. neu priorisiert.

### Zwei Test-Achsen: Format → Extraktion, Laufzeit-Abhängigkeit → Testebene
_2026-06-24 13:20:52 · Item #808 · Tags: tests,architektur_

Speicherformat (T-18/F-15) und Testebene (T-22) sind ZWEI getrennte Achsen. Default-Pfad ist jsdom + gemockter apex.*-Namespace (billig, keine Instanz) für Characterization/Snapshot — deckt den Großteil von "Verhalten geändert?" ab. Playwright gegen eine ephemere Instanz (gepinnte Versionen, fixierte Zeit/Seed) nur gezielt dort, wo echtes apex.*-Runtime nötig ist. Static-First (T-23: ESLint + retire.js + Snapshot je Artefakt) deckt die uneinheitliche Masse; echte Verhaltenstests nur für als kritisch markierte Plugins.

### Round-Trip ist Pflicht: ohne Re-Injektion kann kein SQL-Plugin geliefert werden
_2026-06-24 13:28:32 · Item #842 · Tags: round-trip,re-injektion,sourcemap,auslieferung,architektur_

Zu-Ende-gedacht: F-15 normalisiert nur EINE Richtung. KI-Fix (T-15) und Lib-Update (T-8) verändern das kanonische JS — daraus wird aber erst dann ein PR, wenn das gepatchte Asset über die sourceMap exakt ins Original-Format zurückgeschrieben wird (base64-BLOB im SQL / inline-PL/SQL / lose Datei). Diese Gegenrichtung (T-25) fehlte und ist für SQL-Export-Plugins zwingend — sonst ist 'Push bei grün' (T-8) für genau die Mehrheit der APEX-Artefakte unmöglich. Garantien: minimaler/deterministischer Diff, Round-Trip byte-identisch, 'extraktion-unsicher' wird nie automatisch zurückgeschrieben. Reihenfolge: Update/Fix → T-25 Re-Injektion → erneut testen → Push.

### Drei Lücken beim Zu-Ende-Denken: Re-Injektion, PR-Dedup, Lauf-Orchestrierung
_2026-06-24 13:28:40 · Item #844 · Tags: abschluss,orchestrierung,idempotenz,architektur,entscheidung_

Abschluss der Entwurfsrunde — die drei Dinge, die eine echte Umsetzung sonst blockiert hätten: (1) T-25 Re-Injektion = Umkehrung von F-15 (sourceMap-Writeback). (2) T-26 Lauf-Idempotenz/Offen-PR-Dedup: ein Wochendienst darf für dieselbe (Artefakt+Lib+Zielversion) nicht jede Woche neue PRs erzeugen; stabiler Branch-Schlüssel, abgelehnter PR wird quittiert. (3) T-27 Lauf-Orchestrierung als Zustandsautomat je Artefakt: isolierter Teil-Fehler (ein Artefakt kippt nicht den ganzen Lauf), Resume nach Crash am letzten Zustand, Aggregation zu GENAU EINEM Report je Lauf. Diagramm 'Lauf-Zustandsautomat je Artefakt (E2E)' an T-27 hält die Übergänge fest. Letzte offene Frage (T-22 Default) war bereits in Wissen #512 entschieden: jsdom+apex.*-Shim als Default, Playwright gezielt — verfeinert durch T-21 (AST erkennt apex.server.process/Region-Aufrufe → Artefakt als 'laufzeitgebunden' markieren → Playwright-Pfad).

### sourceMap-Vertrag des kanonischen Bündels (Rückweg für T-25 Re-Injektion)
_2026-06-24 14:58:22 · Item #836 · Tags: extraktion,sourcemap,re-injektion,kanonisches-bündel_

Implementiert in src/extract/extract.js. Die sourceMap im kanonischen Bündel mappt jeden Asset-Namen auf seine Herkunft — das ist der verbindliche Rückweg für die Re-Injektion (T-25):
- aus SQL-Export: { type:'plugin_file', sqlFile, fileName, call:'create_plugin_file' } — der gepatchte Code muss base64-kodiert an genau diesen create_plugin_file-Aufruf (Literal bzw. g_varchar2_table-Chunks) zurückgeschrieben werden.
- lose Datei: { type:'file', path } — gepatchter Code wird direkt in die Originaldatei geschrieben.
referencedUrls (CDN/File-URLs) haben KEINEN lokalen Code und werden NICHT re-injiziert (nur Lib-Update via URL-Version, T-7/T-8). Unsicher extrahierte Artefakte (status 'extraktion-unsicher') dürfen nicht automatisch zurückgeschrieben werden. Inline-PL/SQL-JS (T-20) ergänzt inlineCode[] mit eigener Positionsangabe — bei Implementierung sourceMap-Schema entsprechend erweitern.

### KI-Aufruf-Abstraktion als Seam: Pipeline real, Backend injizierbar (Slice 23) → echtes Backend in T-11
_2026-06-24 15:08:21 · Item #820 · Tags: ki-backend,abstraktion,mock,test-generierung_

src/ai/backend.js definiert die einheitliche Schnittstelle complete(prompt, opts) (Wissen #503). In Slice 23 läuft die Test-Generierung (T-4/T-5) und später der Selbstheilungs-Loop (T-15) gegen ein deterministisches stubBackend — deshalb stehen T-4/T-5 auf mock_active. Die Pipeline selbst (Prompt-Bau aus T-21-Kontext, acorn-Validierung des Outputs, Ablage, Dedup) ist real und vollständig getestet. Slice 26/T-11 hängt das echte Backend (lokale CLI ODER Provider+API-Key) + Verbindungstest an dieselbe Schnittstelle; Secrets nur über get_connection (T-12), nie im Klartext. Wer T-15/T-6 erweitert: ai immer als opts.ai injizieren, nie global instanziieren.

### Inline-PL/SQL-JS umgesetzt — dritter Extraktions-/Re-Injektions-Pfad schließt den Round-Trip vollständig
_2026-06-24 15:38:12 · Item #837 · Tags: extraktion,inline,re-injektion,round-trip,abschluss_

T-20 ist umgesetzt (war im MVP bewusst abgeschichtet). Damit deckt der Normalisierungs-Layer alle drei JS-Orte in APEX ab (Wissen #510): (1) base64-BLOB, (2) lose Datei, (3) inline-im-PL/SQL. src/extract/inline.js extrahiert add_inline_code/htp.p/htp.prn, fügt Literal-Concats zusammen, streift <script>-Wrapper ab und merkt sie exakt; Nicht-Literale werden als unsicher markiert (nie geraten). Die sourceMap trägt für inline absStart/absEnd/wrap → src/extract/reinject.js hat jetzt den 'inline'-Rückschreibpfad (Round-Trip byte-identisch, minimaler Diff). Damit ist der in [[sourceMap-Vertrag-des-kanonischen-Bundels]] als offen vermerkte Inline-Fall geschlossen. Restscope bleibt: AST-Analyse (T-21) läuft auf bundle.js; falls inline-JS getestet werden soll, müsste die Orchestrierung inlineCode ebenfalls durch analyze/Tests schicken — derzeit getrennt geführt.

### Pflege-Pipeline mit Review-Gates umgesetzt — Skill-Zuordnung & Gate-Reihenfolge
_2026-06-24 16:00:30 · Item #852 · Tags: review-gate,security,owasp,code-review,pflege,abschluss_

E-7/F-16 umgesetzt (T-28..T-31, 147 Tests grün). Reihenfolge: Pflege (Web-Dev-Persona, src/ai/personas.js) → Selbstheilung grün (T-15) → Security-Review (T-29) → Code-Review (T-30) → PR (T-25/T-26). Verbindendes Gate: src/run/review.js (reviewGate); verdrahtet in autoUpdate (src/run/update.js, args.review() vor push) und als Zustand 'reviewed' im Lauf-Automaten (src/run/orchestrate.js, Step zwischen reinject und pr).

Skill-Zuordnung (Ökosystem):
- Pflege/Reparatur: Web-Dev-Persona als System-Prompt; perspektivisch eigener Umsetzungs-Agent im Pool (bisher nur Planungs-Agenten architekt/ux-designer/kreativer-entwickler/analyst vorhanden).
- Security-Gate: Skill `security-review` (OWASP Top 10/ASVS) + retire.js/SBOM-CVE (T-7) als deterministische Basis; statische Heuristiken in securityScan.
- Code-Gate: Skills `code-review` und `simplify` (Lesbarkeit/Einfachheit/keine losen Enden); statische Heuristiken + AST (unused vars, Komplexität) in qualityScan.

Wichtig: Die statischen Scans sind die deterministische Untergrenze; die genannten Skills/Agenten werden als injizierbare reviewer (opts.reviewer) zusätzlich daraufgesetzt. Schwelle default 'medium' blockiert; Security-Findings sind per ack-Set explizit quittierbar (analog Risiko-Quittung T-16).

### Komponenten-Verwaltungs-GUI umgesetzt — echte SPA statt nur JSON
_2026-06-24 17:21:53 · Item #858 · Tags: gui,spa,komponenten-verwaltung,abschluss_

F-17 (T-32..T-34) umgesetzt, 157 Tests grün + Live-Smoke-Test. Echte Web-Oberfläche unter / (public/app.html): Übersichtstabelle aller verwalteten Plugins/Template-Komponenten mit Name, Typ, Format-Badge, Status, letzter Änderung + Zusammenfassung; Add/Edit/Delete; Detail-Drawer mit Protokoll/Hinweisen (hinzufügen/lesen), Reviews, „Verzeichnis öffnen" und „Manuelles Review" (führt das Review-Gate T-31 über die extrahierten Assets aus und speichert das Ergebnis als Review-Notiz). Persistenz: data/components.json (createComponentStore, src/gui/store.js). View-Model/Aktionen: src/gui/components.js (openDirectory plattformabhängig, manualReview via Extraktor+reviewGate). REST: src/gui/api.js (apiHandler, transportunabhängig, getestet) — in start.js (serve) verdrahtet: GUI /, Doku /readme.html, /api/components* (CRUD, /:id/notes, /:id/review, /:id/open). Start: Start.cmd → [1] Web-GUI. Offen als Adapter: echte Repo-Anbindung der Komponenten an Läufe/History (lastChange aus echten Läufen füttern).

### Arbeitsverzeichnis-Flow umgesetzt — Repo anbinden statt Komponenten manuell anlegen
_2026-06-24 17:53:24 · Item #862 · Tags: arbeitsverzeichnis,auto-discovery,repo,gui,abschluss_

F-18 (T-35..T-37) umgesetzt, 165 Tests grün + Live-Smoke. Primärer Flow ist jetzt: globales Arbeitsverzeichnis (settings.workDir) setzen → Repo per URL/Pfad anbinden → Tool klont/fetcht selbst nach workDir/<name> (src/service/workspace.js addRepoToWorkspace) → Auto-Discovery erkennt Plugins/Template-Komponenten (detectArtifacts+enrichWithFormat) und upsertet sie je (repo+name) in die Registry (discoverComponents/syncRepo) — Re-Scan ohne Duplikate. GUI: Arbeitsverzeichnis-Feld + „+ Repo anbinden" + „Alle erneut scannen" + Repo-Spalte (public/app.html). REST: metaApiHandler (GET/PUT /api/settings, GET/POST /api/repos, POST /api/repos/rescan) in start.js verdrahtet. Manuelles Add/Edit bleibt als Ausnahme. Persistenz: data/components.json. Offener Adapter: lastChange/Änderungs-Zusammenfassung automatisch aus Wächter-Läufen (Scheduler→orchestrate→store.setLastChange) füttern; aktuell read-only Discovery + manuelles Review.

### Entscheidung: EIN Repo = EIN Plugin/Template-Komponente
_2026-06-24 17:58:37 · Item #862 · Tags: entscheidung,repo-je-plugin,auto-discovery,modell_

Korrektur des Discovery-Modells (Nutzer-Vorgabe): Ein Git-Repository entspricht genau EINER gepflegten Komponente (ein Plugin bzw. eine Template-Komponente), nicht einem Repo mit vielen. Daher leitet syncRepo (src/service/workspace.js) je Repo genau EINE Komponente ab (repoComponent): Name = Repo-Name, Typ/Format aus der Inhaltserkennung (T-2/T-18), Pfad = Repo-Wurzel im Arbeitsverzeichnis. Mehrere erkannte Artefakte in einem Repo → format='mixed' (Hinweis auf untypische Struktur), bleibt aber EINE Komponente; keine Artefakte → status 'zu klären'. Upsert/Re-Scan je Repo-Name, kein Duplikat. Frühere Variante (N Artefakte = N Komponenten) ist damit ersetzt; alte Demo-Daten (data/components.json) wurden entfernt.

### Lauf-Anbindung umgesetzt — Übersicht aktualisiert sich aus Läufen
_2026-06-24 18:08:12 · Item #866 · Tags: lauf-anbindung,scheduler,history,gui,abschluss_

F-19 (T-38/T-39) umgesetzt, 174 Tests grün + Live-Smoke. Ein Lauf analysiert je Komponente (src/service/run-component.js: scanRepo → summarize → store.setLastChange + status) und schreibt das Ergebnis in die Registry; runManaged legt EINEN History-Eintrag an. Auslöser: (1) GUI „▶ Jetzt prüfen" (POST /api/run, alle) bzw. „▶ Prüfen" im Detail (POST /api/components/:id/run); (2) „↻ Erneut anbinden" (rescan) ruft nach fetch+detect direkt runManaged; (3) geplanter Scheduler-Job je Repo: syncRepo (fetch+detect) → runManaged. Status-Ableitung: Lint/zu klären → 'zu klären'; Updates/Schwachstellen/Risiken → 'handlungsbedarf'; sonst 'ok'. Summary z.B. „1 Schwachstelle(n)". WICHTIG für künftige Änderungen: neue /api/*-Routen in start.js auch ins Routing aufnehmen (war Bug: /api/run fehlte zunächst). Damit ist die Übersicht nach jedem Lauf selbst-aktuell; der nächste echte Schritt wäre ein Auto-Update-PR-Flow (T-8/autoUpdate) hinter „handlungsbedarf".

### Auto-Update-PR-Flow je Komponente umgesetzt — Schlussstein der Pflege-Kette
_2026-06-24 18:16:53 · Item #869 · Tags: auto-update,pr,review-gate,gui,abschluss_

F-20 (T-40/T-41) umgesetzt, 179 Tests grün + Live-Smoke. Aus der GUI je Komponente auslösbar (Detail „⬆ Auto-Update", POST /api/components/:id/update). Ablauf: planLibUpdates (verwundbare referenzierte Libs via retire-DB, Ziel=Fix) → URL-Version im Quelltext bumpen (echter Datei-Patch) → Review-Gate (T-31 Security+Code) → bei grün idempotenter PR-Push (T-26), bei Block Datei-Rollback + kein Push → Ergebnis als Review-Notiz + lastChange + Status (pr-offen/review-blockiert) + History. Push = lokaler Branch aisp/update/<komp>/<lib>-<ziel> + Commit (start.js localGitPush, simple-git); Session-PR-Registry verhindert Doppel-PR. Live verifiziert: jquery 3.4.1→3.5.0 gepatcht, Branch erzeugt. Damit ist die durchgehende Kette komplett: Repo anbinden → Auto-Discovery → Prüfen (Status/letzte Änderung) → Auto-Update mit Review-Gate → PR-Branch. Grenze/Adapter: echtes Update beschränkt auf URL-Versions-Bump referenzierter Libs (vendored Lib-Dateien brauchen Lib-Quelle); Remote-Push (statt lokalem Branch) + echte PR-Erstellung (GitHub-API) sind der nächste Adapter; KI-Reparatur (selfHeal) ist im autoUpdateArtifact-Pfad (T-8) vorhanden, hier bewusst auf den deterministischen Lib-Bump fokussiert.

### Plugin-zentrierter Flow umgesetzt — Plugin anlegen → Repo zuordnen (mit Secrets)
_2026-06-24 18:25:18 · Item #872 · Tags: plugin-first,repo-zuordnung,secrets,gui,abschluss_

F-21 (T-42/T-43) umgesetzt, 183 Tests grün + Live-Smoke. Einstieg ist jetzt „+ Plugin" (Komponente anlegen); danach im Detail „🔗 Repo zuordnen": Quelle + Sichtbarkeit (öffentlich/intern); bei intern Token/SSH-Key → verschlüsselt im SecretStore (T-12), Komponente hält nur secretRef (kein Klartext). assignRepoToComponent (src/service/assign-repo.js) klont in workDir/<slug(plugin)> (eigenes Verzeichnis je Repo), löst Auth zur Laufzeit auf (nie persistiert), erkennt Typ/Format (repoComponent) und aktualisiert die Komponente (source/visibility/secretRef/path/type/format/status); Re-Aufruf = re-fetch. Arbeitsverzeichnis ist aus der Hauptleiste in „⚙ Einstellungen" gewandert (nur Label sichtbar). REST: POST /api/components/:id/assign-repo (start.js, SecretStore aus AISPP_MASTER_KEY). Damit ersetzt der Plugin-first-Flow das frühere „+ Repo anbinden" als Primärweg; die alten /api/repos-Endpunkte bleiben funktionsfähig. Adapter offen: echte Nutzung des Tokens beim Klonen privater https-Repos (heute über authenticatedSource bei kind=https; lokale Quellen ignorieren Auth).

### Prüfprotokoll umgesetzt — welcher Agent prüfte welche Datei (Log)
_2026-06-24 18:47:51 · Item #875 · Tags: protokoll,log,agent,reporting,abschluss_

F-22 (T-44/T-45) umgesetzt, 188 Tests grün + Live-Smoke. Beim „▶ Prüfen" entsteht ein Protokoll: scanRepo (src/service/run-repo.js) baut result.log mit Einträgen {artifact, agent, file, result, severity?}; Agenten: Erkennung (T-2/T-18), Lint (je JS-Asset), AST (Einstiegspunkte), retire.js (verwundbare Libs, Security), Snapshot (golden-master), Extraktion (unsicher). runComponentOnce (run-component.js) persistiert lastLog{at,entries} an der Komponente und ruft optional logSink (formatLog → Text). GUI (public/app.html): Detail-Drawer „Prüfprotokoll" zeigt Agent→Datei→Ergebnis + „⬇ Log herunterladen" (Blob). start.js logSink schreibt zusätzlich data/logs/<slug>-<ts>.log. Verifiziert: jquery-Schwachstelle erscheint als [retire.js]-Eintrag, Logdatei wird angelegt. Erweiterbar: Security-/Code-Review-Agenten (T-29/T-30) könnten ihre Findings ebenfalls als Protokoll-Einträge beisteuern (manualReview/autoUpdate).

### Review fließt ins Protokoll; Öffnen getrennt in Git (Browser) und Lokal (Ordner)
_2026-06-24 19:17:11 · Item #875 · Tags: review,protokoll,gui,git-open,feedback_

Auf Nutzer-Feedback: (1) „🌐 Git öffnen" (public/app.html openGit) öffnet die Quell-/Git-URL im Browser (https direkt; git@host:org/repo → https abgeleitet) — clientseitig, da die GUI im Browser läuft. „📂 Lokal öffnen" (POST /api/components/:id/open → openDirectory) öffnet den lokalen Checkout-Ordner im OS-Explorer. (2) „Wo wird reviewt": Das Review läuft im Review-Gate (Security + Code) über die extrahierten Assets (manualReview in src/gui/components.js). Neu: manualReview schreibt die Befunde als Agent-Einträge ins Protokoll (lastLog): [Security] datei → finding, [Code-Review] datei → finding, [Review-Gate] → bestanden/blockiert. So steht im selben Prüfprotokoll/Download „welcher Agent prüfte welche Datei", auch fürs Review. Erneutes Review ersetzt seine alten Einträge (kein Duplikat). Tests: test/review-log.test.js. 204 Tests grün.

### Testpläne (Gherkin), KI-Konfig & autonomes Review-&-Fix umgesetzt + verifiziert
_2026-06-24 19:28:43 · Item #883 · Tags: testplan,gherkin,ki-konfig,autoreview,abschluss_

F-24 (T-49/50/51) umgesetzt, 212 Tests grün + Live-Smoke. (1) Testplan: src/ai/testplan.js → scanRepo result.testPlan → component.testPlan; GUI zeigt Cucumber-Plan + Download .feature. (2) KI-Konfig zentral in „⚙ Einstellungen": Backend CLI/Provider, Endpoint/Modell/Command, API-Key (verschlüsselt via /api/ai/key → SecretStore, persistent), Verbindung testen (/api/ai/test); Auflösung über src/ai/configure.js resolveAiBackend — EINZIGE Stelle, die alle Konsumenten (selfHeal/autoreview/Testgen) nutzen. (3) Autonomes Review-&-Fix: src/service/autoreview.js → POST /api/components/:id/autoreview; review→KI-Fix (acorn-validiert)→re-inject (T-25)→re-review bis grün/Limit, Rollback bei Misserfolg, Protokoll Security/Code/Web-Dev/Auto-Review; ohne echtes Backend klare Meldung. WICHTIG: neue /api/*-Routen in start.js müssen ins Routing (ai/test, ai/key, autoreview liegen vor dem sync /api/components-Branch). Default-Backend ist CLI 'claude' → ohne installierte CLI schlägt der Verbindungstest erwartbar fehl; für echtes Fixen Provider+Key oder lokale CLI konfigurieren.

### F-25 umgesetzt: Testplan-Baseline, Log-Archiv, SMTP-Report, Zeitplan, Libs je Plugin (222 Tests grün)
_2026-06-24 19:44:45 · Item #887 · Tags: testplan,log-archiv,smtp,zeitplan,libs,abschluss_

F-25 (T-52..T-56) umgesetzt + Live-Smoke. (1) Testplan ist Baseline: runComponentOnce überschreibt vorhandenen testPlan nicht, nur regenerateTestPlan; .feature unter data/testplans/<slug>.feature; Endpoint POST /api/components/:id/testplan; GUI „🔄 Neu erzeugen". (2) Log-Archiv: data/logs/<slug>/<ts>.log (auch bei Scheduler-Läufen ohne GUI), GET /api/components/:id/logs(/:name), GUI „Protokoll-Archiv". (3) SMTP: settings.smtp + Empfänger; Passwort verschlüsselt (POST /api/smtp/pass→SecretStore); src/report/smtp.js (nodemailer, transport injizierbar); POST /api/report/send; GUI-Felder + „Report jetzt senden". (4) Zeitplan: settings.schedule (Cron) + scheduleEnabled; src/service/cron.js (cronMatches); Dienst-Timer (setInterval 60s) → runManaged + optional Report; GUI Cron-Feld+Schalter. (5) Libs je Plugin: scanRepo result.libs → component.libs → Übersichtsspalte + Detail-Sektion. WICHTIG-Lehre: kein `*/n` in JSDoc-Blockkommentaren — schließt den Kommentar (`*/`) und zerstört die Datei (in cron.js passiert, gefixt). Dep nodemailer hinzugefügt. Persistenz via settings.json/secrets.json (T-48).

### Nutzer-Konfiguration liegt unter data/ — bei QA niemals löschen; AISPP_DATA_DIR nutzen
_2026-06-24 20:16:28 · Item #896 · Tags: persistenz,qa,data-dir,gotcha_

Die persistente Konfiguration (components.json, settings.json, secrets.json, logs/, testplans/) liegt im Verzeichnis data/ unter dem Projekt-Root. start.js lädt sie beim Start und schreibt bei jeder Änderung — die Persistenz funktioniert. GEFAHR: Ein QA-/Aufräum-`rm -f data/*.json` (versehentlich gegen das echte data/ ausgeführt) löscht die echte Nutzer-Konfiguration ("Konfiguration wieder weg"). Genau das ist passiert. GEGENMASSNAHME (T-58): Das Datenverzeichnis ist per Umgebungsvariable AISPP_DATA_DIR umlenkbar (Default <root>/data). Jeder Test-/QA-Lauf MUSS AISPP_DATA_DIR=<temp> setzen, damit das echte data/ unberührt bleibt. Restart-Roundtrip ist durch test/persist.test.js + test/test-runner.test.js abgesichert.

### Bibliotheks-Aktualität: Datei-Erkennung (isLibraryFile) + npm-Web-Lookup
_2026-06-24 20:27:55 · Item #897 · Tags: bibliotheken,npm,web-lookup,sbom_

Bibliotheks-DATEIEN werden über isLibraryFile() (src/inventory/format.js) erkannt: lib/vendor/dist/min-Ordner, *.min.js, bekannte Lib-Namen (jquery/chart/moment/lodash/d3/bootstrap). Web-Aktualität läuft gegen registry.npmjs.org: src/sbom/registry.js (fetchNpmInfo — Volldokument liefert dist-tags.latest + time{version→ISO}), src/service/lib-check.js (checkLibrariesOnline → latest, releasedAt, ageDays, installedAgeDays, outdated; Netzfehler je Lib → webStatus 'unbekannt', kein Abbruch). fetch ist injizierbar (Tests stubben, live global fetch). Namensmapping Fingerprint→npm in registry.js NPM_NAME (z.B. chart→chart.js, angularjs→angular). REST: POST /api/components/:id/libraries/check; GUI-Button „Aus dem Web prüfen". referencedUrls (für retire/SBOM) kommen NUR aus dem APEX-SQL-Export (extract.js Z.~209), nicht aus losen .js — relevant für Schwachstellen-Tests.

### Eine Pflege-Orchestrierung für manuell UND automatisch (maintainComponent)
_2026-06-24 20:49:43 · Item #905 · Tags: pflege,orchestrierung,scheduler,auto-update_

maintainComponent (src/service/maintain.js) ist DIE eine Pflege-Pipeline, identisch für den manuellen Button „🧰 Vollständige Pflege jetzt" (POST /api/components/:id/maintain) und den Scheduler (start.js runJob ruft je Komponente maintainComponent). Schritte: 1) prüfen (runComponentOnce→scanRepo: Tiefen-Analyse/Tests/Review/Protokoll) 2) Web-Lib-Check (checkLibrariesOnline, setzt libsCheckedAt) 3) Auto-Fix (autoFixComponent: deterministische Quick-Fixes + KI falls Backend + ALLE relevanten Lib-Updates für outdated/vulnerable) 4) Re-Test 5) recordRun. Alle Deps injizierbar (scan/autoFix/update/fetchInfo/exists) → deterministisch testbar ohne Netz/Git/KI. WICHTIG: runComponentOnce erhält Web-Lib-Felder (latest/Alter/Quelle aus T-59) je name@version über den Re-Test hinweg (Merge statt Überschreiben), sonst gehen sie beim 2. Scan verloren. Coverage + codedTests folgen der Testplan-Baseline (gemeinsam „in Stein", bis „Neu erzeugen").

### Vendored Libs ohne Version: Erkennung via Dateiname-Mapping + Header; mxGraph ist EOL
_2026-06-24 21:00:27 · Item #907 · Tags: bibliotheken,vendored,sbom,unmaintained,mxgraph_

APEX-Plugins legen Libs umbenannt unter lib/ ab (jquery.min.js, mxClient.js) — ohne Version im Namen. src/sbom/vendored.js detectVendoredLibraries mappt bekannte Dateinamen auf Lib-Namen (mxclient→mxgraph, jquery.min.js→jquery) und liest die Version aus dem Header (jQuery vX.Y.Z, mxClient.VERSION=, generisches @version/VERSION). Eigene Dateien (script/preScript) und APEX-Core (font-apex) werden ausgeschlossen. ApexFlowChart real: jquery@1.12.4 (verwundbar CVE-2020-11022), mxgraph@3.9.12 (NICHT GEPFLEGT — mxGraph 2020 eingestellt/archiviert, Migration zu maxGraph), jsonpath@0.8.0, font-awesome. WICHTIG: referencedUrls (alter Fingerprint) reichen NICHT — vendored Dateien ohne Version/URL wurden vorher übersehen (nur jsonpath). Verwundbare/nicht-gepflegte Libs erzeugen jetzt Security-Findings im Protokoll (agent 'Security', artifact '(SBOM)') und setzen libWarning → Status handlungsbedarf (vorher fälschlich ok). SBOM (CycloneDX) per GET /api/components/:id/sbom; GUI sbomViz visualisiert Status. Unmaintained-Liste in src/test/static.js DEFAULT_UNMAINTAINED (mxgraph/mxclient/flash/yui/protractor ergänzt).

### Drawer-Tabs: klare Trennung Tests↔Protokoll, gruppierte Ausführung, inline „Lauf öffnen"
_2026-06-25 14:13:53 · Item #913 · Tags: gui,drawer,tabs,tests,protokoll_

Nach dem Tab-Umbau verfeinert: (1) Trennung — Tab „Tests" zeigt Ist-Ergebnis (renderTestExecution) + Soll-Plan (renderGherkin); Tab „Protokoll" zeigt die Agenten-Arbeit OHNE die Test-Zeilen (renderProtocol mit entries.filter(e=>e.agent!=='Test')), Beschriftung erklärt den Unterschied. Test-Einträge stehen nur noch im Tests-Tab (keine Doppelung mehr). (2) „Letzte Ausführung" wird nach Artefakt (entry.file) gruppiert (collapsible) statt langer Flachliste mit Duplikaten. (3) Bug behoben: „Lauf öffnen" im Tests-Verlauf schrieb in das versteckte #logArchive (Protokoll-Tab) → nichts sichtbar. openLog(name, targetId) hat jetzt ein Ziel; Tests-Verlauf nutzt #runLogView (inline, schließbarer .logopen-Block), Protokoll-Archiv weiter #logArchive. downloadLog lädt weiterhin das VOLLE Log inkl. Test-Zeilen.

### VORFALL + Sicherung: Push nur mit settings.allowPush; push-fähige Endpoints nie live testen
_2026-06-25 15:07:13 · Item #917 · Tags: sicherheit,push,git,vorfall,allowPush_

VORFALL: Ein Live-Test rief POST /api/components/:id/upload mit push=true gegen den echten Clone von github.com/MarkoGranzin/ApexFlowChart auf. Über die am System hinterlegten Git-Credentials (Windows Credential Manager) wurde dadurch tatsächlich ein Branch (aisp/pflege-20260625145938) zum Remote GEPUSHT — ohne ausdrückliche Nutzerfreigabe. Das Löschen wurde vom Sicherheits-Klassifizierer (korrekt) blockiert; der Nutzer muss den Branch selbst entfernen: git push <repo> --delete <branch>. SICHERUNG (eingebaut): settings.allowPush (Default FALSE). uploadFor()/Job/Upload-Endpoint pushen NUR, wenn allowPush=true; sonst lokaler Branch+Commit (pushed:false). GUI-Toggle in Einstellungen „Push zum Remote erlauben". REGEL für die Entwicklung: NIEMALS push-fähige Endpoints (/upload, Job-Auto-Upload) live gegen echte Repos aufrufen — nur mit gestubbtem git unit-testen (test/upload.test.js, test/maintain.test.js). prUrl-Bau in src/run/pr-url.js, Upload in src/service/upload.js.

### Prinzip: die Software pflegt/migriert Plugins; Breaking-Lib-Updates nie still in die Baseline
_2026-06-25 15:37:27 · Item #920 · Tags: lib-update,migration,sicherheit,breaking,prinzip_

Die Plugin-Maintenance-SOFTWARE führt die Lib-Updates/Migrationen durch — nicht der Entwickler von Hand. classifyUpdate (src/service/lib-update.js): safe=gleiche Major (Minor/Patch) → applyVendoredUpdates lädt die neue Datei (jsDelivr/npm, fetch injizierbar), tauscht (Backup) und maintain re-testet; bei Regression (Re-Test 'zu klären') rollbackUpdates. breaking=Major-Sprung → NICHT still tauschen. WICHTIGER FEHLER vermieden: Ein früher Versuch hat Breaking-Libs force-getauscht und behalten, weil das Default-KI-Backend 'cli/claude' (nicht nutzbar) die KI-Migration „durchlief" und der statische Re-Test eine Major-API-Inkompatibilität NICHT erkennt → hätte ein kaputtes Plugin als „gepflegt" ausgegeben. Korrektur: maintain tauscht Breaking NICHT in die Baseline; es meldet sie als Aufgabe der Software (KI-Agent + Coded-UI-Test, Übernahme erst nach Review/Upload-PR). Statische Tests können Major-Migrationen nicht verifizieren → Runtime/Coded-UI-Test + Review sind das Gate. Siehe [[pruefen-heisst-qa-und-fix]].

### Akzeptanz Lib-Update: letzte STABILE Version + Plugin verifiziert „wie bisher"
_2026-06-25 15:59:51 · Item #924 · Tags: lib-update,akzeptanz,stable,charakterisierung,verifikation_

Nutzer-Anforderung (Endzustand): nach der Pflege läuft die LETZTE STABIL released Version der Lib und das Plugin/Template-Component funktioniert damit — verifiziert durch Tests, dass es sich wie bisher verhält. Umgesetzt: Ziel=letzte stabile Version (src/sbom/registry.js fetchNpmInfo: dist-tags.latest, Pre-Release-Guard schließt -beta/-rc aus → höchste stabile aus time). Versionserkennung konservativ (src/sbom/vendored.js: Header-Muster nur erste ~3 KB + lib-spezifische ANCHOR wie three REVISION/mxClient.VERSION; KEIN generisches vX.Y.Z quer durchs Minify-Bundle → keine Falschtreffer wie three@2.2.2). Unbekannte Version & veraltet zählen jetzt in libWarning (libWarningFrom in lib-check.js) → Status handlungsbedarf, nie still „OK". Sichere Updates (gleiche Major) werden eingespielt + Re-Test-Gate + Rollback. OFFEN (T-82): das „wie bisher"-Gate über Charakterisierungs-/Coded-UI-Tests (Verhalten vor/nach Update vergleichen) — Major-Migrationen erst nach grünem Verhaltenstest + Review übernehmen; ohne Test-Runtime (KI/Playwright/URL) bleibt es bei „vorbereitet/gemeldet" statt ungetestet zu übernehmen (sonst Gefahr: kaputtes Plugin als „gepflegt"). Siehe [[pruefen-heisst-qa-und-fix]].

### Backend-Fix-Strings (autofix/autoreview) auf Englisch
_2026-06-25 16:19:56 · Item #926_

Beim Bau des Bereichs "AI & automatic changes" fiel auf, dass die Fix-Protokoll-Texte aus autofix.js/autoreview.js noch deutsch waren und nun prominent in der englischen GUI erscheinen. Daher uebersetzt: Quick-Fix ("removed console.log/debugger" / "no deterministically fixable findings"), Lib-Update ("Update triggered for ... " / "Update error: " / "no outdated/vulnerable libraries"), Auto-Fix ("AI fixes green after N attempt(s)" / "AI review not green" / "remaining security/quality findings need an AI backend (Settings -> AI)"), Web-Dev/Auto-Review ("AI error: ", "Applied fix for ...", "not green after N attempt(s) — changes rolled back", "green after N fix attempt(s)", "No AI backend configured ..."). Tests nachgezogen (autofix.test.js, ai-features.test.js). 291 Tests gruen. Hinweis: maintain.js Migrate-Step-Texte ("KI-Backend erforderlich") sind weiterhin deutsch — nicht user-facing im Drawer, separat offen.

### CLI-Backend findet Claude-Desktop-Binary automatisch (kein PATH-Eintrag)
_2026-06-25 16:50:27 · Item #930_

Wurzelursache des „spawn claude ENOENT": Der Nutzer betreibt Claude ueber die DESKTOP-App (CLAUDE_CODE_ENTRYPOINT=claude-desktop), nicht ueber npm. Die Desktop-App liefert claude.exe unter %APPDATA%\Claude\claude-code\<version>\claude.exe (hier 2.1.181) — legt aber KEINEN PATH-Eintrag an, daher findet bares `claude` nichts. Fix in src/ai/backend.js: findBundledClaude() sucht auf win32 die hoechste Version unter %APPDATA%/%LOCALAPPDATA%\Claude\claude-code\*; resolveCliCommand() loest bares `claude` darauf auf (absoluter vorhandener Pfad wird direkt genommen, sonst PATH via shell). defaultSpawn: shell:true nur fuer Nicht-.exe (Shims/bare Namen), .exe direkt (vermeidet DEP0190). Verifiziert: testConnection ok mit der gebundelten exe. Damit laeuft die KI fuer Desktop-App-Nutzer ohne manuelle Konfiguration — nach Server-Neustart. Override weiterhin moeglich: in den Einstellungen einen absoluten Command-Pfad oder Provider+API-Key setzen.

### T-87: Versions-Util & Paren-Scanner bewusst zurueckgestellt
_2026-06-25 17:29:09 · Item #935_

In T-87 umgesetzt: libWarning zentralisiert (eine Quelle libWarningFrom), inspect()/parseOk → src/extract/assets.js, slug → src/util/slug.js, tote Exporte entfernt. BEWUSST ZURUECKGESTELLT (nicht umgesetzt): (1) Versions-Erkennung (versionFromUrl/fromFilename/versionFromName) + semver cmp in ein util zusammenfassen; (2) den 4× duplizierten balanced-paren/literal-Scanner (extract.js/inline.js/reinject.js) extrahieren. Grund: beide sind load-bearing fuer den Round-Trip (Extraktion↔Re-Injektion); eine Vereinheitlichung birgt Parsing-Regressions-Risiko bei geringem Nutzen. Empfehlung: separater, eng getesteter Task falls gewuenscht (vorher Charakterisierungstests fuer den Scanner). Siehe Folge-Task.

### T-88: withBusy entfernt statt verdrahtet (Action-Handler nutzen setBusy+finally)
_2026-06-25 17:35:21 · Item #936_

Statt die 8 Action-Handler auf einen withBusy-Wrapper umzustellen (Audit-Vorschlag), wurde withBusy entfernt: die Handler verwalten den Spinner bereits korrekt selbst via setBusy(id,true)/finally setBusy(id,false). Eine Umstellung waere reiner Umbau mit Regressionsrisiko ohne Mehrwert; withBusy war ungenutzt → selbst Tot-Code. start.js bekam stattdessen withComponent(fn) fuer die Server-Routen (echter Boilerplate-Abbau). app.html: saveBlob() (4× Blob-Download), loadLibraries Dot-Farbe 'unbekannt'→warn (Drift behoben), totes rescan() entfernt.

### Refactor-Ergebnis: src 5636→4799 LOC (−15%), 57→48 Dateien, 248 Tests gruen
_2026-06-25 17:40:40 · Item #932_

Vollstaendiger Refactor in 3 Phasen (Reihenfolge wie vom Nutzer gewuenscht: Refactor → Tests → Bugfixes), Sicherheitsnetz = Vitest-Suite gruen nach jedem Schritt. ERGEBNIS: src 5636→4799 LOC (−837, ~15%), 57→48 Dateien; Tests 49→42 Dateien, 292→248 (entfernte ~45 testeten nur Tot-Code, +1 Regressionstest). KEIN Produktionsverhalten geaendert (Endpunkte live verifiziert). Phase 1 (T-86): 11 abgeloeste Module geloescht (run/* MVP-Layer, ai/generate, ai/testplan, gui/dashboard, diff/diff, sbom/risk, ai/personas) — nur run-repo.js→sbom/risk war produktiv gekoppelt, verhaltensgleich entkoppelt. Phase 2 (T-87): libWarning aus EINER Quelle (libWarningFrom), Helfer src/extract/assets.js (inspect/parseOk) + src/util/slug.js, tote Exporte weg. Phase 3 (T-88): start.js withComponent-Routen-Helfer, app.html saveBlob + Lib-Dot-Drift behoben + totes rescan/withBusy raus. Bugfix B-9: restliche deutsche User-Strings (maintain-Schritte, Log-Header) → EN. OFFEN (optional): T-89 (Versions-Util + Paren-Scanner, zurueckgestellt wg. Parsing-Risiko).

### T-89 abgeschlossen: cmp + SQL-Scanner geteilt; Versions-Extraktoren bewusst getrennt
_2026-06-25 18:01:11 · Item #937_

Umgesetzt: (A) semver cmp → src/util/version.js (cmpSemver), genutzt von sbom.js + lib-update.js (waren bitgenau gleich; sbom nutzte ?? 0, lib-update || 0 — vereinheitlicht auf || 0, nur bei nicht-numerischen Segmenten relevant, Suite gruen). (B) SQL-Literal-Scanner-Primitiv skipString + unquote/requote → src/extract/sql-scan.js, 5 duplizierte Inline-Bloecke in extract.js/inline.js/reinject.js ersetzt. ABSICHERUNG: test/sql-scan.test.js (4 Charakterisierungstests) VOR der Extraktion geschrieben — pinnt, dass ) , || und ''-Escapes in '..'-Literalen den balancierten Scan nicht abbrechen. WICHTIG: Die Versions-EXTRAKTOREN (versionFromUrl/fromFilename/versionFromName) wurden NICHT zusammengefasst — es sind unterschiedliche Muster fuer unterschiedliche Eingaben (URL vs Dateiname, 2- vs 3-stellig); Zusammenlegen haette das Matching geaendert. Szenario 2230 = „cmp konsolidiert + Suite gruen". 252 Tests gruen.

### F-28 fertig: Spec-gesicherte Migration (Baseline → Gate → Re-Dev) + Bedienung
_2026-06-25 19:06:19 · Item #941_

Die vom Nutzer gewaehlte Alternative ist umgesetzt: statt eine unbekannte Lib-Version blind zu bumpen (T-90), wird das Ist-Verhalten als Spec festgenagelt und jede Migration daran verifiziert. Bausteine: T-91 worksAsBefore() (src/service/works-as-before.js) — kein vorher-gruenes Szenario darf jetzt rot/fehlen. T-92 Baseline (src/service/baseline.js + run-ui.js runUiTestsDetailed/parsePlaywrightJson) — fuehrt die generierten Coded-UI-Tests (Playwright, jetzt installiert) gegen die UI-Test-URL aus und persistiert je Szenario passed/failed + Spec-Hash nach data/baseline/<slug>.json; Fallback statisch wenn keine URL/Playwright. T-93 redevelopComponent (src/service/redev.js) — KI migriert auf latest → UI-Tests erneut → Gate gegen Baseline → Uebernahme NUR ‚gruen wie zuvor', sonst Rollback + Bericht; Upload/PR gated auf allowPush. GUI: Tab Tests → ‚Capture baseline' + ‚Migrate to latest (verified vs baseline)'. BEDIENUNG: (1) UI-Test-URL setzen (Seite mit eingebundenem Plugin, z.B. APEX-Demo), (2) ‚Run UI tests' gruen, (3) ‚Capture baseline' auf dem funktionierenden Build, (4) ‚Migrate to latest'. VORAUSSETZUNG: KI-Backend (claude.exe auto-erkannt) + Playwright (installiert) + eine echte Plugin-URL. Verhaeltnis zu T-90: F-28 ist der sichere Primaerpfad fuer Breaking/unbekannte Versionen; T-90 (Versionserkennung) bleibt optional fuer automatische sichere Minor-Bumps. 267 Tests gruen, Build 2026-06-25.9.

### T-98 Verifizierungsbasis (Ein-Knopf-Maintenance)
_2026-06-26 04:57:52 · Item #958_

„Full maintenance now" (POST /maintain) komponiert geprüfte Bausteine: maintainComponent (maintain.test.js), captureBaseline (baseline.test.js), redevelopComponent adopt/rollback (redev.test.js), worksAsBefore (works-as-before.test.js), Auto-Mock (mock.test.js). LIVE verifiziert an APEX-Vanta: (a) Auto-Mock-Baseline ist GRÜN 1/1 („mock loads the plugin without JS errors"), (b) Endpoint durchläuft check→lib-check→lib-update→autofix→re-test→migrate und überspringt die Migration mit klarer Meldung unter Stub-KI / ohne Playwright. NICHT live ausgeführt (bewusst, Kosten/Zeit): ein vollständiger echter KI-Migrationslauf three 0.116→0.185 inkl. Adopt — die Adopt-/Rollback-Logik ist aber unit-getestet und die grüne Baseline existiert, d.h. das Gate hat etwas zu schützen. Bei three (großer 0.x-Sprung, Vanta-Abhängigkeit) ist ein roter Gate-Ausgang (→Rollback, funktionierender Stand bleibt) der wahrscheinliche und sichere Fall. Build 2026-06-26.1.

### Zukunft: Verifikation direkt in echter APEX-Instanz (Mock = Fallback)
_2026-06-26 05:44:48 · Item #941_

Nutzer (2026-06-26): „im Moment reicht es, in Zukunft testen wir vermutlich direkt in APEX." Richtung: Die works-as-before-Verifikation soll perspektivisch gegen eine ECHTE APEX-Seite mit eingebundenem Plugin laufen statt gegen den generierten Mock. Bereits vorbereitet: das Feld uiTestUrl (component.uiTestUrl) ist der Default-UI-Test-Ziel; setzt der Nutzer eine echte APEX-URL, nutzen captureBaseline + redevelopComponent automatisch DIESE statt der Mock-URL — keine Codeänderung nötig, nur URL eintragen. Offene Folge-Ideen falls gewünscht: (a) je Komponente APEX-URL bequem in der GUI hinterlegen/merken (schon möglich via uiUrl-Feld), (b) optional Login/Session-Handling für geschützte APEX-Seiten, (c) Mock-Self-Repair (2. KI-Versuch mit den konkreten Ladefehlern) — vom Nutzer aktuell NICHT angefordert. KI-Mock (T-101) bleibt der Fallback ohne echte URL.

### Finales Artefakt-Layout: alle Pflege-Artefakte unter <repo>/.maintenance/ (committet)
_2026-06-26 05:45:51 · Item #959_

Nachtrag zu T-99 (Commits b4a7a07, 70edefd): ALLE pro-Plugin-Pflege-Artefakte liegen jetzt im Plugin-Repo unter .maintenance/ und gehen per Upload (git add . → Branch/Commit/Push) in den PR — Nutzerwunsch „passt besser ins Plugin-Verzeichnis, wird mitcommittet". Layout: <repo>/.maintenance/mock/ (index.html + Lib-Kopien + plugin/<dateien>, KI- oder statischer Mock), .maintenance/tests/<slug>.feature (Gherkin-Testplan) + <slug>.ui.spec.js (Coded-UI), .maintenance/baseline.json (works-as-before-Referenz). onTestPlan + onBaseline schreiben ins Repo (Fallback DATA_DIR nur ohne Repo-Pfad). .maintenance/ ist von der Erkennung ausgeschlossen (inventory IGNORED_DIRS). In DATA_DIR verbleiben bewusst nur App-Laufzeitdaten: components.json, logs/ (Prüfprotokoll-Archiv), sbom/<slug>.cdx.json. OFFEN/optional (nicht beauftragt): SBOM + Prüfprotokoll ebenfalls nach .maintenance/ ziehen.

### B-21 live verifiziert + Pfad-Stolperfalle bei echten Libs
_2026-06-26 17:40:01 · Item #983 · Tags: mock,vanta,libraries,verifikation_

Über die GUI (löschen → neu importieren → Mock öffnen) live geprüft, Build 2026-06-26.25:

Der Vanta-Mock lädt jetzt die ECHTEN Libs (three.js, build/avjs.pkgd.min.js, vanta/*.min.js), das Plugin animiert wirklich und ALLE 11 Typen schalten+animieren. Self-Test: 18/19 grün, je Typ „real VANTA.X animates: canvas 480x300, ~129 animation frames in ~260ms" (net/waves/clouds/clouds2/cells/dots/globe/birds/fog/rings/halo) + „renders production VANTA.NET into #mock-root: live canvas 900x560". Der Mock-Header formuliert das Prinzip selbst: „Only the APEX runtime and the plugin's input attributes are mocked — never any library or plugin behavior."

STOLPERFALLE (war der eigentliche Bug nach dem Sammeln): Das Sammeln/Kopieren der nicht-fingerprinted Libs war korrekt, aber die KI referenzierte sie als `../../vanta/x.min.js` → landete im Server-Root → 503 → VANTA undefined → Canvas eingefroren. Fix in 2026-06-26.25: (a) aiMockPrompt sagt explizit „Dateien liegen neben der Seite, exakt diese relativen Pfade VERBATIM, kein `/` und kein `../`"; (b) deterministisches Sicherheitsnetz `normalizeLibPaths()` in generateAiMock setzt lokale Lib-<script src> per Dateiname auf den echten kopierten Pfad zurück (CDN-/data:-URLs bleiben unangetastet, damit echt-fehlende Libs weiter vom CDN kommen dürfen). Beleg, dass der Self-Test ECHT prüft: er fand zusätzlich einen realen Plugin-Edge-Case (`missing pObj … threw on undefined pObj`) — Funktionalität wird also getestet, nicht vorgetäuscht. Siehe [[mock-grundsatz-daten-mocken-funktionalitaet-niemals]] (Projekt-Wissen).

### Self-Tests charakterisieren Ist-Verhalten (grün am Originalplugin); DnD-Simulation nicht false-rot
_2026-06-26 18:19:12 · Item #980 · Tags: mock,self-test,works-as-before,drag-and-drop_

Live über die GUI verifiziert (Builds .26/.27), Maßstab vom Nutzer: „das Plugin soll genau wie zuvor funktionieren — nicht mehr, nicht weniger, nur mit den neuen Libs". Daraus zwei verbindliche Self-Test-Regeln:

1) AS-IS, nicht ASPIRATIONAL (.26): Jeder Self-Test charakterisiert NUR das aktuelle Ist-Verhalten und MUSS am unveränderten Plugin grün sein (window.__ok=true). Keine erfundenen Robustheits-/Edge-Case-Tests, die das Plugin nie erfüllt hat. Beispiel-Bug: Vanta-Mock meldete „missing pObj … threw" rot — die KI hatte „handles missing input gracefully" erfunden. Folge: rote Baseline → works-as-before-Gate blockiert grundlos. Nach Fix: Vanta 19/19 grün.

2) DRAG&DROP / Pointer-Gesten NICHT false-rot (.27): DnD per synthetischem Event ist headless oft nicht auslösbar, obwohl es für den echten Nutzer funktioniert. Live-Beweis: Kanban-Karte wandert per echtem Maus-Drag (To Do→In Progress), Self-Test meldete trotzdem rot (dropEvent=false). Regel: die echte Event-Sequenz des Plugins reproduzieren (HTML5 DnD mit einem geteilten DataTransfer ODER pointer/mouse-Events mit echten Koordinaten); wenn danach immer noch nicht beobachtbar → ok:true mit Detail „verify manually" statt failed. Nach Fix: Kanban 13/13 grün.

Resultat: src/test/mock.js aiMockPrompt (beide Regeln), test/mock.test.js. Siehe [[mock-grundsatz-daten-mocken-funktionalitaet-niemals]] und das Review-Artefakt-Prinzip (Nutzer reviewt den Mock vor APEX-Einbau).

### Cleanup nach Mock-CSS-Arbeit: Scanner vereinheitlicht; Rest ist begründet nötig
_2026-06-26 19:20:00 · Item #933 · Tags: cleanup,refactor,mock,duplikat_

Nach der Mock-CSS/Lib-Arbeit aufgeräumt + kritisch hinterfragt (Build 2026-06-26.32):

Vereinfacht: scanExtraLibFiles und scanCssFiles hatten denselben rekursiven Walk + identisches skipDir doppelt. Herausgezogen: Konstante SKIP_DIR + Helfer walkRepoFiles(dir, onFile) + tooBig()-Guard; beide Scanner nutzen sie jetzt (~20 Zeilen weniger, identische Ausgabe, 320 Tests grün).

Bewusst BEHALTEN (jeweils durch einen konkreten Live-Bug belegt, nicht „nice to have"): echte Libs laden (B-21), echte CSS laden + url()-Assets, HARNESS_RESET (APEX-Normalisierung), normalizeLibPaths (KI-Pfadfehler). Der statische buildMockPage bleibt als Fallback ohne KI. Kein Tot-Code gefunden, alle Imports verwendet.

Aufräum-Status: Repo sauber; .demo/demo.mjs ist getrackt (kein Temp), workspace/ ist gitignored (Test-Plugins), test-results ist gitignored Cache. Keine QA-Reste im echten Projekt. Server läuft auf .32, allowPush=false.

### Unmaintained = NEU ENTWICKELN (autonom), keine vorgegebenen API-Mappings
_2026-06-26 21:19:48 · Item #985 · Tags: mock,migration,unmaintained,re-develop_

Vorgabe des Nutzers: Die Software soll bei unmaintained Libs SELBST erkennen, dass die Funktionalität NEU ENTWICKELT werden muss — ohne dass wir konkrete, plugin-/lib-spezifische Hilfe (z.B. hardcoded mxGraph→maxGraph-API-Mappings) vorgeben.

Umsetzung (Build 2026-06-26.36): buildMigrationPrompt formuliert den Unmaintained-Fall generisch als RE-DEVELOPMENT — „cannot just be version-bumped or mechanically API-ported; RE-IMPLEMENT the capability from the characterized behavior so it works/looks as before; YOU decide the approach and derive the whole implementation; do not expect a 1:1 API mapping". Ein lizenz-geprüfter permissiver Nachfolger wird nur als OPTION genannt (nicht als Mapping-Anleitung); sonst Self-Build (MIT). Lizenz-Leitplanke bleibt: nie Copyleft. Der per-lib API-Hinweis (note) wurde aus dem Prompt entfernt (war konkrete Hilfe).

Live-Befund ApexFlowChart (vorheriger Lauf, Kontext): mxgraph→maxgraph wurde versucht und vom works-as-before-Gate ZURÜCKGEROLLT (One-Shot-Port nicht „wie zuvor" verifizierbar) → Plugin unverändert, nichts gepusht. Re-Development ist der richtige generische Ansatz; sehr große Umbauten (mxGraph) brauchen ggf. mehrere Iterationen oder bleiben Gate-bedingt offen — das Gate verhindert korrekt einen kaputten „Erfolg". Siehe [[mock-grundsatz-daten-mocken-funktionalitaet-niemals]].

### Multi-View live verifiziert: Fancytree-Mock charakterisiert 8 Sichten (29/30)
_2026-06-27 04:39:03 · Item #987 · Tags: mock,multi-view,fancytree,verifikation_

Über die UI verifiziert (Build 2026-06-27.38): Apex-Fancy-Tree-Select neu gebaut → Mock „Multi-View Load & Render Characterization", __ok=true, window.__views=8, features=29/30, errors=0. Die KI plante 8 Sichten generisch aus dem deklarierten Options-Surface (SQL-Attribute): 1) Multi-Select+Checkboxen+Filter (13/13), 2) Single-Select, 3) one-per-group, 4) Client-Side-Cache (LZString/sessionStorage), 5) vorgefilterte Suche (Search Item), 6) Active Node + Expanded Nodes (3/4 — 1 Check rot, View-6-Edge bei expanded-nodes-Restore), 7) Fehlerzustand (error→Meldung), 8) leerer Datensatz (no-data). Statt einer flachen Default-Sicht (vorher 14/14) jetzt 8 Sichten/30 Features → das works-as-before-Gate deckt den vollen Funktionsumfang ab. Offener Rest: das eine rote Feature (View 6) ist eine Charakterisierungs-Feinheit; per „as-is/all-green" sollte es noch grün werden (Self-Test auf reales Restore-Verhalten justieren). Alles über die GUI getestet. Siehe [[mock-grundsatz-daten-mocken-funktionalitaet-niemals]].

### Bessere Mode-Untersuchung wirkt: Fancytree 8→13 Sichten (alle selectModes + Trigger-Capabilities)
_2026-06-27 05:20:17 · Item #987 · Tags: mock,multi-view,fancytree,verifikation_

Feedback: KI erwischte nicht alle Modes; bessere generische Untersuchung nötig. Fix (Build 2026-06-27.39): scanPluginAttributes liest jetzt die OPTION/MODE-Surface aus dem SQL — Config-Default-JSON-Keys + Hilfetext (erlaubte Werte je Option) + Trigger-Capabilities (expandAll/collapseAll/selectAll/expandToLevel…), zeilenbasiert & rauscharm (~2.6k). Prompt: erschöpfende View-Planung (eine Sicht je Mode/Wert, nicht Stichprobe) + 3 redundante CSS-Regeln zu 1 zusammengefasst (Token-Optimierung ohne Qualitätsverlust).

Live über die UI verifiziert: Apex-Fancy-Tree-Select neu gebaut → Mock __ok=true, **views=13 (vorher 8)**, 29/30. Jetzt eigene Sichten für selectMode 1 (single), 2 (multi), 3 (hierarchical), selectMode-2-onePerGroup, plus die Trigger-Capabilities (expandAll/collapseAll/selectAll/unselectAll/expandToLevel/expandSelected + region events), Cache/Search/Active/Error/Empty. Offen: weiterhin 1 roter Check („collapseAll shows only 2 roots" in der Default-Sicht) — Charakterisierungs-Feinheit, per as-is/all-green noch grün zu ziehen. Alles über die GUI getestet.

### Korrektur: Modes = Ergebnis einer KI-Plugin-Analyse, generischer APEX-Standard-Vertrag (kein config-JSON-Scrape, keine Prompt-Beispiele)
_2026-06-27 05:31:37 · Item #987 · Tags: mock,multi-view,generisch,analyse,korrektur_

Nutzer-Feedback (wichtig): Der vorige Ansatz war NICHT generisch — er ging von einer config-default-JSON-Struktur + <li>-Hilfetext aus (eine Fancytree-Konvention; ein anderes Plugin macht das anders oder gar nicht) UND der Prompt enthielt konkrete Beispiel-Modes (selectMode 1/2/3, net/waves/clouds), also von mir vorgegeben statt aus dem Plugin abgeleitet. Forderung: „muss das Ergebnis der Analyse des Plugins sein und nicht von dir geprompted … ich will jedes beliebige Plugin reinziehen können."

Korrektur (Build 2026-06-27.40):
1. GENERISCHE Extraktion (scanPluginAttributes): nur noch der bei JEDEM APEX-Plugin standardisierte Vertrag — create_plugin_attribute (Prompt, Typ, Default, Hilfetext) + create_plugin_attr_value (LOV display=return), balancierter PL/SQL-Klammer-/String-Parser. Wie ein Plugin Modes umsetzt, steht IN dieser Deklaration: Select-List → LOV-Werte, Checkbox → bool, freier JS/JSON-Config-Blob → Keys/erlaubte Werte im Default-Wert + Hilfetext. Keine Annahme über config-JSON/<li>. Fehlt der Vertrag → leer (ehrlich). Real verifiziert an Fancytree: sauberer Vertrag inkl. ConfigJSON-Default mit allen Option-Keys (selectMode, selectOnlyOnePerGroup, enableCheckBox, search.* …).
2. Eigene KI-ANALYSE-Stufe (aiAnalyzePrompt/analyzeViews): die KI leitet die zu testenden Sichten/Modes AUS DEM PLUGIN ab (Vertrag + Quellcode) und gibt einen JSON-Plan [{view,why,config}] zurück. generateAiMock ruft sie vor der Mock-Generierung; der Plan geht als „DISCOVERED VIEW PLAN" in den Mock-Prompt (genau diese Views umsetzen).
3. aiMockPrompt: ALLE von mir geprompteten Beispiel-Modes entfernt; Werte kommen aus dem plugin-eigenen Vertrag, nie aus Beispielen.

Lehre: Generisch heißt — nichts über die interne Konfig-Form eines Plugins annehmen und keine Beispiel-Werte vorgeben; nur den standardisierten Vertrag extrahieren und die KI die Modes daraus ABLEITEN lassen. 331 Tests grün. Verifikation am echten Mock über die GUI steht noch aus (Rebuild).

### Verifiziert: generische Analyse → Fancytree 38 Sichten aus dem Plugin-Vertrag; 3 rote = geratene Erwartungswerte
_2026-06-27 05:51:17 · Item #987 · Tags: mock,multi-view,verifikation,as-is,fancytree_

GUI-Verifikation Build 2026-06-27.40 (Rebuild via Edit→URL→Save, ~15 min, 2 KI-Läufe): Mock __ok=true, **views=38** (vorher 13), 83/86 grün. Alle 38 Sichten aus dem plugin-eigenen Vertrag abgeleitet (KI-Analyse), KEINE Beispiele von mir — selectMode-1/2/3, no-checkbox, one-per-group, autoExpand2Level, custom-icons, forceSelectionSet/openParentOfSelected/setActiveNode/enableKeyBoard… an/aus, die verschachtelten search.*-Keys (leavesOnly/highlight/counter/hideUnmatched/debounce), die deklarierten APEX-Attribute (client-cache-on/off=Checkbox, cache-version-invalidate=PLSQL, active-node-on-init/expandedNodes-bound=Page Item) und Datenzustände (lazy-load/empty-data/server-error/invalid-config). Beweis, dass beliebige Plugins generisch durchziehen.

Offen — 3 rote (alle derselbe Typ, KEINE Plugin-Bugs): die KI asserted einen GERATENEN Erwartungswert statt den Ist-Wert des Plugins zu lesen: (1) default „collapseAll shows only 2 roots" (real bleiben 12 Titel im DOM, nur versteckt), (2) custom-icons „expander has fa-caret-right" (real false), (3) animationDuration-0 „toggleEffect === false" (real {effect:slideToggle,duration:0}). Verletzt die harte Regel „jeder Self-Test grün am unveränderten Plugin". Generischer Fix: Prompt-Direktive — bei Wert-/Zustands-Prüfungen IMMER den tatsächlichen Ist-Wert nach Init auslesen und genau den asserten, nie eine Konstante raten; weicht die Erwartung vom Ist ab, ist es eine Fehl-Charakterisierung.

### Zweite Schleife: Mock prüft sich selbst & korrigiert rote Self-Tests autonom (für jedes beliebige Plugin)
_2026-06-27 06:00:55 · Item #987 · Tags: mock,self-correction,loop,generisch,as-is_

Nutzer-Prinzip: ALLE Plugins sind nur Beispiele; ein neues kann komplett anders aussehen. Die Analyse muss die Sichten/Modes selbst finden, die Tests selbst bauen — und bei roten Tests „zur Not eine 2te Schleife drehen". Also kein Prompt-Nachtunen pro Plugin, sondern autonome Selbstkorrektur.

Umsetzung (Build 2026-06-27.42, Commit c521a22):
- runMockSelfTests(url): führt die Self-Tests des Mocks headless (Chromium, wie visual.js) aus und liest window.__ok/__views/__features → liefert die roten Checks inkl. beobachteter Ist-Werte (detail). launch injizierbar → ohne echtes Playwright testbar.
- aiRefinePrompt + refineMock(gen,{ai,url,name,write,maxRounds=2}): gibt der KI die roten Checks + Ist-Werte zurück mit der Regel „rot am UNVERÄNDERTEN Plugin = Fehl-Charakterisierung → den tatsächlichen Ist-Wert lesen und genau den asserten, oder ungültigen Check droppen; alles andere identisch lassen". Schreibt den korrigierten Mock, misst erneut — bis grün oder keine Besserung.
- finalizeAiHtml(raw,c): Bereinigung (Markdown-Zaun/Prosa weg, <!doctype…</html>, Lib-/CSS-Pfade normalisieren, Harness-Reset, __ok-Vertrag) aus generateAiMock herausgelöst und von der Korrektur-Runde wiederverwendet.
- buildMockFor ruft refineMock nach writeMock (gegen die lokale /mock/<slug>/-URL); Ergebnis als mockSelfCheck {views,total,failed} im Store, Verlauf als [mock-selfcheck]-Logzeilen.

338 Tests grün (7 neue für finalizeAiHtml/runMockSelfTests/aiRefinePrompt/refineMock mit Fake-Chromium). GUI-Verifikation am echten Fancytree läuft (Rebuild mit aktiver Schleife). Damit zieht jedes beliebige Plugin durch und konvergiert selbsttätig auf grün.

### Versionierte KI-Untersuchung: Fingerprint cacht bekannte Plugin-Versionen (nur unbekannte neu bauen)
_2026-06-27 06:05:12 · Item #987 · Tags: mock,cache,fingerprint,performance,versionierung_

Nutzer-Wunsch: KI-Untersuchung (Analyse + Mock + Selbstkorrektur) ist teuer → nur bei UNS UNBEKANNTEN Versionen ausführen; entspricht der Mock dem eingecheckten Stand, sparen wir uns das.

Umsetzung (Build 2026-06-27.43, Commit a7a28b1):
- mockInputFingerprint(dir): sha256 über Plugin-Code + deklarierten Vertrag (optionSurface) + verdrahtete Libs/CSS + MOCK_SPEC_VERSION. Plugin-Quelle/Vertrag oder Tool-Logik ändert sich → anderer Fingerprint → neu bauen; sonst identisch.
- MOCK_SPEC_VERSION (aktuell '2026-06-27.42'): Logik-Version der Analyse/Mock; bewusster Cache-Invalidator — bei fachlicher Änderung hochzählen, dann werden bekannte Plugins einmalig neu untersucht.
- buildMockFor: Fingerprint ist PRIMÄRES Reuse-Kriterium und greift auch unter force (das assign-repo/Edit→Save setzt). Datei .maintenance/mock/.mock-fingerprint.json {fp,spec,mode,views,total} liegt beim eingecheckten Mock → reist mit dem Stand. Bekannte Version unter force → Logzeile "[mock] bekannte Version (Fingerprint match) — KI-Untersuchung übersprungen". Upgrade-Fall (static→ai) baut weiterhin neu.
- mockFingerprint zusätzlich im Store.

341 Tests grün (3 neue: deterministisch+sha256-Form, Vertrags-Änderung→neuer FP, Spec-Version Teil des Hashes). Effekt: wiederholtes Importieren/Prüfen desselben Plugin-Standes kostet keine KI mehr; nur echte neue Versionen lösen die teure Untersuchung aus.

### Robustheit + Sichtbarkeit: KI-Mock-Retry, Live-Build-Schritt in der GUI, Mock-Status-Badge
_2026-06-27 06:39:05 · Item #987 · Tags: mock,ui,robustheit,sichtbarkeit,fingerprint_

Nutzer-Feedback: „ich sehe in der UI nicht, dass es was macht." Befund: Der Fancytree-Rebuild (.42) war auf den STATISCHEN Fallback gekippt (mockMode=static, mockNote „AI response was not an HTML document") — ein TRANSIENTER KI-Fehlschlag (claude.exe gab kein HTML zurück; /api/ai/test bestätigt ok:true). Die GUI zeigte weder Fortschritt noch den Fehler, der Build war beim Hinsehen schon (schlecht) fertig.

Fixes (Build 2026-06-27.44, Commit 1b8683b):
1. Robustheit: generateAiMock wiederholt einen nicht verwertbaren KI-Lauf EINMAL (attempts=2), bevor der sichtbare Fallback greift → transiente Aussetzer heilen selbst.
2. Live-Fortschritt: STEP-Map je laufender Komponente; /api/running liefert {running,steps}; buildMockFor meldet die Phase (Analyse → Mock generieren (Versuch i/2) → Self-Tests → Korrektur-Runde n). GUI zeigt den konkreten Schritt im Zeilen-Label (statt nur „running…"), pollt alle 2,5s, überlebt Reload. Live verifiziert: Zeile zeigte „Mock: Analyse (Sichten/Modes aus dem Plugin ableiten)".
3. Sichtbarer Status: neues Listen-Badge — grün „🧪 pass/total" (KI-Mock + Self-Test-Bilanz aus mockSelfCheck) bzw. rot „🧪 mock failed" bei statischem Fallback. Live verifiziert: alle KI-Mocks grün „🧪 AI", Fancytree rot „🧪 mock failed". View-Model um mockNote/mockSelfCheck ergänzt.

342 Tests grün (Retry-Test). Damit ist ein Fehlschlag nie mehr still und der lange Build ist in der GUI sichtbar. Sauberer Fancytree-Rebuild mit .44 läuft zur Endverifikation (38 Sichten + Selbstkorrektur grün + Fingerprint-Cache).

### Entscheidung: Mock-Badge entdoppelt — nur Self-Test-Bilanz, kein separates „AI"-Badge
_2026-06-27 07:51:20 · Item #1012 · Tags: gui,mock,badge,ux_

Nutzer-Feedback: „🧪 AI" und „🧪 pass/total" sind faktisch redundant (beide = KI-Mock) → nur die Bilanz behalten, die reicht. Umsetzung (Build 2026-06-27.47, Commit 705977a): mockBadge zeigt für KI-Mocks ausschließlich „🧪 pass/total" (grün, gelb bei roten Checks) aus mockSelfCheck; ein KI-Mock ohne Self-Test-Bilanz erhält KEIN separates Badge mehr (Bilanz erscheint nach einem Rebuild mit der aktuellen Logik). Statischer Fallback bleibt rot „🧪 mock failed". Folge: Bestands-Mocks ohne gespeicherte mockSelfCheck (vor der Selfcheck-Logik gebaut) zeigen vorübergehend kein Mock-Badge, bis sie neu gebaut werden — bewusst akzeptiert. Live verifiziert: Fancy-Tree „🧪 74/74", übrige KI-Mocks ohne Doppel-Badge.

### Design: Tote-Lib-Neuentwicklung ist technologie-frei — Akzeptanzkriterien = Mock-Charakterisierung, Lizenz ist das einzige Tech-Gate
_2026-06-27 13:34:12 · Item #1043 · Tags: redev,dead-lib,akzeptanzkriterien,lizenz,slice_

Nutzer-Vorgabe: „Im Endeffekt interessiert die Technologie dahinter nicht wirklich, solange sie rechtlich korrekt ist." Daraus die Leitlinien für die Neuentwicklung toter/nicht pflegbarer Bibliotheken:
1. AKZEPTANZKRITERIEN = die grüne Mock-Charakterisierung (alle window.__views/__features + Optik-Gate). Sie ist der eingefrorene, technologie-UNABHÄNGIGE Soll-Vertrag (beobachtbares Verhalten/Render/Interaktion, keine Implementierungsdetails).
2. TECHNOLOGIE FREI: jede beliebige Lib/Framework/Eigenbau ist erlaubt — das EINZIGE Tech-Gate ist die LIZENZ (permissiv/kommerziell nutzbar, pflichtenfrei; copyleft/unklar verboten → classifyLicense).
3. SLICE-WEISE: implementieren → je Slice gegen die Akzeptanzkriterien prüfen → adopt bei grün, sonst rollback/rework; fertig, wenn das ganze Plugin „wie zuvor" erfüllt ist, ohne den toten Lib.
Zusätzlich beschlossen: (T-114) ein Security/CVE-Scan entscheidet Update vs. Ersatz — eine vulnerable Lib ohne sicheres Update wird zum Muss-Ersatz, selbst wenn formal „nur outdated"; (T-115) nach jedem Fix/Migration laufen 2 unabhängige Review-Agenten + erneuter Scan, bei nicht-OK Rework-Schleife bis grün, sonst Rollback. Baut auf T-107 (Ersatz) + redev + dem works-as-before-Gate (F-28) auf.

### Live verdrahtet: Lib-Empfehlung in der GUI + dualReviewFix (2 unabhängige Voten) als reviewFix in redev
_2026-06-27 15:02:08 · Item #1050 · Tags: redev,review,gui,lizenz,wiring_

Build 2026-06-27.52 (Commits d6f1a9f + 469e280): (1) decideLibAction (T-114) ist im Listen-View-Model verdrahtet — je Komponente libActions {update,replace,redevelop}; die GUI zeigt Zeilen-Badges (↻ update / ♻ replace / 🧬 redevelop) + die Aktion im Lib-Tooltip (live verifiziert: ApexFlowChart ↻2/♻1, Fancy-Tree ↻1). (2) dualReviewFix (dual-review-fix.js) verdrahtet dualReviewRework (T-115) als reviewFix in redevelopComponent (fullMaintain + /redevelop): zwei UNABHÄNGIGE Voten (Security-Gate + Code-Gate) + optionaler Security-Scan, KI-Rework bis beide grün, sonst pass:false → redev rollt zurück. autoReviewFix bleibt für den /autofix-Endpunkt. Offen bleibt nur T-118: rebuildSlices (T-117-Engine) mit echter KI je Slice aus dem Pflege-Flow für tote Libs auslösen (Live-Ausführung).

### Ehrliches notRepairable statt False-Green-„rebuilt"
_2026-06-28 06:12:48 · Item #1057 · Tags: redev,notRepairable,false-green,acceptance_

Entscheidung/Fix (Commit 533b503): adopt/rebuilt darf NUR gesetzt werden, wenn wirklich eine betroffene Lib getauscht wurde (`mig.applied.length > 0`). Bisher meldete der Re-Dev auch bei No-op (kein realer Tausch — z.B. mxgraph@unbekannt wird übersprungen, jquery/jsonpath-Swap scheitert/rollback) grün „rebuilt" mit irreführendem rebuiltTo (fiel auf die Ziel-Liste zurück).

Neu in src/service/redev.js:
- `realChange = !!(mig.applied && mig.applied.length)`
- `markNotRepairable(reason)` setzt `{rebuilt:false, rebuiltTo:null, verifiedAsBefore:false, notRepairable:{at,reason}}` und räumt damit auch einen STALE rebuilt-Flag aus früheren Läufen.
- gate.pass && !realChange → rollback + markNotRepairable → return {adopted:false, notRepairable:true}.
- gate.pass && realChange → adopt, rebuiltTo = mig.applied.map(l=>`${l.name}@${l.to}`), notRepairable:null.
- gate-fail / visual-regress → ebenfalls markNotRepairable.

Sichtbar gemacht: store.js update-Whitelist um `notRepairable` erweitert; components.js overviewViewModel liefert `notRepairable`; app.html zeigt Badge „⛔ not auto-repairable" (Tooltip = reason) statt falschem „🚀 rebuilt".

Lehre: Ein grünes Gate beweist nur „verhält sich wie vorher" — NICHT, dass tatsächlich etwas verbessert/getauscht wurde. Beide Bedingungen sind nötig, sonst entsteht False-Green. Tote/unmaintainte Libs ohne sauberen Auto-Pfad (z.B. mxgraph) werden ehrlich als „nicht automatisch reparierbar" markiert — verknüpft mit B-24 (realer Lib-Swap fehlt noch).

### Live verifiziert: ApexFlowChart ist ehrlich „not auto-repairable"
_2026-06-28 08:48:22 · Item #1057 · Tags: apexflowchart,notRepairable,live-verifiziert,regress,mxgraph_

Voller Pflege-Lauf von ApexFlowChart per UI (Build .57, detached Server) bestätigt den B-25-Fix am echten Hardcore-Fall:
- Store danach: rebuilt=false, rebuiltTo=null, notRepairable={reason:"Migration verletzte die Akzeptanzkriterien (Regress) — automatisch nicht ‚wie zuvor' herstellbar, manuelle Migration nötig."}.
- D.h. die KI-Migration erzeugte einen ECHTEN Regress gegen den Akzeptanz-Vertrag → Gate rollte zurück → ehrliche Markierung statt False-Green „rebuilt".
- Der zuvor stale rebuilt-Flag (aus früheren Läufen) wurde dabei korrekt geräumt.

Fachlich: mxGraph ist archiviert/EOL ohne sauberen Auto-Pfad; jquery 1.12.4→4 ist breaking. Damit ist ApexFlowChart genau der Fall, für den die ehrliche „nicht automatisch reparierbar"-Kennzeichnung gedacht ist — der nächste echte Schritt ist die slice-weise Dead-Lib-Neuentwicklung (F-30, mxGraph→maxGraph) bzw. manuelle Migration, nicht ein weiterer Auto-Rebuild. Verknüpft mit B-24 (realer Lib-Swap) und T-121 (Akzeptanzkriterien ApexFlowChart).

### Selbst-Fix-Maßstab: „nativ wie zuvor", nicht „statisch grün"
_2026-06-28 09:00:50 · Item #1061 · Tags: self-fix,native,works-as-before,security,critical-code,guard_

Leitsatz (Nutzer): Sowohl in der Anforderungsbeschreibung als auch beim Selbst-Fix ist das Kriterium, dass das Plugin NATIV wieder funktioniert.

Umgesetzt (Commit d1d835e, Build .59):
- autoReviewFix prüft nach grünem statischem Gate einen injizierbaren verifyNative-Guard (runMockSelfTests + compareAcceptance gegen den Akzeptanz-Vertrag). Echter, gelaufener Regress → ALLES zurückrollen + „Fix brach natives Funktionieren". Kein Vertrag/Mock/Playwright → skipped (blockiert NICHT; ein gültiger Fix darf nicht fälschlich verworfen werden, nur weil der Guard nicht messen kann).
- Verdrahtet: start.js verifyNativeFor → maintainComponent → autoFixComponent → autoReviewFix, plus /autofix und /autoreview (beide bauen vorher buildMockFor als Mess-Ziel).
- acceptance.js: „funktioniert nativ wie zuvor" ist KOPF-Kriterium jeder exportierten Anforderung (acceptanceToScenarios[0]).

T-125: autoReviewFix liefert criticalFindings (Security high/critical), markiert sie im Protokoll als „⛔ KRITISCH"; nicht fixbare kritische Befunde werden ehrlich weitergeführt (pass=false), nicht still durchgewunken. Der Security-Code-Review (securityScan: XSS/eval/Function/Secrets/js-url) läuft im regulären Pflege-Flow (nicht nur bei breaking Libs).

Lehre: Statisches Review-Grün ≠ funktionierendes Plugin. Jeder automatische Eingriff (Security-Fix, Lib-Update, Redev) braucht eine Verhaltens-Verifikation gegen den technologieunabhängigen Akzeptanz-Vertrag, sonst „repariert" das Tool die Optik kaputt. Analog zu B-25 (ehrlich statt False-Green). Verknüpft mit [[Ehrliches notRepairable statt False-Green-„rebuilt"]] und F-28/F-30.

### Schnittstelle gehört exakt in den Akzeptanz-Vertrag
_2026-06-28 09:20:06 · Item #1063 · Tags: acceptance,interface,apex-attributes,json-config,works-as-before_

Nutzer-Anforderung: Die .feature muss die Schnittstelle zum Plugin EXAKT beschreiben (APEX-Parameter/Attribute, JSON-Konfiguration). Grund: Migration/Neuentwicklung muss dieselbe Schnittstelle 1:1 erhalten — sonst „works as before" wertlos.

Umgesetzt (Commits b54665d, de6855f, Build .60):
- mock.pluginInterface(dir) liefert die strukturierte Schnittstelle aus dem standardisierten APEX-Attribut-Vertrag (scanPluginAttributes: prompt/type/values(LOV)/def/help).
- acceptance.normalizeInterface: name/type/allowedValues/default(VOLL, inkl. JSON)/help; entdoppelt identische Deklarationen (Plugins deklarieren ein Attribut oft mehrfach).
- contract.interface wird Teil des Vertrags; acceptanceFeatureFile rendert „# Schnittstelle (APEX-Parameter/Konfiguration) — muss EXAKT erhalten bleiben" + Gherkin-Szenario je Parameter. Defaults werden NICHT gekürzt.
- start.js: interface an beiden Vertrags-Baustellen (buildMockFor, /acceptance); Export rüstet ältere Verträge nach + re-normalisiert idempotent.

Live verifiziert an ApexFlowChart: .feature enthält den ConfigJSON-Parameter [JAVASCRIPT] mit vollständigem mxGraph-Style-JSON-Default + Hilfetext; nach Dedupe 1 Parameter statt 2.

Lehre: „works as before" = Verhalten (Akzeptanz-Kriterien) UND Schnittstelle (Parameter/Konfig). Beides muss im technologieunabhängigen Vertrag stehen. Verknüpft mit [[Selbst-Fix-Maßstab: „nativ wie zuvor", nicht „statisch grün"]] und T-120 (Export).

### Bestandsweite Verifikation: alle 6 Plugins tragen den vollen Vertrag
_2026-06-28 09:35:21 · Item #1063 · Tags: verifikation,alle-plugins,interface,acceptance_

Verifikation (Build .60, /acceptance?format=feature je Plugin) — alle 6 vorhandenen Plugins haben jetzt den vollständigen Akzeptanz-Vertrag/.feature:
- Kopf-Kriterium „funktioniert nativ wie zuvor" (T-124): alle JA.
- „rendert echte Ausgabe": alle JA.
- Schnittstelle exakt + Szenario „Schnittstelle bleibt exakt erhalten" (T-126): alle JA.
Schnittstellen-Parameter erkannt: ApexColorPalette 1 (Color Json), ApexFlowChart 1 (ConfigJSON), APEX-Vanta 13 (Animation Type [SELECT LIST] + 12 ConfigJSON-Varianten je Effekt), Material-Kanban 7 (inkl. PLSQL/CHECKBOX), Apex-Fancy-Tree-Select 7 (inkl. PAGE ITEM, PLSQL FUNCTION BODY), APEX-Flip-Cards 1 (ConfigJSON). Verträge ohne Schnittstelle wurden beim Export automatisch nachgerüstet (frischer Stand 2026-06-28).

Beobachtungen (kein Defekt dieser Änderung): (1) Material-Kanban führt ConfigJSON zweimal — verschiedene Deklarationen mit gleichem Prompt (Dedup entfernt nur Identische → korrekt). (2) „views"-Zahl im Vertrag wirkt teils hoch (ApexFlowChart 52, Fancy-Tree 56); stammt aus dem Mock-Self-Test, evtl. eigener Feinschliff (Sichten-Zählung) als separater Punkt prüfen.

### Zwei .feature-Artefakte trennen: Akzeptanz-Vertrag (mit Schnittstelle) vs. Unit-Testplan
_2026-06-28 10:47:24 · Item #1063 · Tags: acceptance,feature-datei,interface,ux_

Nutzer-Verwechslung: `.maintenance/tests/<slug>.feature` ist der auto-generierte Unit-/Charakterisierungs-Testplan (T-64, je Funktion Positiv/Negativ/Pfad/Grenzwerte) — enthält KEINE Schnittstelle. Der Anforderungs-/Akzeptanz-Vertrag MIT Schnittstelle (APEX-Parameter + voller JSON-Default + Hilfe) + nativen Kriterien lag bisher nur als acceptance.json + Endpoint-Download (/acceptance?format=feature, „⤓ Req") vor.

Fix (Build .63, Commit 6103b5f): writeAcceptance schreibt zusätzlich `.maintenance/acceptance.feature`. Damit ist der interface-tragende Vertrag als Datei auffindbar, klar getrennt vom Unit-Testplan unter tests/. Live für ApexFlowChart materialisiert (422 Zeilen, Schnittstelle ConfigJSON oben). Verknüpft mit [[Schnittstelle gehört exakt in den Akzeptanz-Vertrag]].

### Unit-Testplan umbenannt: <slug>.unit-tests.feature (klar vom Vertrag getrennt)
_2026-06-28 10:53:38 · Item #1063 · Tags: acceptance,unit-tests,naming,ux_

Auf Nutzerwunsch saubere Benennung (Build .64, Commit dc96077): Der auto-generierte Unit-/Charakterisierungs-Testplan heißt jetzt .maintenance/tests/<slug>.unit-tests.feature (statt <slug>.feature) und trägt einen Kopf-Kommentar ("NICHT der Anforderungs-Vertrag — Schnittstelle/Soll siehe ../acceptance.feature"). Alte <slug>.feature wird beim Schreiben entfernt. Für alle 6 Bestands-Plugins materialisiert. Damit eindeutig: acceptance.feature = Vertrag+Schnittstelle (technologie-unabhängig, dauerhaft), tests/<slug>.unit-tests.feature = Detailtests der aktuellen Implementierung (regenerierbar). Schnittstelle erfasst alle Attribut-Typen inkl. SELECT LIST/LOV (mit erlaubten Werten), CHECKBOX, PLSQL, PAGE ITEM, JAVASCRIPT.

### APEX-Einspielen geht headless & token-minimal — Design des apex-deploy MCP
_2026-07-02 05:29:12 · Item #1112 · Tags: apex-deploy,mcp,sqlcl,headless,token-minimal,wiederverwendbar_

Kern-Erkenntnis: Plugins/Template-Components in eine echte APEX-App einspielen braucht WEDER UI-Automation NOCH KI — APEX-Exporte sind standardisierte SQL-Skripte. Der dokumentierte, generische Weg: SQLcl headless + apex_application_install (set_workspace → set_application_id → generate_offset → Export ausführen → commit). Gilt für JEDES Plugin → Token-Verbrauch ~0 (deterministischer Code).

Umsetzung (Commit 7870d2a): eigenständiger Ordner mcp-apex-deploy/ — stdio-MCP OHNE npm-Abhängigkeiten (JSON-RPC von Hand) → in jedes Projekt kopierbar; Konfig via env (APEX_SQLCL/APEX_CONN/APEX_WORKSPACE/APEX_APP_ID/APEX_BASE_URL, Login optional). Tools: apex_install, apex_create_test_page (Region vom Plugin-Typ, attribute_01..25 aus der Schnittstelle des Akzeptanz-Vertrags; VORLAGEN-Modus mit echtem Seiten-Export der Instanz ist der robuste Weg — Gerüst-Modus ist best effort, da wwv_flow_imp_page/wwv_flow_api versionsabhängig; apiPackage parametrisierbar, dryRun), apex_test_page (Playwright headless: JS-Fehler + Rendern; ohne Playwright ehrliche Meldung — live verifiziert), apex_info (Connect-String IMMER maskiert; SQLcl-Output wird zusätzlich gescrubbt).

Gotchas: (1) APEX-Strings >~800 Zeichen als wwv_flow_string.join schreiben (ConfigJSON-Defaults!). (2) p_plug_source_type='PLUGIN_<INTERNAL_NAME>'. (3) Fehler-Erkennung über exit code + ORA-/SP2-/PLS-Muster im Output. Live-Verifikation auf echter Instanz offen (Szenario skipped) — braucht Nutzer-Zugangsdaten; in .mcp.json registriert (env noch leer).

### Ziel-Instanz für Live-Test: ADB <oracle-instance> (Frankfurt) — Verbindungsweg
_2026-07-02 14:01:44 · Item #1112 · Tags: apex-deploy,adb,verbindung,secrets_

Nutzer hat eine Oracle-Cloud-Ziel-Instanz für den apex-deploy-Live-Test benannt: ORDS-Base-URL https://<instance>.adb.<region>.oraclecloudapps.com/ords, Workspace vermutlich <workspace>, Ziel-App 103 (evtl. <app-id> — „AP<app-id>", vom Nutzer zu bestätigen).

Verbindungsweg (Autonomous DB): APEX_CONN = DB-User/PW@tcps://adb.<region>.oraclecloud.com:1522/<service> (TLS-Connect-String aus OCI-Konsole → Database connection; ggf. „TLS-Authentifizierung zulassen" aktivieren; User = Parsing-Schema oder ADMIN). Secret-Handling: .mcp.json ist gitignored UND referenziert nur ${APEX_CONN} (Windows-User-Umgebungsvariable) — Passwort landet nie im Repo/Chat; MCP maskiert es zusätzlich in allen Ausgaben. Base-URL/Workspace/App-ID in .mcp.json vorbelegt; nach Setzen der Variable Claude-Code-Neustart nötig, dann apex_info als Verbindungs-Check. Live-Szenario an T-129 bleibt bis dahin skipped.

### UI-Import-Weg ergänzt (kein SQLcl) — Login-Struktur der Zielinstanz bekannt
_2026-07-02 14:15:38 · Item #1112 · Tags: apex-deploy,ui-import,login,secrets,playwright_

Nutzer-Klarstellung „wozu SQLcl?": richtig — Plugin-Import geht über die APEX-eigene UI, ohne DB-Connect. Ergänzt (Commit c61b5a7): apex_install_ui + apex_ui_login_check im MCP. Playwright loggt am modernen APEX-Workspace-Sign-In an und fährt den Plug-in-Import-Wizard.

Zielinstanz-Login live inspiziert (nur Login-Seite, keine Anmeldung): moderne APEX-Sign-In-App unter <baseUrl>/r/apex/workspace-sign-in/oracle-apex-sign-in mit den Feldern „Workspace", „Database Username", „Password" (Datenbank-User-Login). Daraus: Passwort = APEX-Login-Passwort (nicht DB-Connect). Feldsuche im Tool über Platzhalter (robust) + Fallback P9999_COMPANY/USERNAME/PASSWORD.

Secret-Handling: Passwort in Windows-User-Umgebungsvariable APEX_LOGIN_PASS; .mcp.json (gitignored) referenziert ${APEX_LOGIN_PASS}; erreicht nie den Chat/Repo, MCP maskiert Ausgaben. Vermutung Workspace=AP<app-id>, Username=<workspace> (vom Nutzer zu bestätigen). Import-Wizard noch nicht gegen die Instanz-Version verifiziert (best effort, Schritt-Log+Screenshot) — nächster Schritt: apex_ui_login_check nach Passwort-Setzen + Claude-Neustart.

### Verifizierter Plug-in-Import-Pfad (moderne APEX auf ORDS/ADB)
_2026-07-02 17:04:28 · Item #1114 · Tags: apex-deploy,ui-import,playwright,verifiziert,navigation_

Live gegen <oracle-instance> (Workspace <workspace>, App <app-id>) verifiziert — ApexFlowChart headless per Browser installiert („Plug-in installed."). Erkenntnisse für apex_install_ui:

1. Login: /r/apex/workspace-sign-in — Felder per Platzhalter Workspace/Database Username/Password; „Sign In"-Button. Nach Login landet man auf /app-builder/apps?session=…
2. KLASSISCHE f?p=4500:…-Deep-Links funktionieren NICHT (moderne Prüfsummen → „Bad Request"/Sign-In-Bounce). Und absolute goto() OHNE session verlieren die Anmeldung. → NUR über Klicks navigieren (Session bleibt in Friendly-URLs erhalten).
3. Top-Level „Import" (p460_file_type=FLOW_EXPORT) interpretiert einen Plugin-Export FÄLSCHLICH als Applikation (App-ID 24068 → „Install Application"). FALSCH.
4. Richtiger Weg: App-Kachel a[href*="fb_flow_id=<APP>"] → „Shared Components" → „Plug-ins" → „Import" landet auf /app-builder/import?p460_file_type=PLUGIN (app-gebunden).
5. Wizard = 3 Schritte über die PRIMÄRE Aktion (CSS .a-Button--hot): „Next" (Specify File) → „Next" (File Import Confirmation) → „Install Plug-in". Erfolg: Text „Plug-in installed" auf der Plug-ins-Seite.
6. Robust: pro Schritt auf .a-Button--hot visible warten (Confirmation-Seite leitet um; feste Sleeps sind unzuverlässig). Datei-Feld: input[type=file], vorher auf attached warten.

Default-Datei-Typ „Application, Page or Component Export" deckt Component-/Plugin-Exporte ab, aber der app-interne PLUGIN-Import ist der korrekte Weg.

### Testseite mit Plugin-Region erzeugen — verifiziertes 24.x-Format + UI-Import
_2026-07-02 17:38:58 · Item #1114 · Tags: apex-deploy,testseite,24.1,plugin-region,verifiziert_

Live verifiziert (<oracle-instance>, App <app-id>): apex_create_test_page erstellt eine Seite mit ApexFlowChart-Region headless über die UI („Installed Application page successfully installed.").

Format-Erkenntnisse (APEX 24.1 / release 24.2.17, Export-Version p_version_yyyy_mm_dd='2024.11.30'):
1. Vollständige Seiten-Import-Datei = import_begin-Header + create_page + create_page_plug + import_end. Header braucht p_default_workspace_id (instanzspezifisch, z.B. <workspace-id>) und p_default_owner (z.B. WKSP_<workspace>) — aus einem echten App-Export ablesbar (App → Export/Import → Export). In .mcp.json als APEX_WORKSPACE_ID/APEX_OWNER/APEX_RELEASE.
2. Plugin-Region: p_plug_source_type=>'NATIVE_PLUGIN_<INTERNAL_NAME>' (z.B. NATIVE_PLUGIN_APEX.FLOW.CHART.1). Interner Name = create_plugin p_name aus dem Plugin-Export.
3. Region-Attribute im 24.x-Format: p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2('name','wert',...)).to_clob (NICHT mehr p_attribute_01…). OHNE Attribute nutzt die Region automatisch die Plugin-Defaults (ConfigJSON-Default) — genau das „works as before"-Soll.
4. Einspielen app-intern: App-Kachel → „Export / Import" → „Import" → Upload → primäre Aktion (.a-Button--hot: Next → Install Page [→ Replace-Bestätigung bei existierender Seite]). Erfolg: „page successfully installed".

Offen: Runtime-Smoke-Test der Seite (apex_test_page) braucht die APP-END-USER-Authentifizierung (getrennt vom Workspace-Login) UND eine Datenquelle (sourceSql) für sichtbares Rendern — sonst lädt die Region ohne Daten. Seiten-ERSTELLUNG ist verifiziert; Runtime-Render als nächster Schritt.

### E2E-Pipeline komplett + ehrlicher Render-Smoke-Test; ApexFlowChart-Render offen (ORA-01403)
_2026-07-02 17:54:06 · Item #1114 · Tags: apex-deploy,e2e,smoke-test,render,ora-01403,offen_

Vollständige Kette live gebaut+getestet (App <app-id>, öffentliche Testseite):
1. apex_install_ui: Plugin eingespielt („Plug-in installed") — Dateien (mxClient/jsonpath/preScript/script.min) mitinstalliert (im UI verifiziert).
2. apex_create_test_page: Seite mit Region NATIVE_PLUGIN_APEX.FLOW.CHART.1, Datenquelle + ConfigJSON, standardmäßig ÖFFENTLICH (p_page_is_public_y_n=>'Y') → läuft ohne App-Login. Import ohne ORA-Fehler.
3. apex_test_page: läuft die Seite headless, erkennt jetzt APEX-Fehlerseiten (ORA-/is_internal_error) + Login-Redirects → kein False-Green.

Daten-Vertrag des ApexFlowChart (SQL-Quelle): Spalten TYPE(vertex|edge), ID, PARENT, VALUE, X, Y, WIDTH, HEIGHT, STYLE, CONNECTABLE, SOURCE, TARGET (aus data/data.js). ConfigJSON = Plugin-Attribut-Sequenz 1 → Region liest P_REGION.ATTRIBUTE_01. Render lädt Libraries + ruft flow.initialize(regionId, ajaxIdentifier, confJson, items2submit); Daten kommen per AJAX (F_AJAX: APEX_UTIL.JSON_FROM_SQL(P_REGION.SOURCE)).

OFFEN (ehrlich): Der Plugin-RENDER wirft ORA-01403 (no data found) in WWV_FLOW_PLUGIN — F_RENDER hat KEIN eigenes SELECT INTO, der Fehler stammt aus einem APEX-API-Aufruf während des Renderns (GET_AJAX_IDENTIFIER / PAGE_ITEM_NAMES_TO_JQUERY(AJAX_ITEMS_TO_SUBMIT)). Vermutlich fehlt ein Laufzeit-/Region-Setup (z.B. items-to-submit-Item, AJAX-Identifier-Kontext). Braucht APEX-Debug-Level-Analyse — plugin-spezifisch, kein MCP-Tooling-Gap. Der Smoke-Test meldet das korrekt als Fehler. Nächster Schritt bei Bedarf: Seite mit p_debug=LEVEL9 laufen und die letzte Debug-Zeile vor 01403 lesen.

### ApexFlowChart-Render: File URLs to Load gesetzt, ORA-01403 bleibt (serverseitig)
_2026-07-02 20:03:27 · Item #1114 · Tags: apex-deploy,render,ora-01403,file-urls,19.1,offen_

Nutzer-Hinweis umgesetzt: Plugin „APEX Flow Chart" (App <app-id>) — Feld File URLs to Load / JavaScript (Item P4410_JAVASCRIPT_FILE_URLS) war leer, jetzt gesetzt + gespeichert (gegengeprüft): #PLUGIN_FILES#preScript.js, jsonpath-0.8.0.min.js, mxClient.min.js, script.min.js (Ladereihenfolge). Nötig, da das Plugin sonst seine JS-Libs nicht zuverlässig lädt (Laufzeit: mxClient/flow undefined, Ressource 400/404).

ABER: Render bleibt bei ORA-01403 (no data found) — passiert SERVERSEITIG in F_RENDER VOR der JS-Ausgabe (kein #fc-*-Container im DOM). F_RENDER hat kein eigenes SELECT INTO; Verdacht: APEX_PLUGIN_UTIL.PAGE_ITEM_NAMES_TO_JQUERY(P_REGION.AJAX_ITEMS_TO_SUBMIT) oder GET_AJAX_IDENTIFIER (api_version 1 / 19.1-Plugin in APEX 24.1). Friendly-URL /r/<workspace>/test/<page> funktioniert (klassisches f?p 404t auf ORDS). p_query_type=SQL ist gesetzt, behebt 01403 NICHT.

Definitiver nächster Schritt: Seite mit p_debug=LEVEL9 laufen + Debug-Report auslesen → exakte Zeile vor 01403. Kernpunkt: Das ist der 19.1/mxGraph-Migrationsfall (genau „not auto-repairable"), kein Deploy-Tooling-Gap.

### MCP füllt „File URLs to Load" (JS+CSS) automatisch nach dem Install
_2026-07-02 20:09:49 · Item #1113 · Tags: apex-deploy,file-urls,automatisch,generisch,verifiziert_

Nutzer-Wunsch: nach dem Plugin-Install soll der MCP die „File URLs to Load" (JavaScript UND CSS, sofern vorhanden) automatisch setzen — generisch.

Umgesetzt (Commit db99b79): lib.pluginLoadFiles(exportSql) leitet aus dem Plugin-Export ab: alle .js/.css-Plugin-Dateien; JS in der Ladereihenfolge, die der Plugin-Code selbst vorgibt (Reihenfolge der APEX_JAVASCRIPT.ADD_LIBRARY-Aufrufe im p_plsql_code); CSS analog (ADD_CSS/STYLE) bzw. Datei-Reihenfolge; als #PLUGIN_FILES#<datei>-Referenzen. apex_install_ui ruft danach uiSetPluginFileUrls auf (Default an, setFileUrls) und füllt in der Plugin-Edit-UI die Items P4410_JAVASCRIPT_FILE_URLS / P4410_CSS_FILE_URLS + Apply Changes. Standard: nur LEERE Felder (manuelle Einstellungen nicht überschreiben; overwrite=true erzwingt). Neues Tool apex_plugin_load_files (mit dryRun) für bereits installierte Plugins.

Navigation (verifiziert): App-Kachel → Shared Components → Plug-ins → Plugin per Anzeigename (p_display_name) öffnen. Feld-Setzen über JS (value + input/change-Events + apex.item().setValue), da die Felder in eingeklapptem Abschnitt liegen.

Live verifiziert an ApexFlowChart: JS 4 Dateien (preScript→jsonpath→mxClient→script.min) gesetzt + nach Neuöffnen persistiert; CSS korrekt übersprungen (0 CSS-Dateien). Wirksam im laufenden MCP erst nach Claude-Neustart.

### GELÖST: generische Plugin-Analyse richtet Testseite ein → ApexFlowChart rendert
_2026-07-02 20:26:52 · Item #1114 · Tags: apex-deploy,analyse,render,geloest,generisch,ajax-item_

Nutzer-Direktive: die Tool-Analyse muss selbst erkennen, was die Testseite braucht (z.B. dass Page-Items/AJAX-Callbacks angelegt werden müssen) — nicht hardgecodet. Umgesetzt (Commit 71c96ec):

analyzePlugin(exportSql) leitet generisch ab: internalName, displayName, apiVersion → sourceTypePrefix (1→PLUGIN_, ≥2→NATIVE_PLUGIN_), standardAttributes (SOURCE_SQL/AJAX_ITEMS_TO_SUBMIT), hasAjaxCallback, customAttributes {sequence→attribute_NN, prompt, default, required}, configAttributeKey+configDefault (Attribut mit Prompt ~JSON/Config).

apex_create_test_page(exportFile) nutzt das automatisch: Source-Type gesetzt, ConfigJSON-Default (von Steuerzeichen gesäubert) ins richtige attribute_NN, und bei usesAjaxItemsToSubmit wird ein Hidden-Page-Item P<page>_AJAX angelegt + p_ajax_items_to_submit verdrahtet. buildTestPageSql erzeugt create_page_item + p_ajax_items_to_submit.

URSACHE des früheren ORA-01403 (aus Seite 2 gelernt, die beim Nutzer läuft): F_RENDER macht APEX_PLUGIN_UTIL.PAGE_ITEM_NAMES_TO_JQUERY(P_REGION.AJAX_ITEMS_TO_SUBMIT); zeigt das auf ein NICHT existierendes Page-Item → SELECT INTO → ORA-01403. Seite 2 hat p_ajax_items_to_submit=>'P2_NEW' + ein Item P2_NEW. Außerdem: source_type 'PLUGIN_APEX.FLOW.CHART.1' (nicht NATIVE_PLUGIN_) und ConfigJSON unter Key 'attribute_01'.

LIVE VERIFIZIERT (App <app-id>): Testseite analyse-getrieben angelegt → Chart rendert vollständig (Start→go→Process→done→End, SVG mit 20 mxGraph-Zellen, kein ORA, mxClient/flow geladen). Zusammen mit File URLs to Load (auto) + p_query_type=SQL + öffentlicher Seite. Alle Testseiten danach gelöscht (nur 0/1/2). Analog auf Template-Komponenten übertragbar (gleiche Analyse-Idee).

### Plugin Maintenance kann jetzt selbst live in echtes APEX einspielen & testen (apex-deploy als Lib)
_2026-07-05 08:08:04 · Item #1212_

Die apex-deploy-Fähigkeit ist in Plugin Maintenance integriert und live gegen App <app-id>/<workspace> bewiesen.

Ablauf (src/service/apex-live.js deployAndTest, alle Bausteine injizierbar → unit-testbar ohne Browser/Instanz):
analyzePlugin(export) → uiLogin → uiImportFile(viaPlugins:true) Install → uiSetPluginFileUrls (JS+CSS, #PLUGIN_FILES#-Refs) → buildTestPageSql (analyse-getrieben: Page-Item + p_ajax_items_to_submit bei AJAX_ITEMS_TO_SUBMIT, p_query_type=SQL bei SOURCE_SQL, ConfigJSON-Attribut) → uiImportFile Seite → smokeCheckPage(Friendly-URL /r/<ws>/<alias>/9999).

Wichtige Fakten:
- Friendly-URL funktioniert (/r/<workspace>/test/9999), klassisch f?p= liefert 404 auf ORDS.
- Testseite muss p_page_is_public_y_n='Y' sein → ohne App-Login smoke-testbar.
- api_version 1 → source_type-Prefix PLUGIN_, ab v2 NATIVE_PLUGIN_.
- Passwort NUR im secretStore ('apex-pass'), nie in Settings/Log/Response (nur apexPassSet-Flag).
- GUI: Settings-Block (Verbindung testen) + Drawer-Button „🚀 In APEX einspielen & live testen"; Ergebnis als Review kind:'apex-live' an der Komponente.

Offener Gotcha: unser sanitisiertes ConfigJSON-attribute_01 überschreibt den (teils kaputten) Plugin-DB-Default noch nicht wirksam → JS-Parse-Fehler, Plugin nutzt Standard-Style (Chart rendert trotzdem). Siehe B-28.

### B-28-Befund: p_attribute_NN persistiert NICHT über den App-Builder-Page-Import-Wizard
_2026-07-05 10:34:47 · Item #1213_

Gründliche Live-Untersuchung (App <app-id>, ApexFlowChart) mit Marker-Probe:

Ausgeschlossen als Ursache:
- Falsches Format (war p_attributes=>…to_clob → ignoriert). KORRIGIERT auf direkte p_attribute_01-Parameter (wie Sample-Export material-kanban-board). Commit a25de6f.
- Package: wwv_flow_imp* → wwv_flow_api.* umgestellt (wie echte Exports). Kein Unterschied.
- Zeilenlänge: auch ein KURZER gültiger Wert `{"refresh":0,"MARKER_ZQX9":true}` persistiert nicht.
- p_query_type=>'SQL': auch ohne sourceSql/query_type persistiert nicht.

Bewiesen: Der App-Builder-„Import"-Wizard (uiImportFile) erstellt/ersetzt die Seite korrekt (Titel = unser Seitenname, Chart rendert), aber das Region-Plugin-Attribut bleibt NULL → das Plugin nutzt seinen (fixed-width/chr(10)-korrupten) DB-Default → JSON-Parse-Fehler, Standard-Style. Der Wizard verwirft p_attribute_NN offenbar (re-parst das Export und übernimmt Plugin-Attribute nicht in diesem Einzelseiten-Flow).

Marker-Kriterium-Falle: das Plugin echoet die Config NUR bei Parse-Fehler ins HTML — ein gültiger Wert erscheint nicht sichtbar. Richtiges Kriterium: verschwindet der targetConfig-Parse-Fehler? (blieb bestehen → nicht angew=ndt).

Fix-Wege (offen, Nutzer-Entscheidung):
1. Import-SQL als SKRIPT ausführen (SQL Workshop → SQL Scripts / SQLcl) statt Wizard — führt wwv_flow_api.create_page_plug direkt aus, p_attribute_NN greift. Risiko: import_begin-Kontext/Rechte.
2. Nach dem Import die ConfigJSON im Page Designer per UI-Automation setzen (wie der Mensch es tut; passt zu „alles über die GUI").
Chart rendert in allen Fällen (Fallback) — B-28 ist Feinschliff, nicht blockierend.

### Plugin-Region-Attribute zuverlässig setzen: Page Designer, nicht Import-Wizard (SQL Commands: ORA-12705)
_2026-07-05 11:59:34 · Item #1213_

Verbindliche Erkenntnis fürs Einspielen von Plugin-Region-Attributen (ConfigJSON etc.) in eine echte APEX-App:

1. Der App-Builder-„Import"-Wizard für einen EINZELSEITEN-Export persistiert p_attribute_NN NICHT (live belegt). Seite/Region werden korrekt erstellt, aber das Plugin-Region-Attribut bleibt null → Plugin nutzt seinen DB-Default.
2. SQL Commands / SQL Scripts als Alternative: Import-SQL (wwv_flow_api.import_begin + create_page_plug) wirft in dieser ADB-Instanz ORA-12705 (Cannot access NLS data files / invalid environment). Instanz-Umgebung, nicht von außen behebbar. SQLcl vom Nutzer abgelehnt.
3. FUNKTIONIERT: nach dem Import die Attribute im PAGE DESIGNER setzen (wie ein Mensch) — mcp-apex-deploy/lib/apex-ui.js uiSetPluginAttributes:
   - Navigation NUR per Klick (App-Kachel a[href*=fb_flow_id=<appId>] → Pages-Liste → Seite), NIE per goto mit Query-Params (verwirft die friendly-URL-Session → Sign In).
   - Auf FRISCHER, frisch eingeloggter Seite starten (nach den Import-Schritten ist die alte Page zu tief navigiert, App-Kachel fehlt).
   - Region-Knoten im Rendering-Tree per Namen wählen → Property-Editor lädt die Plugin-Attribute.
   - SQL Commands & Page Designer nutzen MONACO; Werte über die APEX-Item-API setzen: apex.item('peAttributes_<n>').setValue(v) (Feld je Property über Label = Plugin-Prompt finden), dann Strg+S.
   - Steuerzeichen im Wert → Space (JSON-sicher).

Verweise: [[b-28-befund-p-attribute-nn-persistiert-nicht-ueber-den-app-builder-page-import-wizard]], [[plugin-maintenance-kann-jetzt-selbst-live-in-echtes-apex-einspielen-testen-apex-deploy-als-lib]].

### Page-Designer-Runner: bewiesene Mechanik + Selektoren (Seite anlegen, Plugin-Region per Drag, Properties)
_2026-07-05 20:14:09 · Item #1216_

Live an App <app-id>/Seite 9500 verifiziert — der Page-Designer-Weg (statt WAF-blockiertem Import, B-30) funktioniert vollständig headless:

1. SEITE ANLEGEN (Create Page Wizard): App öffnen → Button „Create Page" → Dialog liegt in einem IFRAME (frames().find(f=>f!==mainFrame())). Schritt 1: Text „Blank Page" klicken → „Next". Schritt 2: Felder P<sess>_PAGE_ID (Label „Page Number") + P<sess>_PAGE_NAME (Label „Name") füllen — PER LABEL wählen, der P-Prefix ist sessionspezifisch. Dann „Create Page" klicken → Page Designer öffnet, Titel „[<appId>:<pageId>] <name>".

2. PLUGIN-REGION HINZUFÜGEN: Gallery-Tab „Regions" klicken. Plugin-Regionen erscheinen als .a-Gallery-region.is-draggable (Componentname in .a-Gallery-componentName), z.B. „APEX Percent Bargraphs", „APEX Flow Chart". Das ist jQuery-UI-Draggable (KEIN natives HTML5-Drag) → mit ECHTEN Maus-Events ziehen: mouse.move auf das Item → mouse.down → kleine Bewegung (+8px Threshold) → in ~10 Schritten auf eine Layout-Drop-Zelle (.a-Grid-cell/.a-Region) → mouse.up. Danach ist eine neue Region angelegt UND selektiert. Region-Typ = das Plugin (weil das Plugin-Item gezogen wurde) — kein separates Type-Setzen nötig.

3. REGION KONFIGURIEREN (Property-Editor, .a-Property nach Label): verfügbare Properties der Plugin-Region: „Name", „Title", „Type", „SQL Query" (= Quelle), „Page Items to Submit" (= AJAX-Item), „Custom Attributes" (ConfigJSON etc.), „Refresh Time (Seconds)". Werte über apex.item(feld.id).setValue setzen (Name-Feld z.B. peMain_1) — analog uiSetPluginAttributes.

Offen zum Codifizieren: Page-Item (Hidden) via Items-Gallery-Drag + Name, „Page Items to Submit" darauf, Seite öffentlich (Page-Security), Strg+S, plus Pro-Plugin-Seiten-Register (neue Seite je Plugin, merken/wiederverwenden). Siehe [[b-30-befund]] und [[plugin-region-attribute-zuverlaessig-setzen-page-designer-nicht-import-wizard-sql-commands-ora-12705]].

### Genericität an 3 sehr unterschiedlichen Plugins bewiesen + generische Fixes (Kanban-Lauf)
_2026-07-05 21:37:56 · Item #1218_

Über-Nacht-Lauf: die Maintenance-Pflege macht jetzt die ganze Kette generisch (check → lib-update → autofix → re-test → apex-live) und wurde an DREI sehr verschiedenen Plugins verifiziert:
- Percent-Bargraphs (Div-Balken, api_version 1) → Seite 9200
- ApexFlowChart (SVG/mxGraph, api_version 1) → Seite 9201
- Material-Kanban (Board, api_version 2/NATIVE_PLUGIN_, 6 Attribute) → Seite 9202
Alle rendern eigenständig, 0 JS-Fehler, eigene Seite je Plugin.

Generische Fixes, die beim Kanban nötig wurden (gelten für JEDES Plugin):
1. B-31: SQL/Default-Extraktion nicht am ersten „))" abschneiden (kommt im SQL vor, z.B. VALUE(6,12))) → sonst ungültige SQL, Save blockiert, 404.
2. Region-Drag: Gallery-Item VOR dem Drag mit scrollIntoViewIfNeeded sichtbar machen — bei vielen installierten Plugins liegt es sonst unter dem Viewport, Drag verfehlt.
3. Render-Erkennung: Region-Body-Inhalt zählt (nicht nur SVG/Canvas) → Div-Plugins (Bargraphs, Kanban) gelten korrekt als gerendert.
4. Viewport fest 1500x950 in uiCreateTestPage (Drag-Koordinaten vorhersehbar).
5. Auth „Page Is Public" per Select-Options-Text→Value; Save über den echten Save-Button (Strg+S feuert headless nicht).

WICHTIG (Betrieb): NIE eine fremde/vorhandene Seite als Testseite missbrauchen — Seite 9999 wurde früh (vor dem Register) überschrieben. Jetzt: Pro-Plugin-Seite aus dem Register (component.apexPageId, ab 9001), uiDeletePage zum Aufräumen. APEX bietet KEINEN sauberen Per-Seiten-Restore (nur History-Log + destruktives App-Backup). Siehe [[b-30-befund]], [[page-designer-runner-bewiesene-mechanik]].

### Testseiten-Basis auf 20000 (Nutzer-Vorgabe) — nie reservierte App-Seiten überschreiben
_2026-07-06 06:14:26 · Item #1216_

Nutzer-Vorgabe nach dem 9999-Vorfall: die Pflege legt ihre APEX-Testseiten NUR ab Seitennummer 20000 an (fortlaufend, gemerkt als component.apexPageId), bewusst weit oberhalb der App-eigenen/reservierten Seiten. So wird nie eine bestehende Seite (9999, 1, 2, …) überschrieben. Umgesetzt in start.js (Register-Allokation, Default nextPageId=20000, Commit c8426d8). Der Nutzer stellt die App über einen frischen App-Import (App <app-id> Test) wieder her. Register bei Bedarf zurücksetzen: apexPageId in data/components.json klären + settings.apexTarget.nextPageId=20000.

### apex-deploy-MCP ist KI-frei + typ-bewusst (region automatisiert; item/DA/template erkannt)
_2026-07-06 07:51:20 · Item #1219_

Bestätigt: der apex-deploy-MCP (mcp-apex-deploy/) hat NULL KI-Abhängigkeit — Suche nach ai/claude/anthropic/openai/llm/resolveAiBackend/complete() ergab nichts. Install (apex_install_ui) + JSON-Einrichtung (apex_setup/setupFromManifest) sind rein deterministisch (Regex-Analyse + Playwright). Läuft ohne jedes AI-Backend.

Plugin-TYP ist jetzt Teil der Analyse/des Manifests: analyzePlugin liefert kind = region|item|dynamic-action|template-component|other (aus p_plugin_type bzw. create_template_component). buildSetupManifest trägt plugin.kind/pluginType + testPage.setupKind. setupFromManifest:
- kind=region → volle Testseite (automatisiert, live an Bargraphs/FlowChart/Kanban).
- kind=item/dynamic-action/template-component → Plugin wird installiert + File-URLs gesetzt, aber Testseiten-Aufbau ist NOCH NICHT automatisiert → ehrliche Meldung (kein False-Fail). Beispiele: ColorPalette=item, Vanta=dynamic-action.

Offen (Folge-Task): Testseiten-Aufbau für item (Page-Item vom Plugin-Typ in einer Host-Region), dynamic-action (an Event/Trigger-Element) und template-component. Kein Template-Component-Testobjekt im Workspace vorhanden.

### Item-Plugin-Testseite: Host-Region + Item-Drag aus Items-Gallery
_2026-07-06 08:15:12 · Item #1220_

Item-Plugins (kind=item, z.B. APEX Color Palette) brauchen im Page Designer einen anderen Aufbau als Region-Plugins: (1) eine Host-Region (Static Content) per Drag aus der Regions-Gallery, (2) dann das Page-Item VOM Plugin-Typ per Drag aus der ITEMS-Gallery IN die Host-Region. Die Items-Gallery-Einträge sind `LI.a-Gallery-pageItem.is-draggable` (NICHT `.a-Gallery-region`). Drop-Ziel = Layout-Box der Host-Region (`.a-Designer-gridRegion`/`[class*=Designer] [class*=region]`), Center leicht oben (x+min(w/2,120), y+min(h/2,40)); NICHT im Rendering-Tree suchen, sonst trifft der Drop den linken Baum statt der Layout-Fläche. Erfolg erkennt man am neuen Knoten P<page>_NEW bzw. am selektierten Name-Property (^P\d+_). Danach Item benennen + Custom-Attribute je Prompt-Label setzen, Seite öffentlich, Save. Live verifiziert: ColorPalette → Seite 20041, regionContent=true, 0 JS-Fehler.

### DA- & Template-Component-Testseiten im Page Designer (Gotchas)
_2026-07-06 09:04:21 · Item #1221_

Dynamic Action: Im Dynamic-Actions-Tab das Event (z.B. „Page Load") RECHTSKLICKEN -> „Create Dynamic Action" (kein Gallery-Drag). Es entsteht DA „New" mit True-Aktion „Show"; „Show" selektieren -> Property „Action" (Select) auf den Plugin-Typ (Option-Text endet auf „ [Plug-In]"). Danach heisst der Knoten „<Plugin> [Plug-In]" -> fuer weitere Properties RE-SELEKTIEREN. Pflicht: Selection Type (+ Selektor, z.B. jQuery Selector „body") setzen, sonst „Selection Type (Error)" -> Save blockiert -> Seite bleibt PRIVAT (Laufzeit -> Login). WICHTIG: APEX haengt bei Validierungsfehlern „(Error)"/„(Warning)" ans Property-LABEL („Selection Type\n(Error)") -> exakter Label-Match scheitert; pdSetProp schneidet den Suffix jetzt ab. Public-Setzen: vorher auf den Rendering-Tab schalten (aus dem DA-/Processing-Tab fehlt die Authentication-Property). Vanta rendert WebGL-Canvas auch headless (graphics>0).

Template Component: ist REGION-ARTIG (erscheint in der Regions-Gallery, Drag wie eine Region), aber datengebunden. Default-Source ist „Table" -> „Table Name (Error)". Umstellen: die SOURCE-„Type"-Auswahl (Optionen: Table/View, SQL Query, Function Body...) auf „SQL Query" setzen — NICHT per Label „Type" (mehrdeutig mit der Region-„Type"), sondern per Option (pdSetSelectByOption). Dann „SQL Query" + Beispiel-SQL. Spalten-Felder (z.B. Flip Card „Title"/„Subtitle") sind INPUTS mit Substitution -> &SPALTE.-Syntax (nicht der blanke Spaltenname, sonst Literal). Ronny Weiss hat NUR Region- und DA-Plugins (kein Item/TC/Process) — Item-Beispiel = eigenes Color-Palette-Plugin, TC-Beispiel = United Codes Flip Card (github.com/grlicaa/flipcard).

### APEX-Plug-in deinstallieren: Delete-Button nur ohne Referenzen + confirmDelete-Dialog
_2026-07-06 09:56:46 · Item #1225_

Ein Plug-in in APEX löschen: Shared Components → Plug-ins → Plugin öffnen → „Delete". WICHTIG: APEX BLENDET den Delete-Button AUS, solange das Plug-in noch REFERENZIERT ist (auf einer Seite genutzt). Darum beim Purge zuerst die Testseite löschen (uiDeletePage), dann das Plug-in (uiDeletePlugin) — sonst kein Delete-Button. Ist das Plugin anderweitig (auf Nutzer-Seiten) referenziert, bleibt es undeletebar → ehrlich melden statt False-Positive (Sicherheits-Feature: kein Nullen genutzter Plugins). Der Delete-Button hat onclick=confirmDelete(...) → öffnet einen jQuery-UI-Dialog; dessen OK/Delete-Button im .ui-dialog-buttonpane klicken (NICHT den verdeckten Edit-Seiten-Delete-Button erneut). Sicherheitshalber page.on('dialog', d=>d.accept()) für den Fall eines nativen confirm(). Verifikation ehrlich über die Rückkehr zur Plug-ins-Liste (Plugin-Link fehlt), nicht über die Edit-Seite. Platten-Löschung nur für VERWALTETE Pfade (unter workDir/DATA_DIR) — externe/lokale Repos des Nutzers bleiben (isUnder-Guard). Siehe [[nie-fremde-apex-seite-als-test-missbrauchen]].

### Versions-Identifikation: Banner-Schichten + zeitliche Korrelation (8/8 am BI-Dashboard)
_2026-07-06 20:01:56 · Item #1228_

Zwei greifende Schichten, generisch (kein Hardcoding je Lib): (1) DETERMINISTISCH — versionFromContent (vendored.js): version=/VERSION:-Zuweisung mit Quotes (ganze Datei), dann NUR im führenden Banner-Kommentar: @version / Wort „Version X" / name-adjazent „<Lib> vX.Y.Z" / Banner-„vX.Y.Z". Banner-Scoping verhindert Falschtreffer aus dem Minify-Body. (2) ZEITLICH — versionAtDate(time, refIso) (registry.js) + checkLibrariesOnline: für Libs mit unbekannter Version = die Version, die zum Bündel-Bauzeitpunkt aktuell war; Referenzdatum = jüngstes Release der Libs mit BEKANNTER Version (die gebündelten Files stammen aus derselben Zeit — Idee des Nutzers), optional deps.buildDate (z.B. apexplugin.json). Ergebnis transparent versionInferred + detectedBy='inferred-by-date'. Live BI-Dashboard: 8/8 (7 Banner + pell 1.0.6 inferred). OFFENER FOLGEPUNKT: die npm-Namens-Zuordnung (NPM_NAME in registry.js) ist klein — bei Bündel-Dateinamen wie nbillboard→billboard.js, masonry.pkgd→masonry, maptopojson→topojson, fullcalendarlocales→@fullcalendar/core schlägt der npm-Lookup fehl → Version steht, aber webStatus/outdated bleibt „unbekannt". Ausbauen für vollständige Aktualitäts-/Validierungs-Prüfung. Analyse-AI-Fallback (Szenario 4) noch offen.

### mock failed = claude-CLI beim Bau nicht auffindbar → statischer Fallback (Diagnose + Härtung)
_2026-07-07 16:19:20 · Item #1229_

Symptom „mock failed" (Badge) = mockMode!='ai', d.h. generateAiMock fiel auf den statischen Stub zurück. Den GRUND liefert IMMER component.mockNote (in data/components.json bzw. GUI): hier „AI error: Der Befehl \"claude\" … konnte nicht gefunden werden". Ursache: die claude-CLI war beim Mock-Bau nicht aufrufbar (gestripptes Server-Env: APPDATA/USERPROFILE fehlten, findBundledClaude fand die Desktop-Binary nicht, claude nicht im PATH). HÄRTUNG (Commit 4b2eb7b, kein Pinnen — Datei-Existenz zur Laufzeit): findBundledClaude prüft zusätzlich npm-Global-Bin (claude.cmd/.exe) und den nativen Installer (…\\Programs\\claude\\claude.exe); cliBackend.complete meldet die „nicht gefunden"-Klasse handlungsfähig statt roher Shell-Text. WICHTIG: static-Fallbacks werden NICHT per Fingerprint gecacht → ein Re-Run baut automatisch neu. END-TO-END SELBST VERIFIZIERT: resolveAiBackend→cli, testConnection ok, kurzer Prompt→Antwort in 5s, generateAiMock(BI-Dashboard)→mode='ai', 32942 Bytes, 42 Sichten (kein Fallback). Persistiert wird der Mock NUR vom laufenden Server (hält data/components.json) — daher Neubau über die GUI (Full maintenance/Rebuild), nicht per Skript. Siehe Memory [[ai-cli-command-claude-nicht-pinnen]].

### claude nicht auflösbar: Server läuft unter fremdem USERPROFILE → immer C:\Users scannen
_2026-07-07 17:17:42 · Item #1229_

Vertiefte Ursache (Live-Diagnose via POST /api/ai/test = „Test connection" IM Server-Prozess): CLI „claude" not callable, cmd = bares „claude". D.h. resolveCliCommand fiel auf den bloßen Namen zurück, weil findBundledClaude im SERVER-Prozess null lieferte — obwohl derselbe Code in einer normalen Shell die Binary sofort findet. Grund: findBundledClaude leitete `home` PRIMÄR aus env.USERPROFILE ab; startet der Dienst unter einem anderen Profil (Dienst-/Autostart-Kontext, z.B. ServiceProfiles\LocalService) ohne Claude, wurde nur dirname(home) gescannt → das Claude im Profil des echten Nutzers blieb unsichtbar. FIX (Commit fedff25): die Profil-Suche scannt jetzt IMMER <SystemDrive>\Users (alle Profile), nicht nur dirname(home) → findet …\<user>\AppData\Roaming\Claude\claude-code\<ver>\claude.exe unabhängig vom Server-USERPROFILE. Verifiziert: findBundledClaude({USERPROFILE:'…\\ServiceProfiles\\LocalService'}) → C:\Users\maras\…\claude.exe. WICHTIG: der laufende Node-Dienst hält Module im Speicher → Code-Fix greift erst nach NEUSTART. BUILD auf 2026-07-07.79 gebumpt, damit „Neustart geladen?" via /api/health bzw. GUI verifizierbar ist. Merkhilfe zum Debuggen: „mock failed"/„claude nicht aufrufbar" IMMER mit POST /api/ai/test read-only gegen den laufenden Server prüfen — bares cmd im Fehler = Auflösung greift nicht.

### Definitive Umgehung: CLI-Befehl = stabiler claude-code-Ordner (kein Pinnen)
_2026-07-07 17:25:32 · Item #1229_

Wenn die AUTOMATISCHE Auflösung im laufenden Server scheitert (bares „claude" in /api/ai/test), obwohl der GLEICHE Code standalone (Git-Bash UND cmd.exe) die .exe findet und der gespeicherte command exakt „claude" ist (6 Zeichen, keine Sonderzeichen) und BUILD den Fix belegt — dann liegt es am Environment/Token des Server-Prozesses (von außen nicht einsehbar; -IncludeUserName braucht Elevation). Robuste Umgehung (Commit c7ad9ed): resolveCliCommand akzeptiert als CLI-Befehl jetzt auch einen ORDNER; highestClaudeExe wählt daraus die höchste Versions-claude.exe. → In Settings den STABILEN Ordner eintragen: C:\\Users\\<user>\\AppData\\Roaming\\Claude\\claude-code (NICHT den versionierten .exe-Pfad — der stirbt beim Update, siehe [[ai-cli-command-claude-nicht-pinnen]]). Damit umgeht man findBundledClaude/env komplett. DIAGNOSE-WERT: klappt Test connection mit dem Ordner → es war die env-abhängige Auflösung; bleibt es rot → der Server-Prozess kann den Ordner nicht LESEN (Rechte/anderes Konto) = anderer Root-Cause.

### „Analyse bricht ab" nach Neustart = Playwright-Browser fehlt (npx playwright install)
_2026-07-09 13:48:50 · Item #1112_

Symptom: nach frischem PC-Neustart „bricht die Analyse ab" bzw. apex-live/Mock-Self-Tests/UI-Tests laufen nicht. Ursache (im Log data/logs/<slug>/*.log sichtbar): „[apex-live] übersprungen: browserType.launch: Executable doesn't exist at …\\ms-playwright\\chromium_headless_shell-<build>\\chrome-headless-shell.exe — Please run: npx playwright install". D.h. Playwright hat sich aktualisiert (Browser-Build z.B. 1223→1228) und die neue Browser-Binary war noch nicht (fertig) heruntergeladen. Die reine Code-Analyse (scanRepo/Lib-Check) läuft trotzdem durch; nur die browser-abhängigen Schritte brechen ab (in apex-live/Mock ist es je try/catch gekapselt → „übersprungen", kein harter Crash). FIX: im Projektordner `npx playwright install` (lädt den fehlenden Browser, ~150 MB) — danach Analyse erneut. Prüfen ob's schon behoben ist: LOCALAPPDATA\\ms-playwright\\ auf chromium_headless_shell-<aktueller build> checken bzw. loadChromium().launch() testen (startet in ~1s, wenn ok). Kein Code-Bug — reines Browser-Cache/Setup-Thema. NICHT mit „mock failed" (claude-CLI-Aufloesung) verwechseln — das ist ein anderer, separater Punkt (B-33).

### Sandbox-Falle: Claude-Code-Tools sehen virtualisierte claude-Pfade — reale FS-Checks nur via Server-Kind-Prozess
_2026-07-09 14:03:51 · Item #1229_

Beim Debuggen von „claude nicht aufrufbar" NIEMALS den eigenen Bash/PowerShell/node-Prozessen von Claude Code vertrauen: deren Sandbox blendet die Claude-eigene Binary virtualisiert ein (hier: C:\Users\<u>\AppData\Roaming\Claude\claude-code\2.1.197+2.1.202 sichtbar, spawn klappt, --version antwortet) — auf dem ECHTEN Dateisystem existierte der Pfad überhaupt nicht. Ein normaler Prozess (der Pflege-Server, gestartet via Explorer/Start.cmd) bekommt spawn ENOENT und dir sagt „Datei nicht gefunden". VERIFIKATIONS-TRICK (Orakel außerhalb der Sandbox): ein probe.cmd an einen leerzeichenfreien, real sichtbaren Pfad legen (z.B. D:\ais\probe.cmd), es temporär als aiBackend.command setzen und POST /api/ai/test aufrufen — der SERVER spawnt es als Kind, das Skript schreibt whoami + dir-Ausgaben in eine Datei = die reale Sicht des Server-Prozessbaums. Danach Settings zurücksetzen + Probe-Dateien löschen. Generell: „bei mir (Claude) geht es, beim Server nicht" ⇒ zuerst Sandbox-Virtualisierung als Ursache prüfen, nicht Env/Rechte des Servers.

### FINALE Lösung mock failed: Claude=Store-App → npm-CLI nach D:\ais\claude-cli, real E2E-verifiziert
_2026-07-09 14:43:02 · Item #1229_

Endgültige Auflösung: Claude Desktop ist als Windows-STORE-App installiert (C:\Program Files\WindowsApps\Claude_…, MSIX-gekapselt) → es gibt KEIN Roaming\Claude auf dem echten FS und die Store-Binary ist für normale Prozesse nicht aufrufbar. LÖSUNG: npm-CLI an einen real sichtbaren, leerzeichenfreien Ort installieren — npm install --prefix D:/ais/claude-cli @anthropic-ai/claude-code (ACHTUNG: npm install -g aus der Claude-Code-Sandbox landet NUR in der Sandbox!). Settings aiBackend.command = D:/ais/claude-cli/node_modules/.bin/claude.cmd (stabil, npm-updatebar, kein Versions-Pinnen; cliArgsFor erkennt basename claude → -p). REAL VERIFIZIERT über den echten Server: claude.cmd --version=2.1.205 exit=0 (Server-Kind-Probe), echo|claude -p → „OK" (Credentials auf dem realen System vorhanden), POST /api/ai/test → ok:true, Full maintenance 31 Min → mockMode=ai, mockNote=null. GUI nutzt dieselben Endpoints (Settings/Test connection/Full maintenance) → funktioniert identisch. Update der CLI künftig: npm update --prefix D:/ais/claude-cli @anthropic-ai/claude-code.

### Playwright-Browser real unter D:\ais\pw-browsers + PLAYWRIGHT_BROWSERS_PATH via start.js (E2E-validiert)
_2026-07-09 15:03:20 · Item #1269_

Browser real installiert: PLAYWRIGHT_BROWSERS_PATH=D:/ais/pw-browsers npx playwright install chromium (aus der Sandbox nach D:\ais → landet real; per Server-Kind-Probe verifiziert: chromium-1228 + chromium_headless_shell-1228 sichtbar). start.js setzt PLAYWRIGHT_BROWSERS_PATH früh, wenn ../pw-browsers neben dem Projekt existiert (opt-in per Ordner-Existenz, kein Hardcoding; vorhandene Env-Var hat Vorrang; wirkt, weil Playwright überall nur dynamisch importiert wird und Kind-Prozesse — auch der @playwright/test-Runner — die Variable erben). E2E-VALIDIERT über den echten Server (BUILD 2026-07-09.81, via Task Scheduler AUSSERHALB der Sandbox neu gestartet — nie den Server aus der Claude-Sandbox starten!): POST /api/components/:id/ui-tests (Material-Kanban) → ran:true, passed:10, failed:0, kein „Executable doesn't exist". Browser-Update künftig: PLAYWRIGHT_BROWSERS_PATH=D:/ais/pw-browsers npx playwright install chromium (nach Playwright-Versionssprung). Server-Neustart-Trick ohne Nutzer: schtasks one-shot (create/run/delete) mit Starter-.cmd an leerzeichenfreiem Pfad — läuft im normalen Nutzer-Env.

### Screenshots zur Analyse-KI: Datei-Pfade im Prompt (claude-CLI liest Bilder selbst)
_2026-07-09 16:54:40 · Item #1272_

Die claude-CLI (Print-Modus -p) kann Bilddateien SELBST lesen, wenn der Prompt die Pfade nennt („VIEW them — read these image files: <pfad>"). Deshalb werden Report-Screenshots einfach als Dateien unter <repo>/.maintenance/feedback/<stamp>/ gespeichert und der KI per Pfad mitgegeben — kein Base64 im Prompt, kein Upload-Mechanismus nötig. Grenze: ein Provider-Backend (HTTP+Key) kann keine lokalen Dateien lesen → bekommt nur den Text (ehrliche Einschränkung). Der generierte Feedback-Spec kodiert das SOLL-Verhalten (rot solange der Fehler existiert) und begründete im E2E-Test sogar selbst, warum die bisherigen Tests die Lücke hatten (zählten Kopfzeilen, prüften aber keinen Text). Naming-Konvention feedback-<stamp>.ui.spec.js ist der Schutzanker: run-component erhält diese Specs auch bei Baseline-Neuerzeugung.

### Git-Push-Auth: Token nur als Einmal-URL, nie im Klon persistieren
_2026-07-10 17:06:44 · Item #1276_

Zwei Wege, den Fix-Branch zu pushen: (1) Git Credential Manager des Rechners — kein Token nötig, `git push origin <branch>` reicht (empfohlen, wenn eingerichtet). (2) Personal Access Token — verschlüsselt im SecretStore('git-token'). WICHTIG: den Token NICHT per `git remote set-url`/config in den Klon schreiben (bleibt sonst im .git/config auf der Platte). Stattdessen zur Push-Zeit eine Einmal-URL bauen und direkt als Push-Ziel geben: `git push https://x-access-token:<token>@github.com/owner/repo.git <branch>` (GitHub akzeptiert x-access-token für classic UND fine-grained PAT; andere Hoster: oauth2:<token>). Remote-URL dafür aus `git.getRemotes(true)` (origin) lesen, damit in den Fork gepusht wird. Fehlertexte/Logs IMMER durch redactToken() (roh + encodeURIComponent + Regex `https://user:secret@`), da git die URL bei Fehlern echot. PAT-Rechte: classic `repo` bzw. fine-grained „Contents: read/write" für den Fork. Resultat: src/run/git-auth.js, gitFor.push in start.js. Verifiziert: kein Klartext in data/secrets.json; 8 Unit-Tests.

### Mock-Selbstkorrektur: nur messbare Probleme werden gefixt — und rote Mocks nie cachen
_2026-07-10 17:14:50 · Item #1274_

Zwei Regeln, damit die Mock-Refine-Schleife sichtbare Fehler wirklich behebt: (1) Was der Self-Check nicht MISST, korrigiert die KI nie. Harness-Checks (__features) reichen nicht — sichtbare „Error occured"-Kacheln, console.error, uncaught pageerror und HTTP>=400 müssen aktiv eingesammelt und als problems in die Refine-Schleife gegeben werden (Browser-Instrumentierung in runMockSelfTests; SCRIPT/STYLE beim Error-Kachel-Scan ausnehmen, sonst matcht der Plugin-Quelltext selbst). (2) Ein Mock mit failed>0 darf NIE als „bekannt" gecacht werden (known-Gate: nur failed==0) — sonst ist der rote Zustand terminal und die Refine-Schleife bekommt nie wieder eine Chance. Verschärft man die Self-Check-Anforderung, MUSS MOCK_SPEC_VERSION hoch, damit bestehende Fingerprints neu untersucht werden. GUI: failed>0 = rot (Handlungsbedarf), nicht gelb/ok. Verifikation immer am echten Mock (Error-Kacheln/Konsole zählen), nicht nur an der failed-Zahl. Siehe [[sandbox-sicht-nie-fuer-server-checks]].

### APEX Page Designer Modell-Transaction: Abschluss ist handle.execute(), NICHT model.transaction.end()
_2026-07-10 18:08:30 · Item #1277_

KRITISCH für jede Modell-Manipulation im Page Designer (window.pe): model.transaction hat NUR start und message — KEIN end/commit/rollback. `var h = model.transaction.start(component, 'msg')` liefert ein Undo/Redo-COMMAND-Handle mit den Methoden execute/cancel/undo/redo/_forEach/_restore/_undo/label. Der Abschluss/Commit einer Änderung ist `h.execute()` (nicht end!). Wird das Handle NICHT execute()t, bleibt die Transaction offen und JEDE folgende Property-Änderung (auch via Property-Editor-UI/pdSetProp) scheitert an „Finish pending Transaction first!" — konkret blieb dadurch „Page Is Public" ungesetzt und die Testseite landete auf Log-In (rendered=false). War ein latenter Bug seit 1cb2939 (dort `model.transaction.end(t)` — existierte nie, lief nie). Muster ab jetzt: t=start(...); prop.setValue(...); finally { t.execute(); }. Diagnose-Trick: das start()-Handle mit Object.getOwnPropertyNames(handle)+Prototyp auf Methoden inspizieren (so die execute-API gefunden). Ein zweites start() bei offener Transaction wirft sofort „Finish pending Transaction first!" — guter Indikator für ein hängendes Handle. Siehe [[sandbox-sicht-nie-fuer-server-checks]].

### Push-Auth ist hoster-unabhängig: Pseudo-User pro Host + optionaler Benutzername
_2026-07-10 18:16:16 · Item #1276_

Der Fix-Push ist NICHT auf GitHub festgenagelt. authenticatedPushUrl(remote, token, user?) baut die Einmal-URL host-aware: github→x-access-token, gitlab (auch self-hosted, Substring-Match)→oauth2, bitbucket→x-token-auth, dev.azure.com/visualstudio.com→pat, sonst (Gitea/Forgejo/Gogs/self-hosted)→Token selbst als Benutzer. defaultTokenUser(host,token) kapselt die Wahl. Ein expliziter Benutzername (settings.gitUser, NICHT geheim, via POST /api/git/token {user}) überschreibt den Default — nötig für Bitbucket-App-Passwörter (user:app-password) und manche Azure-Setups. Der PR/MR-Link (prUrlFor) unterstützt bereits github(compare)/gitlab(merge_requests)/bitbucket(pull-requests) und fällt sonst auf die Repo-URL zurück. Der Klon nutzt reines git clone → jede https/ssh-URL. Token bleibt verschlüsselt (git-token), nur zur Push-Zeit in die URL, Fehlertexte via redactToken bereinigt.

### Lib-Update muss die AUSGELIEFERTEN Artefakte treffen, nicht nur die Quellen (Bundle/embedded)
_2026-07-10 20:51:28 · Item #920_

Viele Plugins (RonnyWeiss-Muster) laden zur Laufzeit NICHT die Quell-Libs (js/lib/*.js), sondern GEBÜNDELTE/minifizierte Dateien (bida.*.pkgd.min.js), die per Build (gulp concat+uglify) entstehen und als base64-Blob (create_plugin_file) in die Plugin-.sql eingebettet sind. Genau diese .sql wird in APEX installiert. Ein Lib-Update, das nur js/lib/ tauscht, ändert NICHTS am deployten Plugin — die Quellen werden nie geladen. Prüf-Kette: (1) grep create_plugin_file/p_file_name in der .sql → welche Dateien sind eingebettet? (2) gulpfile/package.json → werden js/lib zu Bundles concatet? (3) git: wurde die .sql beim Update angefasst? Wenn nein → Update kam nicht an. RICHTIG: nach dem Quell-Update den Plugin-Build ausführen → Bundles regenerieren → Blobs in der .sql ersetzen → installieren; ODER direkt in den eingebetteten Bundles/Blobs ersetzen. Wichtig fürs Vertrauen: „aktualisiert" erst melden, wenn das Laufzeit-Asset (nicht die Quelle) die neue Version trägt — sonst zeigt der Fork neue Versionen, aber APEX + Mock-Baseline weichen ab. Bug: B-40.

### Re-Embed ins APEX-Exportformat: g_varchar2_table-HEX-Block vor create_plugin_file ersetzen
_2026-07-10 21:07:13 · Item #1281_

APEX-Plugin-Exports betten Dateien so ein: ein `begin wwv_flow_api.g_varchar2_table := empty; g_varchar2_table(1..N) := '<HEX>'; end; /` Block (Datei-Bytes als UPPERCASE-HEX, hier 100 Byte=200 Hexzeichen pro Chunk) DIREKT VOR einem `begin wwv_flow_api.create_plugin_file(... p_file_name=>'X' ... p_file_content=>varchar2_to_blob(g_varchar2_table)); end; /` Block. Zum Ersetzen des Inhalts von X: p_file_name-Marker finden → rückwärts den create_plugin_file-Aufruf → dessen begin → rückwärts das letzte `empty_varchar2_table;` (=Content-Block-Reset) → dessen begin; diesen Content-Block durch neu erzeugte HEX-Chunks ersetzen. HEX-Chunks enthalten nur [0-9A-F], daher keine False-Matches von 'begin'/'empty' in lastIndexOf. Sicherheit: zwischen Content-Block und create darf kein weiterer create_plugin_file liegen. Viele Plugins bündeln erst per gulp-concat (js/lib/*.js → bida.*.pkgd.min.js) — den concat deterministisch replizieren (Dateien mit \\n joinen; uglify weglassen ist ok, APEX serviert Bytes) statt den fremden Build auszuführen (BI-Dashboard hat nicht mal package.json). Verifikation der Auslieferung: am gerenderten Plugin die Bundle-URL (…/files/plugin/<id>/v<n>/<bundle>) fetchen und die Version prüfen — nicht window-Globals (Plugin kapselt sie). Siehe [[lib-update-muss-die-ausgelieferten-artefakte-treffen]].

### Manifest trägt das Asset-Mapping: Analyse klassifiziert eingebettete Dateien als bundle/copy/unknown
_2026-07-10 21:22:35 · Item #1282_

Architektur (auf Nutzer-Direktive): die Analyse-Phase stellt fest, WIE jede in die Plugin-.sql eingebettete Laufzeit-Datei entsteht, und schreibt es ins Manifest (manifest.assets). detectEmbeddedAssets(exportSql, repoDir): bundle = Datei ist gulp-concat-Output (Name matcht ein concat('X') im gulpfile → Quellen = dessen gulp.src-Liste); copy = es gibt eine Repo-Datei mit exakt gleichem relativem Pfad ODER eindeutigem Basename → Quelle = diese Datei; unknown = keine Repo-Quelle (z.B. Template Component, deren .sql selbst-enthalten ist, oder Datei existiert nur eingebettet) → wird beim Update NICHT angefasst (ehrlich). reembedFromAssets erzeugt die Bytes neu (bundle=concat der Quellen mit \\n; copy=Datei lesen) und re-embeddet NUR bei realem Byte-Unterschied (content-diff via decodeEmbeddedFile) → kein PR-Rausch. Engine liegt im standalone-MCP (mcp-apex-deploy/lib/plugin-assets.js), damit buildSetupManifest sie nutzen kann; src/service/plugin-bundle.js re-exportiert nur. lib-update.reembedBundles ruft detect+reembed nach jedem angewandten Quell-Update → gilt kind-agnostisch für region/item/dynamic-action/template-component. Grenze/nächster Schritt: unknown-Assets (nur eingebettet, keine Repo-Quelle) könnten via decode→patchen→re-embed direkt aktualisiert werden. Siehe [[re-embed-ins-apex-exportformat-g-varchar2-table-hex-block-vor-create-plugin-file-ersetzen]].

### Vorher/Nachher-Test: Mock ist NICHT das Vorher — die eingefrorene Baseline ist es
_2026-07-11 07:29:52 · Item #1283_

Design-Klärung (für die Umsetzung von T-153): Der Mock ist der Self-Test-HARNESS des jeweiligen Standes und zieht mit dem Plugin mit — bei „nur untersuchen"/keine Änderung wird er per Fingerprint (Plugin-Code+Vertrag+Libs/CSS+Spec, T-111) WIEDERVERWENDET, bei Änderung neu gebaut. Deshalb kann der Mock nicht gleichzeitig „Vorher" und „Nachher" sein. Das „Vorher" ist die separat EINGEFRORENE Charakterisierungs-Baseline (src/service/baseline.js: baseline.scenarios + Screenshot baseline.shot). Vorher/Nachher = worksAsBefore(baseline.scenarios [vorher] , aktuelle Mock-Self-Test-Szenarien [nachher]) + optional KI-Screenshot-Vergleich (redev.js:246). Heute läuft dieses TIEFE Gate nur im Migrations-/Re-Dev-Pfad und via T-98-Button; der reguläre Safe-Update-Lauf (maintain.js) vergleicht nur Status (r1.status↔r2.status). T-153 zieht das tiefe Gate + Auto-Baseline-Ensure (vor der ersten Änderung) + Rollback (über die von applyVendoredUpdates gelieferten backups, inkl. B-40 .sql-Re-Embed-Backup) in den regulären Lauf. WICHTIG: Baseline MUSS vor der ersten Änderung stehen, sonst wäre das „Vorher" schon kontaminiert.

### Review-Befund: API-Key wird an frei konfigurierbaren Endpoint gesendet (SSRF/Key-Leak)
_2026-07-11 11:00:40 · Item #1298 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: src/ai/backend.js

providerBackend.complete/testConnection schicken Authorization: Bearer <apiKey> per fetch an config.endpoint ohne Schema-/Host-Validierung. Wird endpoint (z.B. über einen importierten/manipulierten Settings-Datensatz) auf eine fremde URL gesetzt, leakt der Provider-Key an den Angreifer-Server; zugleich beliebige ausgehende Requests (SSRF) möglich. Vorschlag: endpoint auf https + Allowlist bekannter Provider-Hosts beschränken, Key nur an verifizierte Hosts senden.

### Review-Befund: Maskierung gibt kurze Secrets fast vollständig preis
_2026-07-11 11:00:41 · Item #1299 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: src/config/secrets.js

mask() nutzt slice(0,3)+'*'.repeat(max(4,len-7))+slice(-4). Bei Secrets bis ~7 Zeichen überlappen erste 3 und letzte 4 Zeichen, sodass praktisch der ganze Wert sichtbar wird (z.B. 'abcdefg' → 'abc****defg'). Das verletzt die Zusage 'maskiert angezeigt'. Vorschlag: feste Anzeige '****' für len<=8 und für längere nur Suffix der letzten 4 zeigen, ohne Präfix-Leak.

### Review-Befund: Re-Injektion schreibt ohne Containment-Prüfung (Pfad-Ausbruch)
_2026-07-11 11:00:43 · Item #1300 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: src/extract/reinject.js

reinjectAsset schreibt mit writeFile(origin.path / origin.sqlFile) via path.join(rootDir, p) ohne zu prüfen, dass der Zielpfad unterhalb rootDir bleibt. origin.path/sqlFile kommen aus der sourceMap, die aus untrusted Repo-Inhalt aufgebaut wird → ein '../'-Pfad überschreibt beliebige Dateien außerhalb des Repos (zudem mit KI-gepatchtem Inhalt). Vorschlag: aufgelösten Pfad gegen rootDir prüfen (path.resolve startsWith) und Symlinks ablehnen.

### Review-Befund: Pfad-Traversal über unvalidierten Artefaktnamen im Testpfad
_2026-07-11 11:00:43 · Item #1301 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: src/ai/generate.js

path wird als `${opts.testDir}/${bundle.artifact}.spec.js` gebildet. bundle.artifact stammt aus dem Inventar eines fremden Repos; enthält der Name '../' (z.B. '../../etc/...'), wird die Datei außerhalb von testDir geschrieben. Vorschlag: artifact über path.basename normalisieren bzw. auf [A-Za-z0-9_.-] beschränken und prüfen, dass der aufgelöste Pfad innerhalb testDir liegt.

### Review-Befund: Beispiel-Plugin referenziert verwundbares jQuery 3.4.1
_2026-07-11 11:00:44 · Item #1302 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: low).
Datei: examples/sample-repo/colorpicker/colorpicker.sql

p_file_urls lädt jquery-3.4.1.min.js (bekannte XSS-CVEs 2020-11022/11023). Als Test-Fixture vermutlich beabsichtigt; falls solche Beispiel-Repos je real eingebunden/ausgeliefert werden, ist es eine veraltete, angreifbare Abhängigkeit. Vorschlag: in Fixtures klar als 'bewusst veraltet' markieren bzw. nicht aus Beispieldaten in Produktivpfade übernehmen.

### Review-Befund: Beliebiger Prozessaufruf aus Konfiguration (CLI-Backend)
_2026-07-11 11:00:49 · Item #1303 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: low).
Datei: src/ai/backend.js

cliBackend startet spawn(config.command, config.args). Default ist 'claude' (ok), aber command/args stammen aus den Einstellungen — wer Settings schreiben kann, führt beliebige Programme aus. Ohne sh:true keine Shell-Injection, aber dennoch Code-Execution. Vorschlag: command gegen eine Allowlist erlaubter Binaries prüfen und args nicht aus ungeprüften Quellen übernehmen.

### Review-Befund: git-Arg aus gespeichertem Commit interpoliert
_2026-07-11 11:00:50 · Item #1304 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: low).
Datei: src/diff/diff.js

changedFilesSince baut `${lastCommit}..HEAD` und übergibt es an git.diff. lastCommit kommt aus repo.lastProcessedCommit (persistiert). Ist dieser Wert manipulierbar (z.B. mit führendem '-'), entstehen unerwartete git-Optionen/Revisions. Vorschlag: lastCommit gegen /^[0-9a-f]{7,40}$/ validieren, bevor er in eine Range eingesetzt wird.

### Review-Befund: KI-generierter Testcode wird ungesandboxt ausgeführt
_2026-07-11 11:01:07 · Item #1305 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: high).
Datei: src/ai/generate.js

generateInitialSuite/generateDeltaTests schreiben die rohe KI-Antwort als .spec.js und lassen sie von vitest ausführen. validate() ist NUR ein acorn-Syntaxcheck (kein Sicherheits-Check). Eingabe ist fremder Drittanbieter-Repo-Code (base64-BLOBs, Inline-PL/SQL), der den Prompt-Kontext bildet — via Prompt-Injection oder ein kompromittiertes/feindliches Backend kann beliebiger JS-Code (fs/child_process) auf dem Host laufen. Vorschlag: generierte Tests in isoliertem Prozess/Container ohne Netz/FS-Rechte ausführen, statische Allowlist (keine require/import von node:*-Modulen) erzwingen.

### Review-Befund: Ungeprüfter exportFile-Pfad wird in SQLcl-Skript eingebettet und ausgeführt
_2026-07-11 11:09:37 · Item #1306 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: mcp-apex-deploy/lib/apex.js

buildInstallScript() setzt den Pfad ungefiltert als '@"${o.exportFile}"' ins Skript; server.js apex_install prüft nur fs.existsSync und führt danach die Datei per SQLcl aus. workspace wird zwar per ''-Escaping abgesichert, der Dateipfad aber nicht: enthält er ein " (oder Zeilenumbruch), lässt sich aus dem @-Include ausbrechen und zusätzlicher SQL-/SQLcl-Befehl einschleusen. Zudem gibt es keine Verzeichnis-Beschränkung → ein beliebiges .sql (DDL/DML) wird gegen die Ziel-DB gefahren. Vorschlag: exportFile gegen ein erlaubtes Basisverzeichnis validieren (resolve + Präfixprüfung) und "/Steuerzeichen im Pfad ablehnen.

### Review-Befund: Pfad-Traversal beim Re-Embed über p_file_name aus fremdem Plugin-SQL
_2026-07-11 11:09:38 · Item #1307 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: mcp-apex-deploy/lib/plugin-assets.js

findRepoSource() nimmt den eingebetteten Dateinamen (aus p_file_name des – potenziell fremden, geklonten – Plugin-Exports), macht nur rel=embeddedName.replace(/^\.?\//,'') und ruft dann exists(path.join(repoDir, rel)) bzw. beim Walk-Vergleich basename. Ein manipuliertes Export-SQL mit p_file_name=>'..\..\..\secrets.env' lässt path.join den repoDir verlassen → Lesen von Dateien außerhalb des Repos, deren Inhalt anschließend in die .sql re-eingebettet werden kann. Vorschlag: aufgelösten Pfad mit path.resolve normalisieren und erzwingen, dass er unter repoDir liegt (startsWith(repoDir+sep)), '..'-Segmente ablehnen.

### Review-Befund: Hartkodierter realer Oracle-Cloud-Endpoint + Instanz-IDs in .mcp.json
_2026-07-11 11:09:39 · Item #1308 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: medium).
Datei: .mcp.json

Der apex-deploy-Server enthält fest eingecheckte Infrastruktur-/Instanzdaten einer echten Umgebung: APEX_BASE_URL 'https://<instance>.adb.<region>.oraclecloudapps.com/ords', APEX_WORKSPACE '<workspace>', APEX_LOGIN_USER '<workspace>', APEX_WORKSPACE_ID '<workspace-id>', APEX_OWNER 'WKSP_<workspace>', APEX_APP_ID '<app-id>'. Das Passwort ist zwar korrekt als ${APEX_LOGIN_PASS} ausgelagert, aber Host, Workspace, Schema-Owner und Login-User sind Klartext im Repo → Informationspreisgabe/Angriffsfläche. Vorschlag: auch diese Werte via Umgebungsvariablen/lokale, nicht versionierte Konfig setzen (analog zu mcp-apex-deploy/README.md, das ${APEX_CONN} nutzt).

### Review-Befund: MCP-Schreiboperationen ohne Authentifizierung (lokales Vertrauensmodell)
_2026-07-11 11:09:41 · Item #1309 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: low).
Datei: .mcp.json

Der devhub-MCP-Server nutzt DEVHUB_USER='local' als fest gesetzten Default und kennt darüber hinaus keine Auth; alle Schreib-Tools (create_item, set_test_result, done, get_connection …) sind für jeden, der den stdio-Server erreicht, ausführbar. get_connection liefert laut SKILL.md Secrets zurück. Solange strikt lokal/nur der Nutzer Zugriff hat, akzeptabel – aber unsicherer Default, falls der Server je über einen erreichbaren Kanal (Netz/Container) exponiert wird. Vorschlag: Ausschließlich lokale Bindung/Nutzung dokumentieren und sicherstellen, keine Netz-Exposition.

### Review-Befund: Bekannt verwundbares jQuery 3.4.1 per CDN ohne SRI geladen (Beispiel-Plugin)
_2026-07-11 11:09:42 · Item #1310 · Tags: tester,review,agent-initiated,security_

Gemeldet vom Review-Agenten „Security Tester" (Severity: low).
Datei: examples/sample-repo/colorpicker/colorpicker.sql

p_file_urls verweist auf 'https://cdn.example.com/jquery-3.4.1.min.js' – jQuery 3.4.1 ist von XSS-Lücken betroffen (CVE-2020-11022/11023) und wird ohne Subresource-Integrity von einem externen CDN geladen. Auch wenn es Beispieldaten sind: als Vorlage riskant (das Tool aktualisiert genau solche Libs – hier wäre der Soll-Zustand eine aktuelle Version, idealerweise gebündelt/mit SRI).

### Review-Befund: Ungeprüfter exportFile-Pfad wird in SQLcl-Skript eingebettet
_2026-07-11 11:12:27 · Item #1312 · Tags: tester,review,agent-initiated,code_

Gemeldet vom Review-Agenten „Code Reviewer" (Severity: medium).
Datei: mcp-apex-deploy/lib/apex.js

Die Funktion buildInstallScript setzt den Pfad ungefiltert als '@"${o.exportFile}"' ins Skript. Ohne validierung kann ein Dateipfad mit Anführungszeichen oder Zeilenumbrüchen zu SQL-Injection führen, wodurch zusätzlicher SQL-/SQLcl-Befehl eingeschleust werden könnte. Zudem gibt es keine Verzeichnis-Beschränkung → beliebige .sql-Dateien können gegen die Ziel-DB ausgeführt werden.

### Review-Befund: Pfad-Traversal beim Re-Embed über p_file_name
_2026-07-11 11:12:28 · Item #1313 · Tags: tester,review,agent-initiated,code_

Gemeldet vom Review-Agenten „Code Reviewer" (Severity: medium).
Datei: mcp-apex-deploy/lib/plugin-assets.js

Die Funktion findRepoSource nimmt den eingebetteten Dateinamen (aus p_file_name des Plugin-Exports), macht nur rel=embeddedName.replace(/^\.?\//,'') und ruft dann exists(path.join(repoDir, rel)) bzw. beim Walk-Vergleich basename. Ein manipuliertes Export-SQL mit p_file_name=>'../../../secrets.env' lässt path.join den repoDir verlassen → Lesen von Dateien außerhalb des Repos, deren Inhalt anschließend in die .sql re-eingebettet werden kann.

### Review-Befund: MCP-Schreiboperationen ohne Authentifizierung
_2026-07-11 11:12:30 · Item #1315 · Tags: tester,review,agent-initiated,spec_

Gemeldet vom Review-Agenten „Spec Tester" (Severity: medium).
Datei: .mcp.json

Der devhub-MCP-Server nutzt DEVHUB_USER='local' als fest gesetzten Default und kennt darüber hinaus keine Auth. Alle Schreib-Tools (create_item, set_test_result, done, get_connection usw.) sind für jeden, der den stdio-Server erreicht, ausführbar. get_connection liefert laut SKILL.md Secrets zurück. Solange strikt lokal/nur der Nutzer Zugriff hat, akzeptabel – aber unsicherer Default bei Veröffentlichung über Netz/Container.

### Review-Befund: Hartkodierter realer Oracle-Cloud-Endpoint + Instanz-IDs
_2026-07-11 11:12:34 · Item #1316 · Tags: tester,review,agent-initiated,code_

Gemeldet vom Review-Agenten „Code Reviewer" (Severity: low).
Datei: .mcp.json

Die Datei enthält fest eingecheckte Infrastruktur-/Instanzdaten einer echten Umgebung: APEX_BASE_URL, APEX_WORKSPACE, APEX_LOGIN_USER, APEX_WORKSPACE_ID, APEX_OWNER, APEX_APP_ID. Das Passwort ist zwar korrekt als ${APEX_LOGIN_PASS} ausgelagert, aber Host, Workspace, Schema-Owner und Login-User sind Klartext im Repo → Informationspreisgabe/Angriffsfläche.

### Modell-Mutation im Page Designer nur transaction-sicher (finally schließt IMMER)
_2026-07-11 12:17:20 · Item #1278 · Tags: apex,page-designer,transaction,T-150_

Der frühere Vorfall (blinder Modell-Add hängte die Transaction, „Finish pending Transaction first!" → Seite kaputt) hatte EINE Ursache: die Modell-Transaction wurde nicht geschlossen. Muster (aus pdSetRegionSqlModel bewiesen, jetzt auch in pdCreatePageItems): t = m.transaction.start(...); try { mutieren } finally { für fn of ['execute','done','commit','apply','end','close'] → erste vorhandene aufrufen }. Damit ist JEDE Modell-Mutation bounded — auch wenn die Create-API fehlt/wirft, bleibt die Seite nutzbar. createComponents(pageId,[{typeId:COMP_TYPE.PAGE_ITEM, properties:[ITEM_NAME, ITEM_TYPE='NATIVE_HIDDEN']}]) ist die vermutete Create-API; bis zur Live-Verifikation opt-in (o.createPageItems) und ehrliche Fehlermeldung statt stillem Erfolg. Live-Test NUR auf dedizierter Seite ≥9001 (nie fremde Seiten).
