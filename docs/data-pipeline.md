# Data pipeline & Health Auto Export setup

## What the export contains

Health Auto Export produces a dated `.zip` containing:

- `HealthAutoExport-YYYY-MM-DD-YYYY-MM-DD.json` — workouts + daily metrics
- `*.gpx` — a route track per outdoor workout (redundant for us; the route is
  **also embedded** in the JSON, which is what fittrack uses)

Each workout object embeds everything fittrack needs:

| JSON field | Used for |
| --- | --- |
| `id` | workout UUID (idempotency key) |
| `name` | workout type (e.g. `Outdoor Walk`) |
| `start`, `end`, `duration` | timing (offset-aware timestamps) |
| `distance` `{qty, units}` | total distance (units may be `mi` or `km`) |
| `activeEnergyBurned`, `avgHeartRate`, `maxHeartRate` | summary stats |
| `route` `[{latitude, longitude, altitude, speed, timestamp}]` | map + GPS splits |
| `heartRateData` `[{date, Avg, Min, Max}]` | HR chart + per-split HR |
| `walkingAndRunningDistance` `[{date, qty, units}]` | indoor (sample) splits |
| `isIndoor` | context |

Daily metrics arrive under `data.metrics` as `{name, units, data:[{date, qty}]}`.

## Configure the iOS app

In **Health Auto Export → Automations**, create a daily automation:

1. **Format:** JSON.
2. **Include** the workout **Route**, **Heart Rate**, and **Walking + Running
   Distance** data (these are what power the map, HR chart, and splits).
3. **Destination:** a folder that syncs to your PC — iCloud Drive (with *iCloud
   for Windows*), Dropbox, or OneDrive — or, for a REST push, the fittrack
   ingest endpoint directly.

> The parser is tolerant of field-name and unit variations across app versions,
> but the three data categories above must be enabled or the corresponding
> features will be empty.

## Daily pickup (folder → API)

`scripts/upload_folder.py` watches a folder, extracts the JSON from each `.zip`
(or reads `.json` directly), POSTs it to `/api/ingest/health-auto-export` with
your ingest token, and moves processed files into a subfolder (`--archive-name`,
default `_archive`). A `--min-age-seconds` guard (default 15) skips files that
were modified very recently, so a file still downloading/syncing from the cloud
is not read mid-write; a file is only moved once its POST succeeds (failures are
retried on the next poll, and ingest is idempotent).

```powershell
$env:FITTRACK_API_URL = "https://<container-app>"   # or http://localhost:8000
$env:FITTRACK_TOKEN   = "<ingest token>"
cd backend
.\.venv\Scripts\python.exe -m scripts.upload_folder --dir ..\upload --once
```

Run without `--once` to poll continuously, or register a **Scheduled Task** that
runs the watcher at logon (see below).

### Google Drive (the wired default)

The phone uploads each export to a `fittrack` folder in Google Drive; **Google
Drive for Desktop** mirrors it locally (e.g. `G:\My Drive\fittrack`). Point the
watcher there and keep processed files tidied in a `processed` subfolder that
stays in Drive:

```powershell
.\.venv\Scripts\python.exe -m scripts.upload_folder --dir "G:\My Drive\fittrack" --archive-name processed
```

The `Watch-Upload.ps1` launcher reads `FITTRACK_WATCH_DIR`,
`FITTRACK_ARCHIVE_NAME` and `FITTRACK_RETENTION_DAYS` from `backend/.env.local`,
so the same setup runs unattended via the **`FitTrack Upload Watcher`** Scheduled
Task. Any other provider (iCloud Drive / OneDrive / Dropbox) works identically —
just point `FITTRACK_WATCH_DIR` at its local folder.

**Retention:** processed archives are auto-pruned. `Watch-Upload.ps1` passes
`--retention-days` (default **7**, override with `FITTRACK_RETENTION_DAYS`; set
`0` to disable), so each scan deletes files in the `processed` folder older than
that many days — freeing Google Drive space. Only `processed` is pruned; the
`_failed` quarantine is left alone so failures stay visible.

Register (or re-register) the task with:

```powershell
.\scripts\Register-UploadWatcherTask.ps1
```

Because the watcher reads the interactive Google Drive mount (`G:`), the task
runs **as the current user, only while logged on**. It is **self-healing**: it
starts at logon and a keep-alive trigger re-checks every 10 minutes — with
`MultipleInstances=IgnoreNew`, each check is a no-op while the watcher is alive
and relaunches it if it has died (plus restart-on-failure). The task passes
`-Background`, so the watcher runs **windowless** via `pythonw.exe` (no terminal
window) and writes output to `backend/logs/upload-watcher.log`. A healthy
watcher shows as **two** `pythonw` processes (the venv stub spawns a worker
child).

### Direct REST push (optional, Phase 3)

Instead of the folder, point Health Auto Export's REST API destination at
`https://<container-app>/api/ingest/health-auto-export` with an
`Authorization: Bearer <ingest token>` header. The route is embedded in the
JSON, so no separate GPX upload is needed.

## One-time historical backfill

The native Apple Health export (`Health app → profile → Export All Health Data`)
produces a large `export.xml` plus a `workout-routes/` folder. Backfill it once:

```powershell
cd backend
.\.venv\Scripts\python.exe -m scripts.backfill_export_xml --export-dir "C:\path\to\apple_health_export"
```

It streams the XML (`lxml.iterparse`, never fully in memory), extracts workout
summaries and per-day metric aggregates, links `workout-routes/*.gpx` tracks to
their workouts, and computes historical splits. Use `--no-routes` to skip GPX.

> **DB-altering** — get a Gemini second opinion before running against the live
> WebPortfolio database.
