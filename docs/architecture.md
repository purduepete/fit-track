# Architecture

fittrack is a small three-tier app: an iOS export feeds a Python API that
persists to Azure SQL, and a React SPA reads it back.

```
┌─────────────┐   embedded route + HR + distance samples
│ Apple Watch │──────────────────────────┐
└─────────────┘                           ▼
      │ syncs                    ┌───────────────────┐
      ▼                          │ Health Auto Export │  (iOS app)
┌─────────────┐                  └───────────────────┘
│ Apple Health│                           │ daily JSON (.zip)
└─────────────┘                           ▼
                        synced folder (iCloud / Dropbox / OneDrive)
                                          │
                                          ▼
                            scripts/upload_folder.py  (Windows)
                                          │ POST + Bearer token
                                          ▼
      ┌───────────────────────────────────────────────────┐
      │ FastAPI  (Azure Container App, scale-to-zero)       │
      │  /api/ingest  → raw store → normalize → upsert      │
      │  /api/workouts, /api/dashboard  (read, token-gated) │
      │  /            → static React SPA                    │
      └───────────────────────────────────────────────────┘
                                          │ SQLAlchemy + pyodbc
                                          ▼
              Azure SQL — WebPortfolio DB, `fit` schema (reused server)
```

## Backend modules (`backend/app`)

| Module | Responsibility |
| --- | --- |
| `config.py` | Env-driven settings; builds the SQLAlchemy/pyodbc URL. |
| `db.py` | Engine + session factory + `get_db` dependency. |
| `models.py` | ORM tables in the `fit` schema (schema is configurable so tests use schemaless SQLite). |
| `auth.py` | Bearer-token validation against SHA-256 hashes; `require_ingest` / `require_read`. Refreshes `last_used_utc` at most hourly (debounced) so read GETs don't commit on every request. |
| `normalize.py` | Pure parsing of Health Auto Export JSON → dataclasses; idempotent persistence + split computation. Exposes `synth_workout_uuid`, shared with the XML backfill so both import paths mint identical ids. |
| `geo.py` | Haversine + split computation from GPS route or distance samples (pure, heavily tested). |
| `routers/` | `ingest`, `workouts`, `dashboard` endpoints. |
| `main.py` | App wiring; serves the built SPA in production. |

## Database authentication

Two modes, selected by `DB_AUTH` (see `backend/.env.example`):

- **`aad` (recommended)** — Azure AD tokens via `DefaultAzureCredential`. Locally
  this uses your `az login`; in Azure it uses the Container App's **managed
  identity**. No password is stored or transmitted. `db.py` fetches a token and
  passes it to ODBC via the access-token attribute.
- **`sql`** — classic username/password over the SQLAlchemy URL.

`aad` is preferred because the reused server's SQL admin password is managed
elsewhere (webportfolio) and may rotate; token auth avoids depending on it.
**The deployed Container App uses `DB_AUTH=aad` with a **user-assigned** managed
identity (`fittrack-identity`)** provisioned by `infra/main.bicep` — no password is
passed at deploy time. `AZURE_CLIENT_ID` is set to that identity's client id so
`DefaultAzureCredential` selects it. The private container image is pulled from
GitHub Container Registry (`ghcr.io`) using a PAT (`read:packages`) stored as a
Container App secret — the managed identity is used for SQL only. The Bicep
`identityName` / `identityClientId` / `identityPrincipalId` outputs surface it.

### Athlete profile env (deploy-time params)

VO₂ max interpretation needs the athlete's age + sex. `infra/main.bicep` exposes
`athleteBirthDate` / `athleteSex` params (→ `ATHLETE_BIRTH_DATE` / `ATHLETE_SEX`
env), **defaulting to the athlete's profile** (`1970-09-20` / `male`). So every
deploy — manual or via Actions — keeps the profile set and VO₂ max
interpretation working, even when the params aren't supplied. Override them
explicitly only to change the profile; a blank birth date is still tolerated
(normalized to `None` in `backend/app/config.py`), disabling interpretation
without crash-looping the container — see the
[README deploy section](../README.md#deploy-azure).

### Granting the deployed app access (one-time)

After the first deploy, connect **as the AAD admin** and create a contained
database user for the Container App's identity (`fittrack-identity`), then grant it
DML on the `fit` schema. **Per policy this is a live-DB change — get a Gemini
second opinion before running it.** The statement below is idempotent (safe to
re-run):

```sql
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'fittrack-identity')
BEGIN
    EXEC('CREATE USER [fittrack-identity] FROM EXTERNAL PROVIDER;');  -- the user-assigned MI name
END
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::fit TO [fittrack-identity];
```

Rollback: `DROP USER [fittrack-identity];` (removes the user and its grants).

## Design decisions

- **Parsing is pure and DB-free** so it can be unit-tested in isolation; only
  `persist_payload` touches the database.
- **Raw payloads are stored first** (`fit.raw_ingest_events`, deduped by hash)
  so a parser fix can be re-applied without re-exporting from the phone.
- **Idempotency** is keyed on the Apple workout UUID; child rows (route, samples,
  splits) are deleted and rebuilt on re-ingest.
- **Timezone**: workout timestamps carry an offset; we store canonical UTC plus
  `tz_offset_minutes`, and derive `local_date` from the local calendar day so
  day-grouping matches what you saw on the watch.
- **Cost**: Container Apps Consumption with `minReplicas: 0` idles at ~zero; the
  Azure SQL server and Log Analytics workspace are reused (no new database or
  workspace resource). The app image lives in a **private GitHub Container
  Registry package** (`ghcr.io/purduepete/fittrack`), which is free on the GitHub
  free tier — so there is no always-on registry cost.
