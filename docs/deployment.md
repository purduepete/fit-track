# Live deployment

FitTrack runs on jimbrownhome1 as solution `fit-track`, using PostgreSQL database
`fit_track` and schema `public`. The app root is
`C:\ProgramData\SolutionDeploy\apps\fit-track`; its task is
`\JimlerTech\SolutionDeploy-fit-track`. The existing `sd-fittrack` Windows account
and `sd_fittrack_*` PostgreSQL roles keep their original names.

The public address is https://fit-track.jimlertech.com/. It requires Microsoft
sign-in through Cloudflare Access. The Google Drive uploader runs on the same host as
`\JimlerTech\SolutionDeploy-fit-track-upload-watcher` from
`C:\ProgramData\SolutionDeploy\apps\fit-track\upload-watcher\backend` and posts to
http://127.0.0.1:8791. It runs only while JimBrown is signed in, because `G:` is a
per-user Google Drive mount.

The watcher's `backend\scripts\run-watcher-hidden.vbs` launches
`C:\ProgramData\SolutionDeploy\runtime\powershell\7\pwsh.exe` explicitly.
This dedicated runtime is independent of desktop PowerShell updates. Update it
using `solution-deploy\scripts\Update-DeploymentPowerShell.ps1` from elevated
Windows PowerShell on the host. No watcher path change is required.
A bare `pwsh.exe` can resolve to the WindowsApps
alias and fail with VBScript error `800A0046` (Permission denied) at startup.
The wrapper waits for the watcher and returns its exit code to Task Scheduler.

The repository is https://github.com/purduepete/fit-track. Migration backups and
protected evidence are in
`C:\ProgramData\SolutionDeploy\archives\fit-track-migration-20261018` on the host.
