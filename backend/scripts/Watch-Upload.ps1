<#
.SYNOPSIS
    Continuously watch the upload folder and ingest new Health Auto Export
    archives into the deployed fittrack API.

.DESCRIPTION
    Loads FITTRACK_API_URL and FITTRACK_TOKEN from backend/.env.local (a
    gitignored file — never commit your token), then runs
    scripts/upload_folder.py in watch mode. Drop a new HAE .zip/.json into
    fittrack/upload and it is POSTed to the API and moved to upload/_archive.

    Leave this window open; it polls every -IntervalSeconds. To run it after a
    reboot, just launch this script again (or add it to your Startup folder /
    a Scheduled Task at logon).

.PARAMETER IntervalSeconds
    Poll interval in seconds. Default: 300 (5 minutes).

.EXAMPLE
    .\Watch-Upload.ps1
    .\Watch-Upload.ps1 -IntervalSeconds 120
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 300
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $backend -Parent

# Load config from the gitignored .env.local (KEY=VALUE lines).
$envFile = Join-Path $backend '.env.local'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $k, $v = $line -split '=', 2
        Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
    }
}

if (-not $env:FITTRACK_API_URL -or -not $env:FITTRACK_TOKEN) {
    throw "Set FITTRACK_API_URL and FITTRACK_TOKEN (in backend/.env.local or the environment)."
}

$venvPython = Join-Path $backend '.venv\Scripts\python.exe'
$python = if (Test-Path $venvPython) { $venvPython } else { 'python' }
$uploadDir = Join-Path $repo 'upload'

Push-Location $backend
try {
    Write-Host "Watching $uploadDir -> $($env:FITTRACK_API_URL) (every ${IntervalSeconds}s). Ctrl+C to stop."
    & $python -m scripts.upload_folder --dir $uploadDir --interval $IntervalSeconds
}
finally {
    Pop-Location
}
