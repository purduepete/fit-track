# Testing

fittrack is built with tests from the start. Parsing and split math are pure
functions with heavy unit coverage; the API is exercised against an in-memory
SQLite database so no live DB or network is required.

## Backend (pytest)

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest        # 27 tests
```

`tests/conftest.py` sets `DB_SCHEMA=""` and `DB_PASSWORD="test"` **before**
importing app modules, so models render schemaless on SQLite. API tests override
`get_db` with an in-memory `StaticPool` SQLite session.

| File | Covers |
| --- | --- |
| `test_geo.py` | haversine distance; GPS and sample split computation; interpolation across multiple boundaries; partial trailing split; monotonicity. |
| `test_normalize.py` | parsing real Health Auto Export field shapes; unit conversion; timezone → UTC + `local_date`; payload hashing. |
| `test_persist.py` | idempotent upsert (re-ingest replaces child rows, no duplicates); split persistence for both units; daily-metric uniqueness. |
| `test_api.py` | auth (401 without/with bad token, scope enforcement); ingest + dedup; workout list/detail; dashboard aggregates; `unit=mi\|km`. |

### Schema-portability notes for tests
Models use `SCHEMA = get_settings().db_schema or None` and a `_fk()` helper so
foreign keys render without the `fit.` prefix on SQLite. BigInteger PKs use
`.with_variant(Integer, "sqlite")` because SQLite only auto-increments
`INTEGER PRIMARY KEY`.

## Frontend (Vitest)

```powershell
cd frontend
npm test        # 13 tests
```

`format.test.ts` covers the display helpers — pace formatting (`sec → m:ss`),
distance in mi/km, duration, and null handling — the logic most likely to
regress in the UI.

## CI

`.github/workflows/ci.yml` runs on every push/PR: installs backend deps and runs
pytest, then installs frontend deps and runs `npm test` + `npm run build`. It
never touches Azure or the database.
