@echo off
title HomePod Latency Sweep
echo Latency sweep: 200, 150, 100, 80, 60 ms - 20 seconds each.
echo Play music now and note the value where you FIRST hear stutters/dropouts.
echo Then run Start-HomePodStream.bat with --latency-ms set just above that.
echo.
python "%~dp0homepod_stream.py" --sweep %*
echo.
pause
