@echo off
REM ============================================================
REM  Plugin Maintenance - double-click launcher (Windows)
REM  Starts the web GUI, scans a repo, or runs the tests.
REM ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Plugin Maintenance

REM --- Check Node ---
where node >nul 2>nul || (
  echo.
  echo   Node.js was not found.
  echo   Please install Node ^>= 20: https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM --- Install dependencies if needed ---
if not exist "node_modules" (
  echo.
  echo   Installing dependencies ^(npm install^) ...
  call npm install || (echo   npm install failed. & pause & exit /b 1)
)

REM Open the web GUI right away on start; the menu (scan/tests) appears afterwards.
goto serve

:menu
cls
echo.
echo   ============================================
echo      Plugin Maintenance
echo   ============================================
echo.
echo     [1]  Start web GUI    ^(http://localhost:4317^)
echo     [2]  Scan repo        ^(read-only analysis^)
echo     [3]  Run plugin tests ^(all managed plugins^)
echo     [4]  Quit
echo.
set "choice="
set /p "choice=  Choice [1/2/3/4]: "

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto scan
if "%choice%"=="3" goto tests
if "%choice%"=="4" goto end
goto menu

:serve
echo.
REM --- Stop an old service on port 4317 (restart) - locale-independent via PowerShell ---
echo   Stopping any running service on port 4317...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800; Write-Host '  Old service stopped.' }"
echo   Starting service on http://localhost:4317  (stop with Ctrl+C)
echo   The browser opens automatically once the service is ready...
REM Open the browser with a delay (only once the server is up), service stays in the foreground
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4317'"
node start.js serve
goto afterrun

:scan
echo.
set "repo="
set /p "repo=  Repo path (Enter = examples\sample-repo): "
if "!repo!"=="" set "repo=examples\sample-repo"
echo.
node start.js scan "!repo!"
goto afterrun

:tests
echo.
echo   Running the tests for all managed plugins/template components...
node start.js test
goto afterrun

:afterrun
echo.
echo   --------------------------------------------
set "again="
set /p "again=  Back to the menu? [y/N]: "
if /i "!again!"=="y" goto menu

:end
endlocal
