# apex-deploy — MCP-Server für APEX-Plugin-Einspielen + Live-Test

Spielt **beliebige** Oracle-APEX-Exporte (Plugins, Template-Components, Pages, Apps) **headless**
in eine echte APEX-App ein, erzeugt eine **generische Testseite** (eine Region vom Plugin-Typ,
Attribute aus der Schnittstelle gefüttert) und macht einen **headless Smoke-Test**.

Alles deterministisch (SQLcl + `apex_application_install`, kein UI-Geklicke, keine KI) →
**minimaler Token-Verbrauch**. Ein Ordner, **keine npm-Abhängigkeiten** → einfach in jedes
Projekt kopieren.

## Voraussetzungen
- Node ≥ 20
- [SQLcl](https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/) im PATH (oder `APEX_SQLCL` setzen)
- DB-Zugang zum **Parsing-Schema** der Ziel-App
- Optional: `playwright` im Aufruf-Verzeichnis installiert (nur für `apex_test_page`)

## Einbinden (.mcp.json — in JEDEM Projekt verwendbar)
```json
{
  "mcpServers": {
    "apex-deploy": {
      "command": "node",
      "args": ["<pfad>/mcp-apex-deploy/server.js"],
      "env": {
        "APEX_SQLCL": "C:/oracle/sqlcl/bin/sql.exe",   // nur für den DB-Weg (apex_install)
        "APEX_CONN": "${APEX_CONN}",                     // nur DB-Weg; Secret aus Umgebungsvariable
        "APEX_WORKSPACE": "MEIN_WORKSPACE",
        "APEX_APP_ID": "100",
        "APEX_BASE_URL": "https://host/ords",
        "APEX_LOGIN_USER": "workspace_user",             // UI-Weg: APEX-Login
        "APEX_LOGIN_PASS": "${APEX_LOGIN_PASS}"          // UI-Weg: Passwort aus Umgebungsvariable (nie im Repo)
      }
    }
  }
}
```
Der Connect-String wird in **keiner Ausgabe** je im Klartext angezeigt (Passwort maskiert).

## Zwei Wege — DB-headless ODER APEX-UI
- **DB-Weg** (`apex_install`): SQLcl + `apex_application_install`. Token-frei, braucht aber SQLcl + DB-Connect-String.
- **UI-Weg** (`apex_install_ui`): meldet sich per Browser (Playwright) an APEX an und nutzt den **Import-Wizard** — **kein SQLcl, kein DB-Connect**, nur der **APEX-Login** (`APEX_WORKSPACE` + `APEX_LOGIN_USER` + `APEX_LOGIN_PASS`). Ideal für Autonomous DB.

## Tools
| Tool | Zweck |
|---|---|
| `apex_install` | (DB-Weg) Export-SQL headless einspielen: `set_workspace` → `set_application_id` → `generate_offset` → Datei ausführen → commit. |
| `apex_ui_login_check` | (UI-Weg) Prüft den APEX-Login mit den env-Zugangsdaten — landet er im App Builder? Nur Login-Test, Passwort nie in der Ausgabe. |
| `apex_install_ui` | (UI-Weg) Plugin/Template-Component über die APEX-Import-UI einspielen (Login → Plug-ins → Import → Datei → Wizard). Best effort über APEX-Versionen; liefert Schritt-Log + Screenshot. |
| `apex_create_test_page` | Testseite mit einer Region vom Plugin-Typ anlegen; `attributes[0..24]` = attribute_01..25 (z.B. ConfigJSON-Default aus dem Akzeptanz-Vertrag). **Empfohlen:** `templateFile` = ein echter Seiten-Export der Ziel-Instanz als Vorlage (robust über APEX-Versionen). Ohne Vorlage: Gerüst-Modus (best effort, `apiPackage` konfigurierbar). `dryRun:true` zeigt nur das SQL. |
| `apex_test_page` | Seite headless öffnen (optionaler APEX-Login via env), JS-Fehler sammeln, sichtbares Rendern prüfen. Ohne Playwright: ehrliche Fehlermeldung. |
| `apex_info` | Konfiguration anzeigen (maskiert) + SQLcl-Erreichbarkeit prüfen. |

## Typischer Ablauf (z.B. nach der Plugin-Pflege)
1. `apex_install` mit `exportFile: workspace/<plugin>/src/region_type_plugin_*.sql`
2. `apex_create_test_page` mit `pluginName` (steht im Install-Ergebnis) + `attributes:[<ConfigJSON>]`
3. `apex_test_page` mit `appId`/`pageId` → `{ok, jsErrors, rendered}`

## Sicherheit
- Secrets nur über env; Ausgaben maskieren den Connect-String.
- `apex_install`/`apex_create_test_page` schreiben in die Ziel-App → nur gegen Test-Apps/-Instanzen richten.
