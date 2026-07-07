<#
.SYNOPSIS
    (Re)register the "FitTrack Upload Watcher" scheduled task with self-healing
    keep-alive settings.

.DESCRIPTION
    Watch-Upload.ps1 must run in the interactive logon session because it reads
    the Google Drive mount (G:), so this task runs as the current user, only
    while logged on. To make sure a crashed / killed watcher comes back on its
    own, the task uses:

      * an AtLogOn trigger, AND a time trigger repeating every -RepeatMinutes
        (default 10) indefinitely -- because MultipleInstances=IgnoreNew, each
        repeat is a no-op while the watcher is alive and relaunches it if dead;
      * restart-on-failure (RestartCount / RestartInterval);
      * StartWhenAvailable + no execution time limit + battery-safe flags.

    Idempotent: re-running replaces the existing task definition.

.PARAMETER RepeatMinutes
    Keep-alive re-launch check interval in minutes. Default: 10.

.EXAMPLE
    .\Register-UploadWatcherTask.ps1
#>
[CmdletBinding()]
param(
    [int]$RepeatMinutes = 10
)

$ErrorActionPreference = 'Stop'

$taskName = 'FitTrack Upload Watcher'
$script   = Join-Path $PSScriptRoot 'Watch-Upload.ps1'
$pwsh     = (Get-Command pwsh.exe).Source
$user     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $script)) { throw "Watch-Upload.ps1 not found at $script" }

$action = New-ScheduledTaskAction -Execute $pwsh `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Background"

$repeat = New-TimeSpan -Minutes $RepeatMinutes

# Trigger 1: at logon, then keep-alive re-check every $RepeatMinutes.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval $repeat).Repetition

# Trigger 2: time-based keep-alive so recovery fires even if already logged on.
$timed = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval $repeat

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger @($logon, $timed) `
    -Settings $settings `
    -Principal $principal `
    -Description "Watches the Google Drive fittrack folder and ingests Health Auto Export archives into the fittrack API. Self-healing: relaunches every $RepeatMinutes min if not running." `
    -Force | Out-Null

Write-Host "Registered '$taskName' (keep-alive every $RepeatMinutes min)."
Start-ScheduledTask -TaskName $taskName
Write-Host "Started. State:" (Get-ScheduledTask -TaskName $taskName).State
