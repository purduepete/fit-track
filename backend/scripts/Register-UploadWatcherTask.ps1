<#
.SYNOPSIS
    (Re)register the \JimlerTech\SolutionDeploy-fit-track-upload-watcher scheduled task.

.DESCRIPTION
    Watch-Upload.ps1 must run in the interactive logon session because it reads
    the Google Drive mount (G:), so this task runs as the current user, only
    while logged on. The task launches pwsh via a wscript.exe VBScript wrapper
    (run-watcher-hidden.vbs) so NO console window flashes on screen at logon or
    on start -- launching pwsh.exe directly briefly shows a
    window before -WindowStyle Hidden applies. The task uses:

      * a single AtLogOn trigger with no repetition. The task instance stays
        running for the watcher's lifetime, so a repeat trigger would only be
        refused (0x800710E0) and show up as an error in Task Scheduler;
      * restart-on-failure (3 retries, 1 minute apart). Watch-Upload.ps1 exits
        with the watcher's exit code, so a crash counts as a failure;
      * StartWhenAvailable + no execution time limit + battery-safe flags.

    Re-running replaces the existing task definition.

.EXAMPLE
    .\Register-UploadWatcherTask.ps1
#>
[CmdletBinding()]
param()

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

$logon = New-ScheduledTaskTrigger -AtLogOn -User $user

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
    -Trigger $logon `
    -Settings $settings `
    -Principal $principal `
    -Description "Watches the Google Drive fittrack folder and ingests Health Auto Export archives into the fittrack API. Runs at logon because it reads the per-user G: Google Drive mount; restarts up to 3 times on failure." `
    -Force | Out-Null

Write-Host "Registered '$taskPath$taskName'."
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
Write-Host "Started. State:" (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State
