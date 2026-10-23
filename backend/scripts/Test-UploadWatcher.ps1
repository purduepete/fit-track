<#
.SYNOPSIS
    One-shot health check for the FitTrack upload watcher and its ingest path.

.DESCRIPTION
    Run this on the machine that hosts the watcher (jimbrownhome1) when exports
    stop landing in the dashboard. It reports, in order:

      1. Scheduled task state, last run time and last result.
      2. Live watcher processes (the singleton guard keys off these).
      3. Watcher log freshness -- a stale log with a live process means a HUNG
         watcher, which restart-on-failure cannot detect on its own.
      4. Pending / processed / quarantined file counts in the watch folder.
      5. API reachability and whether the ingest token still authenticates.

    Read-only: it starts nothing, kills nothing and uploads nothing.

    A 401 on the token check means the token is invalid or disabled. A 403 means
    the token is VALID (an ingest-scoped token is correctly refused on a read
    endpoint), so 403 is the expected healthy answer.

.PARAMETER TailLines
    How many lines of upload-watcher.log to show. Default: 40.

.EXAMPLE
    .\Test-UploadWatcher.ps1
    .\Test-UploadWatcher.ps1 -TailLines 200
#>
[CmdletBinding()]
param(
    [int]$TailLines = 40
)

$ErrorActionPreference = 'Continue'
$backend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $backend -Parent
$taskPath = '\JimlerTech\'
$taskName = 'SolutionDeploy-fit-track-upload-watcher'

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

Write-Host "FitTrack watcher check on $env:COMPUTERNAME at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# Load config from the gitignored .env.local, same as Watch-Upload.ps1 does.
$envFile = Join-Path $backend '.env.local'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $k, $v = $line -split '=', 2
        Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
    }
}
else {
    Write-Host "MISSING: $envFile" -ForegroundColor Red
}

$watchDir = if ($env:FITTRACK_WATCH_DIR) { $env:FITTRACK_WATCH_DIR } else { Join-Path $repo 'upload' }
$archiveName = if ($env:FITTRACK_ARCHIVE_NAME) { $env:FITTRACK_ARCHIVE_NAME } else { '_archive' }
$interval = 300

Write-Section 'Scheduled task'
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Task '$taskName' is NOT registered. Run Register-UploadWatcherTask.ps1." -ForegroundColor Red
}
else {
    $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName
    [pscustomobject]@{
        State          = $task.State
        LastRunTime    = $info.LastRunTime
        LastTaskResult = '0x{0:X}' -f $info.LastTaskResult
        NextRunTime    = $info.NextRunTime
        MissedRuns     = $info.NumberOfMissedRuns
    } | Format-List
}

Write-Section 'Watcher processes'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*scripts.upload_folder*' })
if ($procs.Count -eq 0) {
    Write-Host 'No watcher process running.' -ForegroundColor Yellow
}
else {
    $procs | ForEach-Object {
        [pscustomobject]@{
            PID     = $_.ProcessId
            Started = $_.CreationDate
            Cmd     = $_.CommandLine
        }
    } | Format-List
    $procIds = $procs.ProcessId
    $rootProcs = @($procs | Where-Object { $_.ParentProcessId -notin $procIds })
    if ($rootProcs.Count -gt 1) {
        Write-Host "$($rootProcs.Count) watchers running; the singleton guard should have prevented this." -ForegroundColor Yellow
    }
}

Write-Section 'Log freshness'
$log = Join-Path $backend 'logs\upload-watcher.log'
if (-not (Test-Path $log)) {
    Write-Host "No log at $log" -ForegroundColor Yellow
}
else {
    $age = (Get-Date) - (Get-Item $log).LastWriteTime
    Write-Host ("Last write: {0:yyyy-MM-dd HH:mm:ss} ({1:N1} min ago)" -f (Get-Item $log).LastWriteTime, $age.TotalMinutes)
    # The watcher logs at least once per poll, so silence across several polls
    # means it is wedged even though the process still exists.
    if ($procs.Count -gt 0 -and $age.TotalSeconds -gt (3 * $interval)) {
        Write-Host 'HUNG: process alive but log is stale. Kill it and restart the task.' -ForegroundColor Red
    }
    Write-Host "--- last $TailLines lines ---"
    Get-Content $log -Tail $TailLines
}

Write-Section "Watch folder: $watchDir"
if (-not (Test-Path $watchDir)) {
    Write-Host "Watch folder NOT found (Google Drive not mounted?)." -ForegroundColor Red
}
else {
    $pending = @(Get-ChildItem $watchDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.zip', '.json' })
    Write-Host "Pending: $($pending.Count)"
    $pending | Sort-Object LastWriteTime -Descending | Select-Object -First 10 |
    Format-Table Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime -AutoSize
    foreach ($sub in @($archiveName, '_failed')) {
        $p = Join-Path $watchDir $sub
        $n = @(Get-ChildItem $p -File -ErrorAction SilentlyContinue).Count
        Write-Host "$sub`: $n file(s)"
    }
    $failed = @(Get-ChildItem (Join-Path $watchDir '_failed') -File -ErrorAction SilentlyContinue)
    if ($failed.Count -gt 0) {
        Write-Host 'Quarantined (permanent failures):' -ForegroundColor Yellow
        $failed | Sort-Object LastWriteTime -Descending | Select-Object -First 10 Name, LastWriteTime | Format-Table -AutoSize
    }
}

Write-Section 'API'
if (-not $env:FITTRACK_API_URL -or -not $env:FITTRACK_TOKEN) {
    Write-Host 'FITTRACK_API_URL / FITTRACK_TOKEN not set.' -ForegroundColor Red
}
else {
    $base = $env:FITTRACK_API_URL.TrimEnd('/')
    Write-Host "Target: $base"
    try {
        $r = Invoke-WebRequest "$base/api/health" -TimeoutSec 90 -UseBasicParsing
        Write-Host "Health: $($r.StatusCode) $($r.Content)" -ForegroundColor Green
    }
    catch {
        Write-Host "Health FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
    try {
        Invoke-WebRequest "$base/api/workouts?limit=1" -Headers @{ Authorization = "Bearer $env:FITTRACK_TOKEN" } -TimeoutSec 90 -UseBasicParsing | Out-Null
        Write-Host 'Token: valid (read-capable).' -ForegroundColor Green
    }
    catch {
        $code = $_.Exception.Response.StatusCode.value__
        switch ($code) {
            403 { Write-Host 'Token: valid (403 = ingest scope refused on a read endpoint, as expected).' -ForegroundColor Green }
            401 { Write-Host 'Token: INVALID or disabled (401). Reissue with New-IngestToken.ps1.' -ForegroundColor Red }
            default { Write-Host "Token check inconclusive: HTTP $code" -ForegroundColor Yellow }
        }
    }
}

Write-Section 'Next steps'
Write-Host @'
 - Pending files with an empty _failed folder means the API returned 5xx or the
   network failed; the watcher leaves those in place and retries. Check the
   server logs:  az containerapp logs show -n fittrack-api -g jimbpersonal-rg --type console --tail 200
 - Files in _failed means a 4xx or a corrupt archive. Fix the cause, then move
   them back into the watch folder to retry.
 - "HUNG" above: Get-Process python* | Stop-Process, then
   Start-ScheduledTask -TaskPath '\JimlerTech\' -TaskName 'SolutionDeploy-fit-track-upload-watcher'
 - Force one immediate pass without the task:
   cd backend; python -m scripts.upload_folder --dir "<watch dir>" --archive-name processed --once
'@
