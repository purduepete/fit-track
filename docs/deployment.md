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

The repository is https://github.com/purduepete/fit-track. Migration backups and
protected evidence are in
`C:\ProgramData\SolutionDeploy\archives\fit-track-migration-20261018` on the host.
