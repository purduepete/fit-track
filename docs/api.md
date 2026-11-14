# API reference

Base URL: the Container App URL in production, or `http://localhost:8000` in
dev. Interactive docs: `GET /docs` (Swagger) and `/redoc`.

Auth: all endpoints except `/api/health` require `Authorization: Bearer <token>`.
Tokens are scoped `ingest`, `read`, or `all` (see `scripts/token_admin.py`).

## `GET /api/health`

Unauthenticated liveness probe. → `{"status": "ok"}`

## `POST /api/strava/pull`

Pulls Zwift rides immediately using the saved Strava authorization and fixed
import boundary. No body. Requires `X-FitTrack-Sync: 1` and either the configured
Cloudflare/Tailscale gateway or an `ingest`/`all` bearer token.

Response: `{"workouts": 1}` (inserted or updated rides; zero means up to date).
The request waits for the pull to finish. Concurrent manual or automatic pulls
return `409`. An unconfigured connection returns `503`; Strava authorization,
rate-limit and network failures return `502` with a safe `detail` message.
Previously committed rides remain imported if a later ride fails.

## `GET /api/profile/weight` / `PUT /api/profile/weight`

`GET` (read access) → `{"weight_kg": 84.2}` (`null` before one is saved).
`PUT` needs control access plus `X-FitTrack-Edit: 1`, body `{"weight_kg": 85.0}`,
with `0 < weight_kg < 400`. The new weight applies only to rides that do not yet
have a W/kg; stored values never change.

Workout list and detail summaries include `average_watts`, `average_cadence` and
`watts_per_kg` (null when absent).

## `POST /api/ingest/health-auto-export` _(ingest scope)_

Body: a raw Health Auto Export JSON payload (`{"data": {...}}`). The raw body is
stored and deduplicated by SHA-256 hash; re-posting an identical payload
short-circuits. Concurrent posts of the same payload are safe: if two requests
race the duplicate check, the loser catches the unique-hash violation and returns
`{ "status": "ok", "duplicate": true }` instead of erroring.

Payloads larger than `MAX_INGEST_BYTES` (default 64 MiB, see `config.py`) are
rejected with `413 Request Entity Too Large` before parsing.

Response:

```json
{
  "status": "ok",
  "duplicate": false,
  "workouts": 1,
  "daily_metrics": 0,
  "splits": 6
}
```

## `GET /api/workouts` _(read scope)_

Query: `limit` (≤500, default 50), `offset`, `workout_type`, `date_from`,
`date_to` (inclusive local `YYYY-MM-DD` bounds), `sort` (`date`, `duration`,
`distance`, `pace`, `kcal`, `hr`, `maxhr`, `power`, `wkg`, `cadence` or `elev`;
default `date`) and `order` (`asc` or `desc`;
default `desc`). Pace sorts by stored duration ÷ distance. Workouts missing the
sorted value come last in either direction, and newest first breaks ties.
Returns a page of workout summaries plus the total matching count for pagination:

```json
{
  "total": 137,
  "items": [
    {
      "uuid": "…",
      "workout_type": "Outdoor Walk",
      "local_date": "2026-07-05",
      "start_utc": "2026-07-05T18:39:13",
      "duration_sec": 1853.6,
      "distance_m": 3705.0,
      "active_energy_kcal": 286.6,
      "avg_hr": 117.8,
      "max_hr": 143.0,
      "elevation_gain_m": null,
      "has_route": true
    }
  ]
}
```

## `GET /api/workouts/types` _(read scope)_

Distinct `workout_type` values present in the data (sorted), for the filter
dropdown. → `["Outdoor Run", "Outdoor Walk", …]`

## `GET /api/workouts/{uuid}` _(read scope)_

Query: `unit` = `mi` (default) or `km`; `full` = `true` for the full-resolution
series (default `false`).
Returns the summary plus:

- `splits[]` — `{split_index, distance_m, duration_sec, pace_sec_per_unit, avg_hr, elevation_gain_m, source}`
- `route[]` — `{seq, lat, lon, ts_utc, elevation_m}` (`elevation_m` may be null)
- `elevation_series[]` — `{ts_utc, elevation_m}`
- `hr_series[]` — `{ts_utc, bpm}`
- `point_exclusions[]` — `{ts_utc, matched}`. An unmatched marker can still be
  restored if its source timestamp has disappeared.
- `data_points[]` — on `full=true`, available timestamps and their stored route
  count, elevation, speed, heart-rate and source distance measurements, plus
  `excluded`. Distance is cumulative for Strava and an increment for Health
  Auto Export. This list includes excluded measurements for restoration.
- `route_total`, `hr_total` — included point counts before any downsampling
- `route_downsampled`, `hr_downsampled` — `true` when the returned series was
  reduced to the default caps (`MAX_ROUTE_POINTS` / `MAX_HR_POINTS`, 500 each)
- `prev_uuid`, `next_uuid` — adjacent workouts by start time for prev/next
  navigation (`prev` = next-older, `next` = next-newer); `null` at the ends

By default long GPS workouts are **downsampled** (deterministically, endpoints
preserved) to keep responses and client rendering bounded; pass `full=true` to
retrieve every point. `404` if the workout does not exist.

The map and charts use automatic sampling after excluded timestamps are removed.
The point editor opens with **Manage points** beside the workout title and
requests the full data-point list. Excluding a timestamp applies to every route
position and measurement at that time, including duplicates.
Stored source data is not deleted or changed.
Exclusions are saved in the database on the workout, shared by every browser and
device. Other open views receive the saved state when refreshed. The point
editor is a modal: checked points are used, and unchecking a point excludes its
entire timestamp. Checkbox edits remain drafts until **Save** applies them
together and closes the modal. **Cancel** discards the draft. Escape and outside
clicks do not close the editor while changes are unsaved.

Affected heart-rate summaries use the arithmetic mean, minimum and maximum of
the remaining heart-rate samples. Affected elevation gain uses positive changes
in the remaining raw elevations, rather than Strava's smoothed total. Affected
distance uses the remaining cumulative Strava distances, Health distance
increments, or the remaining GPS route when GPS is the split source. Splits
are recalculated from the remaining points. Duration and calories remain the
source totals. The same adjusted summaries appear in the workout list.

If original distance samples are missing after an exclusion, `distance_m` is
null, splits are omitted, and `point_exclusion_warning` explains the problem.
The exclusion can still be restored.

## `POST /api/workouts/{uuid}/point-exclusions`

Requires `X-FitTrack-Edit: 1` and either the configured Cloudflare/Tailscale
gateway or an `ingest`/`all` bearer token.

Body: `{"ts_utc": "2026-10-24T00:05:00"}` using a timestamp from the full
data-point list. The response is the marker `{ts_utc}`. The marker survives
re-imports while the timestamp remains in the workout, even when its values
change. `404` means the point or workout was not found. `409` means the point
is already excluded or the original samples needed for recalculation are
unavailable.

## `POST /api/workouts/{uuid}/point-exclusions/restore`

Uses the same authorization and `X-FitTrack-Edit` header. Send the exclusion
marker from the workout detail, without its `matched` field. The response is
`{"status": "restored"}`; `404` means the workout or marker was not found.

## `POST /api/workouts/{uuid}/point-exclusions/batch`

Uses the same authorization and `X-FitTrack-Edit` header. The point editor
sends only changed timestamps:

```json
{
  "exclude": [{ "ts_utc": "2026-10-24T00:05:00" }],
  "restore": [{ "ts_utc": "2026-10-24T00:06:00" }]
}
```

All changes are validated before one transaction commits them. Other saved
timestamps remain unchanged, including changes made on another device.
Repeating a saved request is safe: already-excluded points and already-restored
markers need no further change. A missing source marker can still be restored.
The response is `{"status": "saved"}`. `422` means the same timestamp appears in
both lists, `404` means the workout or a new exclusion point is missing, and
`409` means new exclusions cannot be recalculated from available source data.
On failure, none of the requested changes are saved.

## `GET /api/dashboard` _(read scope)_

7-day rollup and trend series. `weekly_workouts`/`weekly_minutes` cover the last
7 days; `resting_hr_trend` covers the last 90 days; `vo2max_trend` covers the last
365 days; `sleep_trend` covers the last 30 days. `minutes_7d` and each
`weekly_minutes` value are totals in minutes, rounded to the nearest second after
adding the underlying durations. `vo2max_band` interprets the latest
VO2 max against the athlete's age/sex (Cooper Institute categories) when
`ATHLETE_BIRTH_DATE`/`ATHLETE_SEX` are configured, otherwise it is `null`.
`latest_sleep_hours` is the most recent night's asleep hours (parsed from HAE
`sleep_analysis`, attributed to the wake day); `sleep_band` rates it against a
7-9 h adult target (Low/Fair/Good/Excellent), or `null` when there is no sleep data.
`steps_trend` covers the last 30 days. HAE exports `step_count` as many intraday
points, so each day's value is the **sum** of all points for that day, taken as a
single device-agnostic total (HAE already de-duplicates overlapping devices
within each interval point) and rounded to whole steps; `latest_steps` is the
value of the most recent day with data and `latest_steps_date` is that day (both
`null` when there is no step data). `steps_trend` is padded to a contiguous
30-day window (newest last); days with no data appear with `value: null` (a gap).
`steps_avg7_trend` is a stepped **7-day block average** anchored to today: the
most recent 7 days form one block, the prior 7 another, and so on. Every day in a
block reports that block's mean (over the days that have data, rounded), so the
chart draws a flat line per week that steps at each boundary. `workout_days` lists
the distinct `local_date`s within the window that have at least one logged
workout, so the steps chart can flag them. In the UI, tapping a flagged (green)
steps bar deep-links to `GET /api/workouts?date_from=<day>&date_to=<day>` (the
Workouts page at `#/workouts?date=<day>`), scoped to that single day.

```json
{
  "workouts_7d": 3,
  "minutes_7d": 92.4,
  "active_kcal_7d": 810,
  "latest_resting_hr": 55,
  "latest_vo2max": 38.8,
  "vo2max_band": {
    "category": "Good",
    "category_index": 3,
    "range_low": 35.8,
    "range_high": 41.0,
    "next_category": "Excellent",
    "next_at": 41.0,
    "age": 55,
    "sex": "male"
  },
  "latest_sleep_hours": 7.5,
  "sleep_band": {
    "category": "Excellent",
    "category_index": 3,
    "target_low": 7.0,
    "target_high": 9.0
  },
  "latest_steps": 8200,
  "latest_steps_date": "2026-07-05",
  "weekly_workouts": [{ "local_date": "2026-07-05", "value": 1 }],
  "weekly_minutes": [{ "local_date": "2026-07-05", "value": 30.9 }],
  "resting_hr_trend": [{ "local_date": "2026-07-05", "value": 55 }],
  "vo2max_trend": [{ "local_date": "2026-07-05", "value": 38.8 }],
  "sleep_trend": [{ "local_date": "2026-07-05", "value": 7.5 }],
  "steps_trend": [{ "local_date": "2026-07-05", "value": 8200 }],
  "steps_avg7_trend": [{ "local_date": "2026-07-05", "value": 7600 }],
  "workout_days": ["2026-07-05"]
}
```

> Timestamps returned by the API are naive UTC. The frontend converts them to
> the browser's local time zone for display.
