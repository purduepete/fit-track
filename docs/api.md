# API reference

Base URL: the Container App URL in production, or `http://localhost:8000` in
dev. Interactive docs: `GET /docs` (Swagger) and `/redoc`.

Auth: all endpoints except `/api/health` require `Authorization: Bearer <token>`.
Tokens are scoped `ingest`, `read`, or `all` (see `scripts/token_admin.py`).

## `GET /api/health`
Unauthenticated liveness probe. → `{"status": "ok"}`

## `POST /api/ingest/health-auto-export`  *(ingest scope)*
Body: a raw Health Auto Export JSON payload (`{"data": {...}}`). The raw body is
stored and deduplicated by SHA-256 hash; re-posting an identical payload
short-circuits.

Response:
```json
{ "status": "ok", "duplicate": false, "workouts": 1, "daily_metrics": 0, "splits": 6 }
```

## `GET /api/workouts`  *(read scope)*
Query: `limit` (≤500, default 100), `offset`, `workout_type`.
Returns an array of workout summaries (newest first):
```json
[{ "uuid": "…", "workout_type": "Outdoor Walk", "local_date": "2026-07-05",
   "start_utc": "2026-07-05T18:39:13", "duration_sec": 1853.6,
   "distance_m": 3705.0, "active_energy_kcal": 286.6,
   "avg_hr": 117.8, "max_hr": 143.0, "has_route": true }]
```

## `GET /api/workouts/{uuid}`  *(read scope)*
Query: `unit` = `mi` (default) or `km`.
Returns the summary plus:
- `splits[]` — `{split_index, distance_m, duration_sec, pace_sec_per_unit, avg_hr, source}`
- `route[]` — `{seq, lat, lon, ts_utc}`
- `hr_series[]` — `{ts_utc, bpm}`

`404` if the workout does not exist.

## `GET /api/dashboard`  *(read scope)*
7-day rollup and trend series:
```json
{ "workouts_7d": 3, "minutes_7d": 92.4, "active_kcal_7d": 810,
  "latest_resting_hr": 55, "latest_vo2max": 42.1,
  "weekly_workouts": [{"local_date":"2026-07-05","value":1}],
  "weekly_minutes":  [{"local_date":"2026-07-05","value":30.9}],
  "resting_hr_trend":[{"local_date":"2026-07-05","value":55}] }
```

> Timestamps returned by the API are naive UTC. The frontend converts them to
> the browser's local time zone for display.
