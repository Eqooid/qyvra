@echo off
setlocal
title QYVRA
echo Starting QYVRA, local AI, and search. Keep this window open until startup finishes.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" -All -OpenBrowser %*
set "qyvraExit=%ERRORLEVEL%"
if not "%qyvraExit%"=="0" (
  echo.
  echo QYVRA could not finish startup. Read the message above; your data was retained.
  pause
)
exit /b %qyvraExit%
