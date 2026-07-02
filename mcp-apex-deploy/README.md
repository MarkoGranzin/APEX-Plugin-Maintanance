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
        "APEX_SQLCL": "C:/oracle/sqlcl/bin/sql.exe",
        "APEX_CONN": "schema/passwort@host:1521/service",
        "APEX_WORKSPACE": "MEIN_WORKSPACE",
        "APEX_APP_ID": "100",
        "APEX_BASE_URL": "https://host/ords",
        "APEX_LOGIN_USER": "tester",
        "APEX_LOGIN_PASS": "…"
      }
    }
  }
}
```
Der Connect-String wird in **keiner Ausgabe** je im Klartext angezeigt (Passwort maskiert).

## Tools
| Tool | Zweck |
|---|---|
| `apex_install` | Export-SQL headless einspielen: `set_workspace` → `set_application_id` → `generate_offset` → Datei ausführen → commit. Generisch für jedes Plugin/jede Template-Component. |
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
