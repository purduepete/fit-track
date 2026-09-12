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
- **Dashboard** — 7-day workout count / minutes / active energy, resting-HR,
  VO₂ max and sleep trends, plus a 30-day daily-steps chart with a 10k goal line,
  a stepped 7-day block-average line, and green bars on days with a logged
  workout (tap one to open that day on the Workouts page).
- **Idempotent ingest** — keyed on the Apple workout UUID; re-ingesting the same
  export never duplicates. Raw payloads are stored for safe re-processing.
- **Simple token auth** — bearer tokens you generate locally; only the hash is
  stored.

## Repository layout

| Path | Purpose |
| --- | --- |
| `backend/app/` | FastAPI app: config, db, models, auth, normalizer, geo/splits, routers |
| `backend/scripts/` | `init_db`, `check_config`, `token_admin` / `New-IngestToken.ps1`, `upload_folder` / `Watch-Upload.ps1`, `backfill_export_xml` |
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

## Setting up on another machine

Moving to a second machine needs no schema work — the `fit` schema already
exists, so **skip `scripts.init_db`** and run everything above except step 2.
Carry `backend/.env` and `backend/.env.local` over a secure channel (both are
gitignored) and re-mint a read token, since only the SHA-256 hash of a token is
stored and the raw value cannot be recovered.

When something doesn't connect, run the config doctor before anything else. It
prints no secret values:

```powershell
cd backend
.\.venv\Scripts\python.exe -m scripts.check_config
```

It reports where the env file is expected, whether it exists and parses, its
encoding, which `DB_*` process variables outrank it, the effective auth mode,
the installed ODBC drivers, whether an Azure AD token can be acquired, and who
the connection authenticates as.

### Two errors that name the wrong culprit

**`Login failed for user 'sqladmin'`** usually means the env file was never
applied, not that the password is wrong. Every field falls back to its default,
and the defaults are `DB_AUTH=sql` with an empty password against user
`sqladmin`. Check that `backend/.env` really is in `backend/`, that it is UTF-8
(a UTF-16 save parses to zero keys), and that Windows didn't save it as
`.env.txt`. Before `384ba60` this also happened whenever the process started
outside `backend/`, because `env_file` was a relative path.

**`403` from a dashboard endpoint** is a scope mismatch, not a bad token — an
invalid token returns `401`. The dashboard needs a `read`-scoped token, so a
`403` normally means the `ingest` token from `.env.local` was pasted instead.
Check with `python -m scripts.token_admin list`.

### Two healthy states that look like failures

**`Last Run Result` of `0x800710E0`** ("the operator or administrator has
refused the request") on the `FitTrack Upload Watcher` task is the design
working. The task is registered `MultipleInstances IgnoreNew` with a keep-alive
trigger every 10 minutes, so each repeat is refused while the watcher is alive
and only relaunches it if it died. Read the `Status` column instead: `Running`
plus recent `OK ...` lines in `backend/logs/upload-watcher.log` is healthy.
`Ready` with a stale log is the real failure.

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
(`minReplicas: 0` → scales to zero when idle). The app (`fittrack-api`) runs in
the **`jimbpersonal-rg`** resource group (**eastus2**) and pulls its image from a
**private GitHub Container Registry package** (`ghcr.io/purduepete/fittrack`,
free on the GitHub free tier — avoids the ACR Basic daily fee). A **user-assigned
managed identity** (`fittrack-identity`) is used for Azure SQL (`DB_AUTH=aad`, no
DB password); the private ghcr image is pulled with a PAT (`read:packages`) stored
as a Container App secret. The Azure SQL server is reused cross-RG (see
[architecture](docs/architecture.md)).

### Option A — GitHub Actions (manual trigger)

`.github/workflows/deploy.yml` is **`workflow_dispatch` only** (never on push,
because a deploy hits the shared WebPortfolio DB). Run it from the Actions tab
or `gh workflow run deploy.yml`. It requires:

| Kind | Name | Example |
| --- | --- | --- |
| secret | `AZURE_CREDENTIALS` | output of `az ad sp create-for-rbac --sdk-auth` |
| secret | `GHCR_PAT` | classic PAT with `read:packages` (Container App pulls the private image with it) |
| secret | `GHCR_PUSH_TOKEN` | classic PAT with `write:packages` (pushes the image from the runner) |
| variable | `FITTRACK_RG` | `jimbpersonal-rg` |
| variable | `ATHLETE_BIRTH_DATE` | `1970-09-20` (blank = disables VO₂ interpretation) |
| variable | `ATHLETE_SEX` | `male` \| `female` |

> ⚠️ If `AZURE_CREDENTIALS` is not set the workflow fails at the Azure login
> step — use Option B.

> 🔐 **The service principal needs RBAC, not just credentials.** `AZURE_CREDENTIALS`
> authenticating is not enough: the SP (`fittrack-gh-deploy`) must hold
> **Contributor on `jimbpersonal-rg`**, because the bicep creates a user-assigned
> identity, a managed environment and the container app there. Without it the
> deploy authenticates fine and then dies with
> `AuthorizationFailed ... Microsoft.Resources/deployments/validate/action`. It
> also needs **Log Analytics Contributor** on the reused workspace in
> `investmentportfolio` (cross-RG). Verify with:
>
> ```powershell
> az role assignment list --assignee <sp-object-id> --all -o table
> ```
>
> Note this scope grants the CI principal write access to everything else in
> `jimbpersonal-rg` (webbookmarksapi, func-worklog). This is a **known and
> accepted trade-off** for a personal resource group — do not change role
> assignments to "fix" it without asking first.

### Option B — local az CLI (what to run today)

```powershell
$tag = git rev-parse --short=7 HEAD
$image = "ghcr.io/purduepete/fittrack:$tag"

# Build + push to the private ghcr package (needs a PAT with write:packages):
docker build -t $image -t ghcr.io/purduepete/fittrack:latest .
$env:CR_PAT | docker login ghcr.io -u purduepete --password-stdin
docker push $image
docker push ghcr.io/purduepete/fittrack:latest

az deployment group create -g jimbpersonal-rg -f infra/main.bicep `
  -p containerImage=$image `
     registryServer=ghcr.io `
     registryUsername=purduepete `
     registryPassword=$env:CR_PAT
```

> ℹ️ **Athlete profile is baked into `infra/main.bicep` defaults**
> (`athleteBirthDate=1970-09-20`, `athleteSex=male`), so every deploy — manual or
> via Actions — keeps VO₂ max interpretation working without needing to pass the
> params. Override them explicitly only to change the profile. (A blank birth date
> is still tolerated and simply disables interpretation — see
> `backend/app/config.py`.)

> 🪟 The local build uses your Docker daemon (Docker Desktop) — no `az acr build`,
> so the old Windows cp1252 log-streaming crash no longer applies. Create the
> `CR_PAT` env var from a GitHub PAT with `write:packages` before pushing.

Confirm the new revision came up healthy (a bad env/config would crash-loop and
traffic would stay on the previous revision):

```powershell
az containerapp revision list -n fittrack-api -g jimbpersonal-rg `
  --query "[?properties.active].{rev:name,running:properties.runningState,health:properties.healthState,image:properties.template.containers[0].image}" -o table
```

### Troubleshooting: site hangs / won't load

The most common cause is an **expired ghcr PAT**. The Container App stores the
`read:packages` PAT as the **`registry-password`** secret (the name `infra/main.bicep`
assigns). Beware: `az containerapp registry set` writes to a *different*,
CLI-generated secret name (e.g. `ghcrio-purduepete`) and leaves the bicep one
orphaned — a later deploy then switches the reference back. So always read
`properties.configuration.registries[].passwordSecretRef` rather than assuming a
name. When that PAT expires the image pull fails and — because the app scales to
zero — there is no running replica left to serve traffic, so every request just
times out.

Diagnose (look for `ErrImagePull` / `403 Forbidden` from `ghcr.io/token`):

```powershell
az containerapp logs show -n fittrack-api -g jimbpersonal-rg --type system --tail 30
```

Fix by refreshing the stored credential with a current PAT, then restarting the
active revision so the backed-off replicas retry the pull:

```powershell
az containerapp registry set -n fittrack-api -g jimbpersonal-rg `
  --server ghcr.io --username purduepete --password $env:CR_PAT

az containerapp revision restart -n fittrack-api -g jimbpersonal-rg `
  --revision <active-revision>
```

Note: `az containerapp registry set` **does not create a new revision and does not
restart anything** — running replicas keep serving with the credential they
started with, and a node-cached image can hide a broken new credential until the
next cold start. So always follow a credential change with a revision restart,
both to recover crash-looping replicas and to *prove* the new secret can actually
pull. Remember to update the `GHCR_PAT` GitHub secret too, or the next Actions
deploy will re-store the expired value.

To confirm a stored credential really works (without printing it):

```powershell
$sec = az containerapp secret show -n fittrack-api -g jimbpersonal-rg `
  --secret-name registry-password --query value -o tsv
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("purduepete:$sec"))
$t = Invoke-RestMethod -Headers @{Authorization="Basic $b64"} `
  "https://ghcr.io/token?scope=repository%3Apurduepete%2Ffittrack%3Apull&service=ghcr.io"
Invoke-WebRequest -UseBasicParsing -Headers @{Authorization="Bearer $($t.token)"} `
  "https://ghcr.io/v2/purduepete/fittrack/manifests/<tag>" | % StatusCode   # expect 200
```

> ❗ **Managed identity cannot replace this PAT.** Container Apps' identity-based
> image pull is **Azure Container Registry only**; ghcr.io accepts only a
> username + PAT. So `fittrack-identity` handles Azure SQL auth, but the registry
> credential must stay a secret. Don't burn time trying to eliminate it.

The PAT currently in use is a **classic PAT with no expiration**, so this should
not recur on a timer — but it can still break if the token is revoked, regenerated,
or auto-removed by GitHub (classic PATs are revoked after **one year of disuse**).
Because the app scales to zero, such a break is **silent until someone opens the
page** — which is exactly how the 2026-08-03 outage went unnoticed.

### Uptime monitoring

`.github/workflows/uptime.yml` guards against that silence: it GETs `/api/health`
from a GitHub runner **three times a day** and fails the run (which emails you)
if the app doesn't return 200 after three tries.

It deliberately runs *outside* Azure. Because `minReplicas: 0`, **zero replicas is
the normal idle state**, so an Azure metric alert on replica count or restarts
cannot tell "idle" from "broken" — only a real HTTP request that forces a cold
start can. The retries exist because that cold start takes ~20s.

The frequency is deliberately low: every probe wakes the app, so checking every
few minutes would keep it permanently warm and negate the scale-to-zero saving
that justifies the Consumption plan. Run it on demand — or test the check itself
against a different host — with:

```powershell
gh workflow run uptime.yml                          # probe production
gh workflow run uptime.yml -f base_url=https://...  # probe something else
```

Runs started with `base_url` are labelled **MANUAL OVERRIDE — not production** in
the log and failure annotation, so a deliberate test of the check is never
mistaken for a real outage. Scheduled runs never set it: a red run whose log says
`Probing production` is genuine.

> 🔑 **The pull credential is scoped to `read:packages` — keep it that way.**
> During the 2026-08-03 recovery the app briefly held the local `CR_PAT`
> (`repo` + `write:packages`), which was then replaced by a dedicated read-only
> classic PAT and verified to pull. `CR_PAT` still needs `write:packages` for
> *pushing* images from your machine, so only the value stored **in the app**
> should be read-only. When rotating, don't paste `CR_PAT` back in.

## ⚠️ Database-change policy

`init_db.py` and `backfill_export_xml.py` **alter the shared WebPortfolio
database**. Per project policy, get a **Gemini second opinion** before running
either against the live DB. The test suite uses in-memory SQLite and touches
nothing real.

## Documentation

- [Architecture](docs/architecture.md)
- [Data pipeline & Health Auto Export setup](docs/data-pipeline.md)
- [Splits algorithm](docs/splits-algorithm.md)
- [GPS outlier filter](docs/gps-filter.md)
- [API reference](docs/api.md)
- [Database schema](docs/schema.md)
- [Testing](docs/testing.md)
