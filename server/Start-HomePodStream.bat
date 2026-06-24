@echo off
title HomePod Streamer (Bedroom)
echo Starting HomePod live audio streamer...
echo Control what plays from Wave Link's Stream Mix faders.
echo Close this window or press Ctrl+C to stop.
echo.
python "%~dp0homepod_stream.py" %*
echo.
echo Streamer stopped.
pause
