# Database schema

Production runs on PostgreSQL database `fit_track` on jimbrownhome1, with every
table in the standard `public` schema (`DB_SCHEMA=public`). The DDL is
`deploy/postgresql/001_initial.sql`. The retired Azure SQL deployment kept these
tables in the `fit` schema of the WebPortfolio database, which is why the
headings below still say `public.`. Defined as SQLAlchemy models in
`backend/app/models.py`.

## `public.api_tokens`
Bearer tokens for the API. Only the hash is stored.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | int PK | |
| `name` | nvarchar(100) | label |
| `token_hash` | char(64) unique | SHA-256 of the raw token |
| `scope` | varchar(20) | `all` \| `ingest` \| `read` |
| `disabled` | bit | |
| `created_utc`, `last_used_utc` | datetime2 | |

## `public.raw_ingest_events`
Raw payloads, stored before normalization so parsing can be re-run.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK | |
| `source` | varchar(50) | `health_auto_export` or `strava` |
| `received_utc`, `processed_utc` | datetime2 | |
| `payload_hash` | char(64) unique | payload hash for Health; source- and import-version-prefixed summary hash for Strava |
| `payload_json` | nvarchar(max) | original body |
| `status` | varchar(20) | `received` \| `processed` |
| `error` | nvarchar(max) | |

## `public.workouts`
One row per workout. `uuid` is the Apple workout id or `strava:<activity_id>`
(idempotency key).

| Column | Type | Notes |
| --- | --- | --- |
| `uuid` | nvarchar(80) PK | Apple UUID, deterministic uuid5 fallback, or `strava:<activity_id>` |
| `workout_type` | nvarchar(60) | friendly name |
| `source_name`, `device_name` | nvarchar(120) | |
| `start_utc`, `end_utc` | datetime2 | canonical UTC |
| `tz_offset_minutes` | int | original local offset |
| `local_date` | char(10) | `YYYY-MM-DD` local calendar day |
| `duration_sec`, `distance_m`, `active_energy_kcal` | float | |
| `avg_hr`, `max_hr`, `min_hr` | float | |
| `elevation_gain_m` | float, null | Strava `total_elevation_gain`; null for Apple workouts (migration `002_elevation.sql`) |
| `point_exclusions` | JSON array | Reversible per-workout timestamp exclusions (migration `003_point_exclusions.sql`); original samples remain unchanged |
| `average_watts`, `average_cadence` | float, null | Strava `average_watts` and `average_cadence` (rpm); null for Apple workouts (migration `004_power_cadence_weight.sql`) |
| `watts_per_kg` | float, null | `average_watts` / `athlete_profile.weight_kg`, set once and never recalculated (migration 004) |
| `has_route` | bit | |
| `created_utc`, `updated_utc` | datetime2 | |

Indexes: `start_utc`; `(workout_type, local_date)`.

> **Indexing decision (review P7):** a `(workout_type, start_utc)` composite index
> was considered to serve the filtered-and-sorted list query
> (`WHERE workout_type = ? ORDER BY start_utc DESC`) without a sort. It was
> **deliberately not added**: the UI never sends a `workout_type` filter (the
> Workouts page calls the list endpoint unfiltered), this is a single-user app
> with a small `workouts` table, and adding it would require a live-DB migration
> (plus the mandatory Gemini review for DB changes) for negligible gain. Revisit
> only if a common filtered-list workload with a measured sort cost emerges.

## `public.workout_route_points`
GPS track. FK → `workouts.uuid` (cascade). Rebuilt on re-ingest.

`id` bigint PK · `workout_uuid` · `seq` · `ts_utc` · `lat` · `lon` ·
`elevation_m` · `speed_mps`. Index `(workout_uuid, seq)`. `elevation_m` is the
Apple route `altitude` or the Strava `altitude` stream; non-finite values are stored as null.

## `public.workout_samples`
Interval samples (currently `heart_rate`) tied to a workout.

`id` bigint PK · `workout_uuid` · `metric_type` · `start_utc` · `end_utc` ·
`value` · `unit`. Index `(workout_uuid, metric_type, start_utc)`.

## `public.workout_splits`
Computed per-unit splits (stored for both `mi` and `km`).

`id` bigint PK · `workout_uuid` · `unit_system` (`mi`\|`km`) · `split_index` ·
`distance_m` · `duration_sec` · `pace_sec_per_unit` · `avg_hr` · `elevation_gain_m`
(climbing only, from route elevation; null without elevation) · `source`
(`gps`\|`sample`). Unique `(workout_uuid, unit_system, split_index)`.

## `public.athlete_profile`
Single row (`id = 1`) with the weight used for new W/kg values (migration 004,
seeded with 84.2). `weight_kg` float, checked `0 < weight_kg < 400` ·
`updated_utc`. The runtime role has SELECT/INSERT/UPDATE. Read and changed through
`GET`/`PUT /api/profile/weight`.

## `public.daily_metrics`
Per-day aggregate metrics (steps, resting HR, VO₂ max, …).

`id` bigint PK · `local_date` · `metric_type` · `value` · `unit` ·
`source_name` · `updated_utc`. Unique `(local_date, metric_type, source_name)`;
index `(metric_type, local_date)`.

## Design notes

Types follow a Gemini pre-flight review of the DDL:

- Timestamps use **DATETIME2**; text that can hold non-ASCII (workout/source/
  device names, token labels) uses **NVARCHAR**; raw JSON payloads use
  **NVARCHAR(max)** (never the deprecated NTEXT). On SQLite (tests) these fall
  back to the plain generic types via SQLAlchemy variants.
- **Deferred** (nice-to-have, low benefit at personal scale): storing
  `local_date` as native `DATE` (kept `VARCHAR(10)` ISO `YYYY-MM-DD` —
  sorts/groups lexicographically and avoids string<->date churn across the
  parser, schemas and routers), and shrinking `workouts.uuid` below
  `VARCHAR(80)` (kept wide to avoid truncating non-standard source ids).
