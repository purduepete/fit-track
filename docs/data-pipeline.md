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
your ingest token, and moves processed files to `_archive`.

```powershell
$env:FITTRACK_API_URL = "https://<container-app>"   # or http://localhost:8000
$env:FITTRACK_TOKEN   = "<ingest token>"
cd backend
.\.venv\Scripts\python.exe -m scripts.upload_folder --dir ..\upload --once
```

Run without `--once` to poll continuously, or register a **Scheduled Task** that
runs the `--once` command daily.

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
