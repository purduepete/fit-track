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
| `auth.py` | Bearer-token validation against SHA-256 hashes; `require_ingest` / `require_read`. |
| `normalize.py` | Pure parsing of Health Auto Export JSON → dataclasses; idempotent persistence + split computation. |
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

### Granting the deployed app access (one-time)

When deploying with a managed identity, connect **as the AAD admin** and create a
contained database user for the Container App's identity, then grant it access to
the `fit` schema:

```sql
CREATE USER [fittrack-api] FROM EXTERNAL PROVIDER;   -- the managed identity name
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::fit TO [fittrack-api];
```

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
  Azure SQL server is reused (no new database resource).
