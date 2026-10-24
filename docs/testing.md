# Testing

fittrack is built with tests from the start. Parsing and split math are pure
functions with heavy unit coverage; the API is exercised against an in-memory
SQLite database so no live DB or network is required.

## Backend (pytest)

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest        # 28 tests
```

`tests/conftest.py` sets `DB_SCHEMA=""` and `DB_PASSWORD="test"` **before**
importing app modules, so models render schemaless on SQLite. API tests override
`get_db` with an in-memory `StaticPool` SQLite session.

| File                 | Covers                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_geo.py`        | haversine distance; GPS and sample split computation; interpolation across multiple boundaries; partial trailing split; monotonicity.                                                                                                                                    |
| `test_normalize.py`  | parsing real Health Auto Export field shapes; unit conversion; timezone → UTC + `local_date`; payload hashing; **synthetic uuid parity across the JSON and XML import paths** (shared `synth_workout_uuid`).                                                             |
| `test_persist.py`    | idempotent upsert (re-ingest replaces child rows, no duplicates); split persistence for both units; daily-metric uniqueness; **regression: duplicate null-source daily metrics dedupe to one row** (SQL Server allows only one NULL per UNIQUE index — SQLite does not). |
| `test_api.py`        | auth (401 without/with bad token, scope enforcement); `last_used_utc` debounce (no rewrite within window, refresh when stale); ingest + dedup; concurrent-duplicate ingest stays idempotent; workout list/detail; dashboard aggregates; `unit=mi\|km`.                   |
| `test_strava.py`     | Zwift-only parsing, local dates, optional data, virtual GPS omission, stream validation, repeat imports and updates, raw replay, cross-source duplicates in both arrival orders, token rotation, safe errors, pagination and sync checkpoints.                           |
| `test_strava_api.py` | Manual pull authorization, cross-origin header requirement, saved connection use, concurrent-pull rejection and safe Strava errors.                                                                                                                                      |

### Schema-portability notes for tests

Models use `SCHEMA = get_settings().db_schema or None` and a `_fk()` helper so
foreign keys render without the `fit.` prefix on SQLite. BigInteger PKs use
`.with_variant(Integer, "sqlite")` because SQLite only auto-increments
`INTEGER PRIMARY KEY`.

## Frontend (Vitest)

```powershell
cd frontend
npm test        # 16 tests
```

`format.test.ts` covers the display helpers — pace formatting (`sec → m:ss`),
distance in mi/km, duration, and null handling — the logic most likely to
regress in the UI. `useApiResource.test.ts` covers the shared data-loading hook:
success populates data, a 401 clears the token and triggers logout, and other
errors surface without logging out.

## Lint & type-check

```powershell
cd backend
.\.venv\Scripts\ruff.exe check .     # lint (pycodestyle, pyflakes, isort, bugbear, pyupgrade)
.\.venv\Scripts\mypy.exe             # static type-check of app/
```

Config lives in `backend/pyproject.toml`. `ruff` also formats imports (`--fix`).
The frontend is type-checked by `tsc --noEmit` as part of `npm run build`.

## CI

`.github/workflows/ci.yml` runs on every push/PR. The backend job installs deps
then runs **ruff → mypy → pytest**; the frontend job runs `npm test` + `npm run
build` (which type-checks via `tsc`). It never touches Azure or the database.
