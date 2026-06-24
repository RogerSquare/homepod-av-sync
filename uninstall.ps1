# Removes the HomePod auto-start task and stops the running server/streamer.
# Run from PowerShell:  .\uninstall.ps1
$taskName = "HomePodSync"

# Stop the server and any active streamer
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in 'pythonw.exe', 'python.exe', 'ffmpeg.exe' -and
                 $_.CommandLine -match 'homepod_server|homepod_stream|atvremote_lowlatency|Stream Mix' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Remove the scheduled task
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Host "Removed task '$taskName'." }
catch { Write-Host "Task '$taskName' not found (already removed)." }

Write-Host "HomePod control server stopped and auto-start removed."
