@echo off
title The TCG Plug - koppeling
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is nog niet geinstalleerd.
  echo  Download de LTS-versie van https://nodejs.org en start dit bestand daarna opnieuw.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
:start
if not exist node_modules (
  echo  Onderdelen installeren, even geduld...
  call npm install --no-audit --no-fund
)
node server.js
if %errorlevel%==42 (
  set TCG_RESTART=1
  echo.
  echo  Programma bijgewerkt, opnieuw starten...
  echo.
  goto start
)
pause
