@echo off
title HomePod A/V Sync - Uninstall
echo Removing HomePod A/V Sync auto-start and stopping the server...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
