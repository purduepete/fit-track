# Data pipeline & Health Auto Export setup

## What the export contains

Health Auto Export produces a dated `.zip` containing:

- `HealthAutoExport-YYYY-MM-DD-YYYY-MM-DD.json` — workouts + daily metrics
- `*.gpx` — a route track per outdoor workout (redundant for us; the route is
  **also embedded** in the JSON, which is what fittrack uses)

Each workout object embeds everything fittrack needs:

| JSON field                                                    | Used for                                   |
| ------------------------------------------------------------- | ------------------------------------------ |
| `id`                                                          | workout UUID (idempotency key)             |
| `name`                                                        | workout type (e.g. `Outdoor Walk`)         |
| `start`, `end`, `duration`                                    | timing (offset-aware timestamps)           |
| `distance` `{qty, units}`                                     | total distance (units may be `mi` or `km`) |
| `activeEnergyBurned`, `avgHeartRate`, `maxHeartRate`          | summary stats                              |
| `route` `[{latitude, longitude, altitude, speed, timestamp}]` | map + GPS splits                           |
| `heartRateData` `[{date, Avg, Min, Max}]`                     | HR chart + per-split HR                    |
| `walkingAndRunningDistance` `[{date, qty, units}]`            | indoor (sample) splits                     |
| `isIndoor`                                                    | context                                    |

Daily metrics arrive under `data.metrics` as `{name, units, data:[{date, qty}]}`.
Workouts whose source name is `ROUVY` or `Strava` (case-insensitive) are
excluded from Apple Health normalization, including historical reprocessing and XML
backfills. Their raw ingest payloads remain stored, but normalization will
continue to omit those workouts. The direct Strava importer below is separate
and accepts only Zwift virtual rides.

## Direct Zwift import through Strava

Zwift uploads to Strava; FitTrack reads those rides directly without Apple
Health. Apple Health remains the source for steps, sleep and other workouts.
Create a personal application at https://www.strava.com/settings/api with
Authorization Callback Domain `localhost`. Strava currently requires a
subscription to create an application.

Run the authorization helper in a separate terminal, outside the chat terminal.
It prompts for the Client ID and a hidden Client Secret, opens Strava for
`read,activity:read_all` consent, and saves the resulting tokens privately.
Do not paste secrets or tokens into chat or pass them on a command line.

```powershell
cd C:\Files\Dev\main\fit-track\backend
.\scripts\Connect-Strava.ps1
```

The default credential file is `%LOCALAPPDATA%\FitTrack\strava\tokens.json`.
For the hosted app, use `-TokenFile` pointing at a dedicated `strava` directory
under the app's protected `shared\secrets` folder and pass the app account's SID
as `-RuntimeSid`. That account needs Modify access because refresh tokens rotate.
The helper restricts the directory to the current user, administrators, SYSTEM,
and the specified runtime account. Existing credentials require `-Replace`;
stop the sync first to avoid concurrent token replacement.

Set `STRAVA_TOKEN_FILE` to the credential file's path **on the runtime host**.
`STRAVA_POLL_SECONDS` defaults to 900 (15 minutes), with a minimum of 300.
Restart the app after configuring it. An unset token path disables Strava sync.
The sync runs inside the existing app process and its startup task, so it
does not need a new scheduled task, a logged-in user, or an inbound webhook.
Run one app worker; do not share a credential file between multiple sync processes.

Behavior:

- By default, imports begin at local midnight on the authorization day and keep
  that fixed boundary on future days. The live personal connection starts on
  10/23/2026. No earlier Strava history is imported. `-Days` can explicitly request
  historical data for a different setup.
  Later polls reread a rolling 7-day overlap, never before the initial boundary.
- All activity-list pages are read. Only `VirtualRide` activities whose detailed
  `device_name` contains `Zwift` are imported. ROUVY and ordinary rides are skipped.
- **Pull Strava data** in the app header starts an immediate pull using the same
  saved boundary as the automatic 15-minute sync. It shows progress, the number
  of imported rides (or an up-to-date message), and actionable errors. The active
  dashboard, workout list or detail refreshes after success.
- Manual and scheduled pulls share a process lock. Overlapping manual requests
  get HTTP 409; scheduled polls skip if a pull is already running. Keep one app
  worker. Manual pulls require gateway authentication or an ingest-scoped token,
  plus the custom `X-FitTrack-Sync: 1` header to prevent cross-origin browser posts.
- Strava IDs become `strava:<id>` workout IDs. Unchanged activity summaries avoid
  repeat detail/stream downloads; changed summaries within the overlap update
  the same workout. Changes to older activities require explicit reimport work.
- Distance, elapsed duration, calories and summary heart rate are imported when
  available. Heart-rate samples and cumulative-distance streams supply the
  chart and splits. Missing optional measurements stay empty.
- Zwift's virtual GPS coordinates are omitted. Power and cadence are not imported.
- A Zwift-sourced Apple Health cycling workout and a direct Strava ride are
  considered duplicates when starts differ by at most 60 seconds and ends by
  at most 120 seconds. The first stored copy is kept. Apple Watch recordings
  remain separate.
- Each ride and its raw event commit together. Failures leave that ride
  uncommitted; earlier committed rides are safe to retry. The sync watermark
  advances only after every page succeeds. Rate-limit, authorization and other
  failures are logged explicitly and retried on the next poll.
- PostgreSQL imports share a transaction-scoped advisory lock so simultaneous
  Health and Strava imports cannot both pass the cross-source duplicate check.
- Raw events use source `strava` and contain the summary, detailed activity and
  requested streams. Reprocessing dispatches by source and preserves the Apple
  Health source exclusions.

Get the required independent database-write review before enabling the live
import. Check the app log for `Strava activity ... committed` and
`Strava sync complete`, then verify the imported rides in FitTrack.

## Configure the iOS app

In **Health Auto Export → Automations**, create separate automations for health
metrics and workouts:

1. **Format:** JSON.
2. **Include** the workout **Route**, **Heart Rate**, and **Walking + Running
   Distance** data (these are what power the map, HR chart, and splits).
3. **Destination:** the fittrack ingest endpoint via **REST API** (see
   [Direct REST push](#direct-rest-push-recommended)), or a folder that syncs to
   your PC — Google Drive, iCloud Drive (with _iCloud for Windows_), Dropbox, or
   OneDrive.
4. **Health metrics:** use a 14-day date range, **Summarize Data:** on, and
   **Time Grouping:** Days.
5. **Workouts:** enable **Include Route Data** and **Include Workout Metrics**,
   with **Time Grouping:** Seconds. Use a 7-day or 14-day date range.
6. **Batch Requests:** off for both automations.

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

### Google Drive (folder fallback)

The phone uploads each export to a `fittrack` folder in Google Drive; **Google
Drive for Desktop** mirrors it locally (e.g. `G:\My Drive\fittrack`). Point the
watcher there and keep processed files tidied in a `processed` subfolder that
stays in Drive:

```powershell
.\.venv\Scripts\python.exe -m scripts.upload_folder --dir "G:\My Drive\fittrack" --archive-name processed
```

The `Watch-Upload.ps1` launcher reads `FITTRACK_WATCH_DIR`,
`FITTRACK_ARCHIVE_NAME` and `FITTRACK_RETENTION_DAYS` from `backend/.env.local`,
so the same setup runs unattended via the **`\JimlerTech\SolutionDeploy-fit-track-upload-watcher`** Scheduled
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
runs **as the current user, only while logged on**. It starts at logon and stays
running for the watcher's lifetime. If the watcher exits with an error, Task
Scheduler restarts it up to 3 times, 1 minute apart. The task passes
`-Background`, so the watcher runs **windowless** via `pythonw.exe` (no terminal
window) and writes output to `backend/logs/upload-watcher.log`. A healthy
watcher shows as **two** `pythonw` processes (the venv stub spawns a worker
child).

### Direct REST push (recommended)

The phone posts straight to the API, so no PC, Google Drive sync or watcher is
involved.

1. **Create an ingest-scoped token** in your own terminal (outside VS Code, so
   the printed token never lands in a chat transcript). It writes the token hash
   to the live database, and the raw token prints once:

   ```powershell
   cd backend
   .\scripts\New-IngestToken.ps1 -Name iphone-hae -Scope ingest
   ```

2. In **Health Auto Export → Automations → New Automation**, choose **REST API**:
   - **URL:** `https://<container-app>/api/ingest/health-auto-export`
   - **Header:** `Authorization: Bearer <ingest token>`
   - **Format:** JSON, **Export Version:** v2.
   - **Health Metrics automation:** select the metrics you use, turn
     **Summarize Data** on, and set **Time Grouping** to **Days**.
   - **Health Metrics date range:** use **14 days** as a workaround. Earlier
     7-day exports had incomplete steps, while a 14-day export contained all
     days. The cause of that difference has not been confirmed.
   - **Workouts automation:** enable **Include Route Data** and
     **Include Workout Metrics**, including heart rate and walking + running
     distance. Set **Time Grouping** to **Seconds**, with a 7-day or 14-day range.
   - **Batch Requests:** off for both. Steps are summed within each request,
     then replace the stored daily total. Splitting one day's points across
     requests could leave only the last batch's partial total.
   - **Sync Frequency:** a few times a day. Schedule reminders are optional.
   - **Overlap:** identical payloads are deduplicated by hash; normalized rows
     are upserted per day or workout UUID.
3. Run it once manually and check the dashboard's "last ingest" time.

The route is embedded in the JSON, so no separate GPX upload is needed.

Things to know:

- **Cold start.** The app runs at `minReplicas 0`, so the first request after
  idle can take a while while a replica starts. Increase the request timeout
  if needed. If a request times out, check the export log and run it again;
  identical payloads are deduplicated.
- **Size.** Bodies over `MAX_INGEST_BYTES` (64 MiB) are rejected with `413`. A
  30-day export was estimated at about 35 MiB in the backend configuration.
  Check actual payload size if a request is rejected.
- **Failures.** Nothing is quarantined on this path. Check the app's export log
  on the phone, or the `raw_ingest_events` table for the event status.
- The folder watcher above stays available as a fallback and for manual drops.

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
