@echo off
title HomePod Control Server
echo HomePod control server - lets the browser extension connect/disconnect the
echo HomePod stream from its panel. Keep this window open (or autostart at login).
echo Ctrl+C to quit.
echo.
python "%~dp0homepod_server.py"
pause
