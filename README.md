# fittrack

Track your Apple Watch / iPhone **workouts** on Windows — export daily from
Health, load into Azure SQL, and browse a web dashboard with **mileage splits**,
a **route map**, and **heart-rate** charts.

No Mac required. Route, HR and distance data all come from the JSON that
[Health Auto Export](https://apps.apple.com/app/health-auto-export/id1115567069)
produces, so a single daily export drives everything.

```
Apple Watch ─▶ Apple Health ─▶ Health Auto Export (iOS)
     ─▶ dated .zip into a synced folder (iCloud / Dropbox / OneDrive)
     ─▶ upload_folder.py  ──POST(token)──▶  FastAPI /api/ingest
     ─▶ Azure SQL (WebPortfolio DB, `fit` schema)
     ─▶ React + Recharts + Leaflet dashboard
```

## Features

- **Daily pickup** — drop the Health Auto Export `.zip` in `upload/`; the
  watcher extracts the JSON, POSTs it to the API, and archives the file.
- **Mileage splits** — per-mile / per-km pace + avg HR, computed from the GPS
  route (with a distance-sample fallback for indoor workouts). mi/km toggle.
- **Route map** — the GPS track drawn on OpenStreetMap (no API key).
- **Heart-rate chart** — HR over the course of the workout.
- **Dashboard** — 7-day workout count / minutes / active energy, resting-HR and
  VO₂ max trends.
- **Idempotent ingest** — keyed on the Apple workout UUID; re-ingesting the same
  export never duplicates. Raw payloads are stored for safe re-processing.
- **Simple token auth** — bearer tokens you generate locally; only the hash is
  stored.

## Repository layout

| Path | Purpose |
| --- | --- |
| `backend/app/` | FastAPI app: config, db, models, auth, normalizer, geo/splits, routers |
| `backend/scripts/` | `init_db`, `token_admin` / `New-IngestToken.ps1`, `upload_folder` / `Watch-Upload.ps1`, `backfill_export_xml` |
| `backend/tests/` | pytest suite (geo, normalizer, persistence, API) |
| `frontend/` | React + Vite + TS dashboard (Recharts, react-leaflet) |
| `infra/main.bicep` | Azure Container Apps (Consumption, scale-to-zero) |
| `Dockerfile` | Builds the SPA and serves it from FastAPI (incl. ODBC Driver 18) |
| `docs/` | Architecture, data pipeline, splits algorithm, API, schema, testing |

## Quickstart (local)

Prerequisites: Python 3.12+, Node 20+, the
[ODBC Driver 18 for SQL Server](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server),
and access to the WebPortfolio Azure SQL server.

```powershell
# 1. Backend
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-dev.txt
Copy-Item .env.example .env   # then fill in DB_PASSWORD

# 2. Create the `fit` schema + tables  (DB-altering — see the warning below)
.\.venv\Scripts\python.exe -m scripts.init_db

# 3. Create tokens (shown once)
.\scripts\New-IngestToken.ps1 -Name iphone-hae  -Scope ingest
.\scripts\New-IngestToken.ps1 -Name dashboard   -Scope read

# 4. Run the API
.\.venv\Scripts\uvicorn.exe app.main:app --reload
```

```powershell
# 5. Frontend (separate terminal) — proxies /api to :8000
cd frontend
npm install
npm run dev        # http://localhost:5173  (paste the read token)
```

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
   FITTRACK_API_URL=https://<your-container-app>
   FITTRACK_TOKEN=<ingest token>
   # Optional: watch a synced cloud folder instead of fittrack/upload, and keep
   # processed files tidied in a subfolder that stays in the cloud folder.
   FITTRACK_WATCH_DIR=G:\My Drive\fittrack
   FITTRACK_ARCHIVE_NAME=processed
   ```

   Or run the client directly (equivalent):

   ```powershell
   $env:FITTRACK_API_URL = "https://<your-container-app>"   # or http://localhost:8000
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

## Deploy (Azure)

Cheapest path is **Azure Container Apps** on the Consumption plan
(`minReplicas: 0` → scales to zero when idle). The container is deployed into a
**dedicated new resource group**; the Azure SQL server is reused cross-RG.

```powershell
az group create -n fittrack-rg -l westus2
# push image + deploy via the manual GitHub Actions "Deploy" workflow, or:
az deployment group create -g fittrack-rg -f infra/main.bicep `
   -p containerImage=ghcr.io/<owner>/fittrack:latest dbPassword=<secret>
```

## ⚠️ Database-change policy

`init_db.py` and `backfill_export_xml.py` **alter the shared WebPortfolio
database**. Per project policy, get a **Gemini second opinion** before running
either against the live DB. The test suite uses in-memory SQLite and touches
nothing real.

## Documentation

- [Architecture](docs/architecture.md)
- [Data pipeline & Health Auto Export setup](docs/data-pipeline.md)
- [Splits algorithm](docs/splits-algorithm.md)
- [API reference](docs/api.md)
- [Database schema](docs/schema.md)
- [Testing](docs/testing.md)
