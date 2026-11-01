@echo off
title Vitrine
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Vitrine has not been extracted yet.
  echo Right-click the zip file, choose Extract All, then open Start Vitrine in the new folder.
  echo.
  pause
  exit /b 1
)
"runtime\node.exe" --disable-warning=ExperimentalWarning "app\launcher.mjs"
if errorlevel 1 pause
