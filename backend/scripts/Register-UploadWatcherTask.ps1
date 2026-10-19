<#
.SYNOPSIS
    (Re)register the \JimlerTech\SolutionDeploy-fit-track-upload-watcher scheduled task with self-healing
    keep-alive settings.

.DESCRIPTION
    Watch-Upload.ps1 must run in the interactive logon session because it reads
    the Google Drive mount (G:), so this task runs as the current user, only
    while logged on. The task launches pwsh via a wscript.exe VBScript wrapper
    (run-watcher-hidden.vbs) so NO console window flashes on screen at logon or
    on each keep-alive re-check -- launching pwsh.exe directly briefly shows a
    window before -WindowStyle Hidden applies. To make sure a crashed / killed
    watcher comes back on its own, the task uses:

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

$taskPath = '\JimlerTech\'
$taskName = 'SolutionDeploy-fit-track-upload-watcher'
$script   = Join-Path $PSScriptRoot 'Watch-Upload.ps1'
$launcher = Join-Path $PSScriptRoot 'run-watcher-hidden.vbs'
$wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$user     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $script))   { throw "Watch-Upload.ps1 not found at $script" }
if (-not (Test-Path $launcher)) { throw "run-watcher-hidden.vbs not found at $launcher" }

# Launch through wscript.exe (no console) so no window flashes; the VBScript
# starts pwsh hidden, which in turn runs Watch-Upload.ps1 -Background.
$action = New-ScheduledTaskAction -Execute $wscript `
    -Argument "`"$launcher`""

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

# Remove the pre-migration task so two watchers never scan the same folder.
Get-ScheduledTask -TaskPath '\' -TaskName 'FitTrack Upload Watcher' -ErrorAction SilentlyContinue |
    Unregister-ScheduledTask -Confirm:$false

Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName `
    -Action $action `
    -Trigger @($logon, $timed) `
    -Settings $settings `
    -Principal $principal `
    -Description "Watches the Google Drive fittrack folder and ingests Health Auto Export archives into the fittrack API. Self-healing: relaunches every $RepeatMinutes min if not running." `
    -Force | Out-Null

Write-Host "Registered '$taskPath$taskName' (keep-alive every $RepeatMinutes min)."
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
Write-Host "Started. State:" (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State
