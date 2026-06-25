# One-shot setup for the HomePod control server:
#   - checks Python + ffmpeg
#   - installs Python dependencies
#   - registers a hidden auto-start task (runs in your user session at login,
#     so it can reach audio devices - a real Windows Service can't)
#   - starts the server now
# Usually launched by Install.bat. No admin needed.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$server = Join-Path $root "server\homepod_server.py"
$req = Join-Path $root "server\requirements.txt"
$taskName = "HomePodSync"

Write-Host "=== HomePod A/V Sync setup ===" -ForegroundColor Cyan

# 1. Python - pick a real interpreter, NOT the Microsoft Store stub
#    (WindowsApps\python.exe runs in an AppContainer and can't find ffmpeg/atvremote).
$cands = @()
Get-Command python.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $cands += $_.Source }
$cands += "$env:USERPROFILE\Miniconda3\python.exe", "$env:USERPROFILE\Anaconda3\python.exe"
$py = $null
foreach ($c in $cands) {
  if (-not (Test-Path $c)) { continue }
  if ($c -match 'WindowsApps') { continue }          # skip the Store alias
  if (-not $py) { $py = $c }                          # first real python as fallback
  & $c -c "import pyatv" 2>$null
  if ($LASTEXITCODE -eq 0) { $py = $c; break }        # prefer one that already has pyatv
}
if (-not $py) { Write-Host "ERROR: No suitable Python found. Install Python 3.9+ (not the Store version)." -ForegroundColor Red; return }
Write-Host "Python:  $py"

# 2. ffmpeg (try winget if missing)
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "ffmpeg not found - trying 'winget install Gyan.FFmpeg'..." -ForegroundColor Yellow
  try { winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements } catch {}
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "ffmpeg still missing. Install from https://ffmpeg.org and put it on PATH." -ForegroundColor Yellow
    Write-Host "(Setup will continue; audio streaming won't work until ffmpeg is present.)"
  }
} else { Write-Host "ffmpeg:  $((Get-Command ffmpeg).Source)" }

# 3. Python dependencies
Write-Host "Installing Python dependencies..."
& $py -m pip install --quiet -r $req
Write-Host "Dependencies installed."

# 4. Auto-start task (hidden, user session)
$pythonw = Join-Path (Split-Path $py) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $py }  # fallback: visible console
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$server`"" -WorkingDirectory (Split-Path $server)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Auto-start task '$taskName' installed (runs hidden at login)."

# 5. (Re)start the server now from the new location
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in 'pythonw.exe','python.exe' -and $_.CommandLine -match 'homepod_server' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
Start-Process -FilePath $pythonw -ArgumentList "`"$server`"" -WorkingDirectory (Split-Path $server)
Start-Sleep -Seconds 1
$ok = $false
try { Invoke-WebRequest "http://127.0.0.1:17645/status" -TimeoutSec 3 -UseBasicParsing | Out-Null; $ok = $true } catch {}
if ($ok) { Write-Host "Server running on http://127.0.0.1:17645" -ForegroundColor Green }
else { Write-Host "Server didn't respond yet - check server\homepod_server.log" -ForegroundColor Yellow }

# 6. The one manual step (browsers can't be scripted to install add-ons)
Write-Host ""
Write-Host "LAST STEP - load the browser extension:" -ForegroundColor Cyan
Write-Host "  Firefox/Zen: about:debugging#/runtime/this-firefox  ->  Load Temporary Add-on"
Write-Host "               ->  pick  extension\manifest.json   (sign it for a permanent install - see README)"
Write-Host "  Edge/Chrome: edge://extensions  ->  Developer mode  ->  Load unpacked  ->  the 'extension' folder"
Write-Host ""
Write-Host "Then open the toolbar popup -> Scan (HomePod) and Audio (capture source)."
Write-Host "Uninstall any time with Uninstall.bat."
