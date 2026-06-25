@echo off
REM ============================================================
REM  Plugin Maintenance - Doppelklick-Starter (Windows)
REM  Startet die Web-GUI, scannt ein Repo oder fuehrt Tests aus.
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Plugin Maintenance

REM --- Node pruefen ---
where node >nul 2>nul || (
  echo.
  echo   Node.js wurde nicht gefunden.
  echo   Bitte Node ^>= 20 installieren: https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM --- Abhaengigkeiten bei Bedarf installieren ---
if not exist "node_modules" (
  echo.
  echo   Installiere Abhaengigkeiten ^(npm install^) ...
  call npm install || (echo   npm install fehlgeschlagen. & pause & exit /b 1)
)

REM Beim Start direkt die Web-GUI oeffnen; das Menue erscheint danach (Scan/Tests).
goto serve

:menu
cls
echo.
echo   ============================================
echo      Plugin Maintenance
echo   ============================================
echo.
echo     [1]  Web-GUI starten  ^(http://localhost:4317^)
echo     [2]  Repo scannen     ^(read-only Analyse^)
echo     [3]  Plugin-Tests ausfuehren ^(alle verwalteten Plugins^)
echo     [4]  Beenden
echo.
set "choice="
set /p "choice=  Auswahl [1/2/3/4]: "

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto scan
if "%choice%"=="3" goto tests
if "%choice%"=="4" goto end
goto menu

:serve
echo.
REM --- Alten Dienst auf Port 4317 beenden (Neustart) - locale-unabhaengig via PowerShell ---
echo   Beende ggf. laufenden Dienst auf Port 4317...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800; Write-Host '  Alter Dienst beendet.' }"
echo   Starte Dienst auf http://localhost:4317  (Beenden mit Strg+C)
echo   Der Browser oeffnet sich automatisch, sobald der Dienst bereit ist...
REM Browser zeitversetzt oeffnen (erst wenn der Server laeuft), Dienst im Vordergrund
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4317'"
node start.js serve
goto afterrun

:scan
echo.
set "repo="
set /p "repo=  Repo-Pfad (Enter = examples\sample-repo): "
if "!repo!"=="" set "repo=examples\sample-repo"
echo.
node start.js scan "!repo!"
goto afterrun

:tests
echo.
echo   Fuehre die Tests aller verwalteten Plugins/Template-Komponenten aus...
node start.js test
goto afterrun

:afterrun
echo.
echo   --------------------------------------------
set "again="
set /p "again=  Zurueck zum Menue? [j/N]: "
if /i "!again!"=="j" goto menu

:end
endlocal
