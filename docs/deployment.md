# Live deployment

FitTrack runs on jimbrownhome1 as solution `fit-track`, using PostgreSQL database
`fit_track` and schema `public`. The app root is
`C:\ProgramData\SolutionDeploy\apps\fit-track`; its task is
`\JimlerTech\SolutionDeploy-fit-track`. The existing `sd-fittrack` Windows account
and `sd_fittrack_*` PostgreSQL roles keep their original names.

The public address is https://fit-track.jimlertech.com/. It requires Microsoft
sign-in through Cloudflare Access. The uploader continues to use
https://jimbrownhome1.tail8ad282.ts.net:8791, so its destination is unchanged.

The repository is https://github.com/purduepete/fit-track. Migration backups and
protected evidence are in
`C:\ProgramData\SolutionDeploy\archives\fit-track-migration-20261018` on the host.
