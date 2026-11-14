# Fit Track

First entry keeps the mounted shell hidden until the active route and its initial data-backed sections are ready. Shell and content enter together over 600ms; reduced motion skips the fade. Initial content stays visible after the entrance; newly mounted route content retains its own entrance. Refreshes and later navigation retain the shell.

Track your Apple Watch / iPhone **workouts** on Windows — export daily from
Health, store it in PostgreSQL, and browse a web dashboard with **mileage splits**,
a **route map**, and **heart-rate** charts.

No Mac required. Route, HR and distance data all come from the JSON that
[Health Auto Export](https://apps.apple.com/app/health-auto-export/id1115567069)
produces, so a single daily export drives everything.

```
Apple Watch ─▶ Apple Health ─▶ Health Auto Export (iOS)
     ─▶ dated .zip into a synced folder (iCloud / Dropbox / OneDrive)
     ─▶ upload_folder.py  ──POST(token)──▶  FastAPI /api/ingest
     ─▶ PostgreSQL `fit_track` on jimbrownhome1
     ─▶ React + Recharts + Leaflet dashboard
```

## Features

- **Daily pickup** — drop the Health Auto Export `.zip` in `upload/`; the
  watcher extracts the JSON, POSTs it to the API, and archives the file.
- **Mileage splits** — per-mile / per-km pace + avg HR, computed from the GPS
  route (with a distance-sample fallback for indoor workouts). The mi/km selector
  stays in the Workouts and workout detail headers on phone, tablet and desktop,
  converting distance, pace and elevation, including the Workouts totals.
  The shared unit choice survives browser sessions on the same site, with a
  server-set cookie fallback when Safari clears local storage.
- **Route map** — the GPS track drawn on OpenStreetMap (no API key).
- **Heart-rate chart** — HR over the course of the workout.
- **Workout date filter**: defaults to Current week, Monday through Sunday in
  Pacific time (including daylight saving). It is the first range option;
  dashboard day links still show that exact day. Dashboard and Workouts share
  a square segmented navigation control with a sliding selected state.
- **Workout totals**: the bottom row totals the visible, loaded workouts after
  searching: count, duration, distance and active calories. Overall pace uses
  workouts with both distance and duration; average HR is duration-weighted
  across workouts with HR and positive duration. Max HR is the highest available
  value. Missing measurements stay empty; loading more updates the totals.
  Distances and calories use comma thousands separators; distances retain 2 decimal places.
- **Daily subtotals**: on a day with 2 or more workouts of one type, a subtotal row
  follows that day's workouts, using the same rules as the bottom row. The oldest
  loaded day gets none while more rows remain to load.
- **Power, W/kg and cadence**: Strava rides show average power, W/kg and cadence
  (rpm). Enter your weight in kg on the Workouts page; W/kg is fixed when a ride
  is imported, so a later weight change affects only new rides. Totals average
  these by duration. On phones, empty power cells are hidden.
- **Sorting**: click any column header except Type to sort by it; click again to
  reverse. Pace starts fastest first, the rest highest first. Loaded rows reorder at once.
  When more rows remain, the server sorts the whole range while the table stays on
  screen, so Load more continues in order. Workouts missing the value come last. Sorting by anything except date lists workouts flat with their
  dates, without day groups or daily subtotals. Phones hide the table header, so they
  use the order last chosen on a wider screen. The choice is remembered on the device
  and in a server-set cookie.
- **Column views**: Ride (distance, pace, active kcal, avg HR), Power (avg power,
  W/kg, cadence, elevation) or All. Time, type and duration always show; Ride is the
  default and the choice is remembered like the sort. Distance, avg power and W/kg
  carry a bar sized against the best visible workout of the same type. Sorting by a
  column the view hides shows a "Sorted by" label with a way back to date order. On
  phones each workout is a compact card: time, type and duration, then the metrics.
- **Dashboard**: this week's (Monday to Sunday, Pacific) active days, workout
  time and active energy, matching the Workouts page's default range; resting-HR,
  VO₂ max and sleep trends, plus a 30-day daily-steps chart with a 10k goal line,
  a stepped 7-day block-average line, and green bars on days with a logged
  workout (tap one to open that day on the Workouts page).
- **Idempotent ingest** — keyed on the Apple workout UUID; re-ingesting the same
  export never duplicates. Raw payloads are stored for safe re-processing.
- **Simple token auth** — bearer tokens you generate locally; only the hash is
  stored.
- **SiteDock sign-in handoff**: when FitTrack is embedded in SiteDock, it saves
  its token with SiteDock and restores it on load, because Safari on iPad erases
  embedded-frame storage when the app closes. It only talks to a direct parent
  whose origin is in `VITE_SITEDOCK_ORIGINS` (comma-separated, set at build
  time; defaults to `https://jimbrownhome1.tail8ad282.ts.net:8790` and
  `https://site-dock.jimlertech.com`). Set `VITE_SITEDOCK_ORIGINS` before the
  frontend build to override them. Firefox
  doesn't expose `location.ancestorOrigins`, so the handoff is off there.

## Repository layout

| Path               | Purpose                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `backend/app/`     | FastAPI app: config, db, models, auth, normalizer, geo/splits, Strava sync, routers                    |
| `backend/scripts/` | `token_admin` / `New-IngestToken.ps1`, `upload_folder` / `Watch-Upload.ps1`, replay and backfill tools |
| `backend/tests/`   | pytest suite (geo, normalizer, persistence, Strava, API)                                               |
| `frontend/`        | React + Vite + TS dashboard (Recharts, react-leaflet)                                                  |
| `deploy/`          | Solution Deploy manifest, launcher and reviewed PostgreSQL migrations (`deploy/postgresql`)            |
| `docs/`            | Architecture, data pipeline, splits algorithm, API, schema, testing, deployment                        |

## Hosting

Fit Track runs on `jimbrownhome1` with the dedicated PostgreSQL database
`fit_track` (`public` schema). See [docs/deployment.md](docs/deployment.md).

- Public dashboard: `https://fit-track.jimlertech.com`, protected by Microsoft
  sign-in through Cloudflare Access.
- Private dashboard: `https://jimbrownhome1.tail8ad282.ts.net:8791`.
- Upload endpoint: append `/api/ingest/health-auto-export` to the private URL.
  Uploads still require an existing ingest-scoped bearer token.
- `DATABASE_URL=postgresql+psycopg://.../fit_track` lives in the protected
  SolutionDeploy `shared\secrets\app.env`, never in this repository. Without it
  the app fails readiness.
- `GATEWAY_READ_AUTH=true` removes the dashboard's second token prompt. Enable
  it only with a loopback listener and protected Cloudflare Access / private
  Tailscale routes. Its default is false; ingest authentication stays enabled.
- `deploy\application.json` binds the API to `127.0.0.1:8791` and uses the
  framework's restricted account, startup task, and watchdog.
- The runtime uses Python 3.14.8; upgrading it requires rebuilding the
  release's `.venv`. The upload watcher also uses Python 3.14.8, selected by
  `backend\scripts\Watch-Upload.ps1`, and only the standard library.
- The Google Drive upload client runs on `jimbrownhome1` in JimBrown's
  signed-in session, where Google Drive mounts `G:`, and posts to
  `http://127.0.0.1:8791`. It stops while nobody is signed in.

## Local development

Prerequisites: Python 3.12+, Node 20+ and a PostgreSQL database for the app.

```powershell
# 1. Backend
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-dev.txt
Copy-Item .env.example .env   # then set DATABASE_URL

# 2. Create the tables: apply deploy\postgresql\001_initial.sql and each later
#    numbered file, in order, to your local database.

# 3. Create tokens (shown once)
.\scripts\New-IngestToken.ps1 -Name iphone-hae  -Scope ingest
.\scripts\New-IngestToken.ps1 -Name dashboard   -Scope read

# 4. Run the API
.\.venv\Scripts\uvicorn.exe app.main:app --reload
```

```powershell
# 5. Frontend (separate terminal), proxies /api to :8000
cd frontend
npm install
npm run dev        # http://localhost:5173  (paste the read token)
```

Carry `backend/.env` and `backend/.env.local` between machines over a secure
channel (both are gitignored) and re-mint a read token, since only the SHA-256
hash of a token is stored.

**`403` from a dashboard endpoint** is a scope mismatch; an invalid token
returns `401`. The dashboard needs a `read`-scoped token, so a `403` normally
means the `ingest` token from `.env.local` was pasted instead. Check with
`python -m scripts.token_admin list`.

### Two healthy states that look like failures

**`Last Run Result` of `0x41301`** ("the task is currently running") on the
`\JimlerTech\SolutionDeploy-fit-track-upload-watcher` task is healthy. The task
instance stays running for the watcher's whole lifetime. `Running` plus recent
`OK ...` lines in `backend/logs/upload-watcher.log` is healthy. `Ready` with a
stale log is the real failure. Older registrations repeated every 10 minutes and
showed `0x800710E0` ("refused the request"); re-run
`Register-UploadWatcherTask.ps1` to remove that repeat.

**Two `python.exe` processes** for `scripts.upload_folder` is one watcher, not
two. `.venv\Scripts\python.exe` is a launcher stub that re-execs the base
interpreter as its child. Check the relationship rather than the count:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'scripts.upload_folder' } |
  Select ProcessId, ParentProcessId, ExecutablePath
```

A stub plus its own child is expected. Two unrelated parents, or two `Watching
...` startup lines in the log, would be a genuine duplicate.

## Daily workflow

1. In **Health Auto Export**, configure an automation to export **JSON**
   including **Route**, **Heart Rate** and **Walking + Running Distance**, to a
   folder that syncs to this PC. This project is wired for **Google Drive**: the
   phone uploads to a `fittrack` folder in Drive, which Google Drive for Desktop
   mirrors locally (e.g. `G:\My Drive\fittrack`). iCloud Drive / OneDrive /
   Dropbox work the same way — just point `FITTRACK_WATCH_DIR` at the folder (or
   drop files into `fittrack/upload` directly).
2. Run the folder watcher. The easiest way is the launcher, which reads
   `FITTRACK_API_URL` / `FITTRACK_TOKEN` (and the optional watch-folder settings)
   from a gitignored `backend/.env.local` and polls the folder continuously:

   ```powershell
   cd backend
   .\scripts\Watch-Upload.ps1                 # polls every 5 min; -IntervalSeconds to change
   ```

   `backend/.env.local` (never committed — matched by `*.local`):

   ```
   FITTRACK_API_URL=http://127.0.0.1:8791
   FITTRACK_TOKEN=<ingest token>
   # Optional: watch a synced cloud folder instead of fittrack/upload, and keep
   # processed files tidied in a subfolder that stays in the cloud folder.
   FITTRACK_WATCH_DIR=G:\My Drive\fittrack
   FITTRACK_ARCHIVE_NAME=processed
   ```

   Or run the client directly (equivalent):

   ```powershell
   $env:FITTRACK_API_URL = "http://127.0.0.1:8791"   # or http://localhost:8000
   $env:FITTRACK_TOKEN   = "<ingest token>"
   cd backend
   .\.venv\Scripts\python.exe -m scripts.upload_folder --dir ..\upload
   ```

   Processed files move to `upload/_archive`. Use `--once` for a single pass, or
   add `Watch-Upload.ps1` to your Startup folder / a logon Scheduled Task so the
   watcher survives reboots.

See [`docs/data-pipeline.md`](docs/data-pipeline.md) for the Health Auto Export
setup and the one-time historical backfill (`backfill_export_xml.py`).

## Testing

```powershell
cd backend;  .\.venv\Scripts\python.exe -m pytest -q     # backend
cd frontend; npm run test                                # frontend
```

CI (`.github/workflows/ci.yml`) runs both on every push/PR. See
[`docs/testing.md`](docs/testing.md).

## Release to jimbrownhome1

After committing and pushing, release through Solution Deploy:

```powershell
& C:\Files\Dev\main\solution-deploy\Deploy.ps1 -Action Release `
    -App fit-track -Target jimbrownhome1 -Component web -Commit origin/main `
    -ApproveRelease -ApprovalReason 'Approved Fit Track web update' `
    -DatabaseChangesReviewed
```

The command builds the pushed source, prepares a new release folder, switches
the runtime, verifies both access paths, and records the completion time shown
by the Solution Directory. Never copy a frontend build into `current` or an
existing release folder: that leaves the recorded commit and release date stale.
The web release leaves the upload watcher unchanged. Database input changes
require a separate reviewed procedure; the review flag cannot bypass that check.
See the Solution Deploy repository's `docs/Deployment.md` for the full procedure.

GitHub CI runs tests, lint and builds on every push.

## Uptime monitoring

`.github/workflows/uptime.yml` runs three times a day. It requests `/api/health`
on the public hostname and passes only when Cloudflare Access answers with its
sign-in redirect, so it catches a broken Access application, DNS record or
tunnel route. The host watchdog checks `/api/ready`, including PostgreSQL, on
the protected origin.

```powershell
gh workflow run uptime.yml                          # probe production
gh workflow run uptime.yml -f base_url=https://...  # probe something else
```

Runs started with `base_url` log `manual override` as their target, so a
deliberate test of the check is never mistaken for a real outage.

## Database-change policy

Schema changes go through reviewed files in `deploy/postgresql`, applied by the
migration identity before a release. `reprocess_events.py`,
`backfill_export_xml.py`, `enrich_from_strava.py` and `remove_excluded_workouts.py`
write to the live database. Get an independent model review before running any
of them, or any other change, against `fit_track`. The test suite uses in-memory
SQLite and touches nothing real.

## Documentation

- [Architecture](docs/architecture.md)
- [Data pipeline & Health Auto Export setup](docs/data-pipeline.md)
- [Splits algorithm](docs/splits-algorithm.md)
- [GPS outlier filter](docs/gps-filter.md)
- [API reference](docs/api.md)
- [Database schema](docs/schema.md)
- [Testing](docs/testing.md)

## Tooltips

`frontend/src/siteSettings.ts` sets `SHOW_TOOLTIPS` to `false` by default.
Chart tooltips remain enabled. Set it to `true` and redeploy to show control
hints. Control descriptions remain available to screen readers when hints are off.

## Workout data points

Full workout points load in the background when a workout opens or refreshes.
The point editor reuses those points without a second request when opened.
After a save, points refresh in the background before the editor shows them again.
Page navigation and Save share the bottom row, with Save at the right. The
top-right X closes the editor and discards unsaved changes; Escape and outside
clicks preserve unsaved edits.

## Theme preferences

Dashboard and Workouts keep their views mounted when switching tabs. Workouts retains filters
and loaded rows while checking for fresh data on return. Content enters over 160ms, separately
from the navigation selection slide; reduced-motion disables both animations. Scrollbar space
is reserved so switching between short and long pages doesn't move the header.

The header uses compact icon buttons for Refresh, Pull Strava data and Appearance.
Its clock shows the latest underlying data import time, not the page refresh time.
Header controls have accessible labels without hover tooltips. The timestamp's accessible
label includes its full local date and relative age.
Successful Strava pull messages disappear after 5 seconds. Running status and errors remain
visible until the pull finishes or another attempt replaces the error.
Appearance opens a themed Light / Midnight / System segmented control, with Midnight as the default.
System follows OS changes live. Arrow keys, Home and End select a theme; Escape closes the popover.
Pressing Appearance again also closes the popover, including on touch devices.
The `fittrack_theme` storage key accepts `system`, `light` and `midnight`; legacy `dark` values migrate to Midnight.
