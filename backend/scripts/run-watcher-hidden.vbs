' Launches the FitTrack upload watcher with NO visible window.
'
' The "SolutionDeploy-fit-track-upload-watcher" scheduled task points at this file via
' wscript.exe. Because wscript.exe is not a console app and we start pwsh
' with an intWindowStyle of 0 (hidden), no console window ever flashes on
' screen -- unlike launching pwsh.exe directly, which briefly shows a window
' before -WindowStyle Hidden takes effect (every keep-alive re-check).
'
' We WAIT for pwsh to exit (bWaitOnReturn = True) so this wscript process
' stays alive for the whole lifetime of the watcher. That keeps the scheduled
' task instance "running", so the task's MultipleInstances=IgnoreNew setting
' correctly suppresses the every-10-min keep-alive relaunches while the watcher
' is healthy (a fire-and-forget launch would let duplicate watchers pile up).
'
' The watcher itself still runs windowless via python.exe with output redirected
' to backend/logs/upload-watcher.log (see Watch-Upload.ps1 -Background).

Set sh = CreateObject("WScript.Shell")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' Use the deployment runtime, independently of desktop PowerShell updates.
pwsh = sh.ExpandEnvironmentStrings("%ProgramData%") & "\SolutionDeploy\runtime\powershell\7\pwsh.exe"
cmd = """" & pwsh & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "Watch-Upload.ps1"" -Background"

' 0 = hidden window, True = wait for the process to exit (keeps the task
' instance alive so IgnoreNew dedup works).
WScript.Quit sh.Run(cmd, 0, True)
