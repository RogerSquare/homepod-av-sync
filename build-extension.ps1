# Builds the browser extension into dist\homepod-av-sync.zip (manifest at the
# archive root, as Firefox/AMO requires). Run from PowerShell:  .\build-extension.ps1
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "extension"
$dist = Join-Path $PSScriptRoot "dist"
$zip = Join-Path $dist "homepod-av-sync.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $src "*") -DestinationPath $zip
Write-Host "Built $zip"
Write-Host ""
Write-Host "Install options:"
Write-Host "  - Temporary (dev):  about:debugging -> This Firefox -> Load Temporary Add-on -> extension\manifest.json"
Write-Host "  - Signed (.xpi):    web-ext sign --source-dir extension --channel unlisted --api-key <KEY> --api-secret <SECRET>"
Write-Host "    (get free API credentials at https://addons.mozilla.org/developers/addon/api/key/)"
