# Architecture

Fit Track is a small three-tier app: Apple Health exports and Zwift rides from
Strava feed a Python API that persists to PostgreSQL, and a React SPA reads it back.

```
┌─────────────┐   embedded route + HR + distance samples
│ Apple Watch │──────────────────────────┐
└─────────────┘                           ▼
      │ syncs                    ┌───────────────────┐
      ▼                          │ Health Auto Export │  (iOS app)
┌─────────────┐                  └───────────────────┘
│ Apple Health│                           │ daily JSON (.zip)
└─────────────┘                           ▼
                              Google Drive (G:\My Drive\fittrack)
                                          │
                                          ▼
                     scripts/upload_folder.py  (jimbrownhome1, signed-in session)
                                          │ POST + Bearer token
                                          ▼
      ┌─────────────────────────────────────────────────────┐
      │ FastAPI on jimbrownhome1 (127.0.0.1:8791)           │
      │  /api/ingest  → raw store → normalize → upsert      │
      │  /api/workouts, /api/dashboard  (read)              │
      │  Strava sync thread (Zwift virtual rides)           │
      │  /            → static React SPA                    │
      └─────────────────────────────────────────────────────┘
                                          │ SQLAlchemy + psycopg
                                          ▼
                       PostgreSQL fit_track, `public` schema
```

Public access goes through Cloudflare Access at `fit-track.jimlertech.com`; the
private path is Tailscale on port 8791. See [deployment](deployment.md).

## Backend modules (`backend/app`)

| Module         | Responsibility                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.py`    | Env-driven settings, including `DATABASE_URL`.                                                                                                                                                                    |
| `db.py`        | Engine + session factory + `get_db` dependency. Without `DATABASE_URL` sessions are unbound and readiness fails.                                                                                                  |
| `models.py`    | ORM tables (schema is configurable so tests use schemaless SQLite).                                                                                                                                               |
| `auth.py`      | Bearer-token validation against SHA-256 hashes; `require_ingest` / `require_read` / `require_control`, with gateway read access behind Cloudflare Access and Tailscale. Refreshes `last_used_utc` at most hourly. |
| `normalize.py` | Pure parsing of Health Auto Export JSON → dataclasses; idempotent persistence + split computation. Exposes `synth_workout_uuid`, shared with the XML backfill so both import paths mint identical ids.            |
| `strava.py`    | Strava OAuth token handling and the Zwift ride importer.                                                                                                                                                          |
| `geo.py`       | Haversine + split computation from GPS route or distance samples (pure, heavily tested).                                                                                                                          |
| `routers/`     | `ingest`, `workouts`, `dashboard`, `strava`, `profile` endpoints.                                                                                                                                                 |
| `main.py`      | App wiring; serves the built SPA in production.                                                                                                                                                                   |

## Database access

The runtime connects as `sd_fittrack_runtime` with the `DATABASE_URL` from the
protected `app.env`. It has table DML only; schema changes are reviewed SQL files
in `deploy/postgresql`, applied with the migration identity and `SET ROLE
sd_fittrack_owner` before the release that needs them. See [schema](schema.md).

VO₂ max interpretation needs the athlete's age + sex, from `ATHLETE_BIRTH_DATE`
and `ATHLETE_SEX` in `app.env`. A blank birth date disables the interpretation
instead of failing startup.

## Design decisions

- **Parsing is pure and DB-free** so it can be unit-tested in isolation; only
  `persist_payload` touches the database.
- **Raw payloads are stored first** (`raw_ingest_events`, deduped by hash)
  so a parser fix can be re-applied without re-exporting from the phone.
- **Idempotency** is keyed on the Apple workout UUID or `strava:<id>`; child rows
  (route, samples, splits) are deleted and rebuilt on re-ingest.
- **Timezone**: workout timestamps carry an offset; we store canonical UTC plus
  `tz_offset_minutes`, and derive `local_date` from the local calendar day so
  day-grouping matches what you saw on the watch.
