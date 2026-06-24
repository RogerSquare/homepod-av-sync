@echo off
title HomePod A/V Sync - Install
echo Installing HomePod A/V Sync (server + auto-start)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
