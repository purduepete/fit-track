<#
.SYNOPSIS
    Continuously watch the upload folder and ingest new Health Auto Export
    archives into the deployed fittrack API.

.DESCRIPTION
    Loads FITTRACK_API_URL, FITTRACK_TOKEN and (optionally) FITTRACK_WATCH_DIR /
    FITTRACK_ARCHIVE_NAME from backend/.env.local (a gitignored file — never
    commit your token), then runs scripts/upload_folder.py in watch mode. Drop a
    new HAE .zip/.json into the watched folder and it is POSTed to the API and
    moved into the archive subfolder.

    The watched folder defaults to fittrack/upload; set FITTRACK_WATCH_DIR to a
    synced cloud folder (e.g. "G:\My Drive\fittrack" for Google Drive) and
    FITTRACK_ARCHIVE_NAME (e.g. "processed") to keep processed files tidied in
    place.

    Leave this window open; it polls every -IntervalSeconds. To run it after a
    reboot, just launch this script again (or add it to your Startup folder /
    a Scheduled Task at logon).

.PARAMETER IntervalSeconds
    Poll interval in seconds. Default: 300 (5 minutes).

.PARAMETER Background
    Run with output redirected to backend/logs/upload-watcher.log instead of
    the console. Used by the "SolutionDeploy-fit-track-upload-watcher" scheduled task; the
    wscript wrapper (run-watcher-hidden.vbs) already launches pwsh hidden, so
    the inherited console stays hidden and no terminal window appears.

.EXAMPLE
    .\Watch-Upload.ps1
    .\Watch-Upload.ps1 -IntervalSeconds 120
    .\Watch-Upload.ps1 -Background
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 300,
    [switch]$Background
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

# Singleton guard: if a watcher is already running, this launch is a no-op.
# A manual launch or restart-on-failure can fire
# while a healthy watcher already exists; without this guard duplicate watchers
# accumulate (each poll re-scans the same folder). We treat any live
# scripts.upload_folder process as the running watcher and exit early.
$existing = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*scripts.upload_folder*' })
if ($existing.Count -gt 0) {
    Write-Host "Upload watcher already running (PID(s): $($existing.ProcessId -join ', ')). Nothing to do."
    return
}

# Always use the CONSOLE python.exe -- even in -Background. pythonw.exe is a
# GUI-subsystem binary that PowerShell does NOT wait on (even with the *>>
# output redirection below): the & call returns immediately, so the parent
# pwsh exits, the wscript wrapper's bWaitOnReturn returns, the scheduled-task
# instance stops (reporting success in seconds and breaking the
# MultipleInstances=IgnoreNew dedup), and the orphaned pythonw is left with a
# stdout pipe owned by the now-dead pwsh -- its next print(flush=True) hits a
# broken pipe and the watcher dies. The console python.exe makes pwsh block for
# the watcher's whole lifetime, keeping the task instance alive. No window
# appears because run-watcher-hidden.vbs already starts pwsh hidden and the
# child console inherits that hidden console.
function Resolve-BasePython {
    $exe = 'C:\Files\ScoopApps\apps\python314\3.14.8\python.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        throw "Required Python 3.14.8 interpreter not found: $exe"
    }
    return $exe
}

$python = Resolve-BasePython
& $python -c "import sys; assert sys.version_info[:3] == (3, 14, 8)"
if ($LASTEXITCODE -ne 0) {
    throw 'The upload watcher requires Python 3.14.8.'
}

# Watch folder + archive subfolder are configurable via .env.local
# (FITTRACK_WATCH_DIR / FITTRACK_ARCHIVE_NAME); default to the local upload folder.
$watchDir = if ($env:FITTRACK_WATCH_DIR) { $env:FITTRACK_WATCH_DIR } else { Join-Path $repo 'upload' }
$archiveName = if ($env:FITTRACK_ARCHIVE_NAME) { $env:FITTRACK_ARCHIVE_NAME } else { '_archive' }
# Delete processed files older than this many days each scan (0 disables).
$retentionDays = if ($env:FITTRACK_RETENTION_DAYS) { [int]$env:FITTRACK_RETENTION_DAYS } else { 7 }

if (-not (Test-Path $watchDir)) {
    throw "Watch folder not found: $watchDir (check FITTRACK_WATCH_DIR in backend/.env.local)."
}

Push-Location $backend
try {
    if ($Background) {
        $logDir = Join-Path $backend 'logs'
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
        $log = Join-Path $logDir 'upload-watcher.log'
        # Keep the log from growing without bound (~5 MB cap).
        if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
            Move-Item $log "$log.1" -Force
        }
        "[$(Get-Date -Format s)] Watching $watchDir -> $($env:FITTRACK_API_URL) (every ${IntervalSeconds}s, archive=$archiveName, retentionDays=$retentionDays)." |
            Out-File -FilePath $log -Append -Encoding utf8
        & $python -m scripts.upload_folder --dir $watchDir --interval $IntervalSeconds --archive-name $archiveName --retention-days $retentionDays *>> $log
    }
    else {
        Write-Host "Watching $watchDir -> $($env:FITTRACK_API_URL) (every ${IntervalSeconds}s, archive=$archiveName, retentionDays=$retentionDays). Ctrl+C to stop."
        & $python -m scripts.upload_folder --dir $watchDir --interval $IntervalSeconds --archive-name $archiveName --retention-days $retentionDays
    }
}
finally {
    Pop-Location
}
# Pass the watcher's exit code through so a crash counts as a task failure and
# triggers the scheduled task's restart-on-failure.
exit $LASTEXITCODE
