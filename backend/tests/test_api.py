"""End-to-end API tests via FastAPI TestClient (in-memory SQLite)."""
import json

WORKOUT_PAYLOAD = {
    "data": {
        "workouts": [
            {
                "id": "API-W1",
                "name": "Outdoor Run",
                "start": "2026-07-05 11:39:13 -0700",
                "end": "2026-07-05 12:10:07 -0700",
                "duration": 1853.6,
                "distance": {"qty": 2.3, "units": "mi"},
                "activeEnergyBurned": {"qty": 286.6, "units": "kcal"},
                "avgHeartRate": {"qty": 117.8},
                "route": [
                    {"latitude": 0.0, "longitude": 0.0,
                     "timestamp": "2026-07-05 11:39:13 -0700"},
                    {"latitude": 0.03, "longitude": 0.0,
                     "timestamp": "2026-07-05 12:10:07 -0700"},
                ],
                "heartRateData": [{"date": "2026-07-05 11:39:16 -0700", "Avg": 110}],
            }
        ],
        "metrics": [],
    }
}


def test_health_endpoint_is_open(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_ingest_requires_token(client):
    r = client.post("/api/ingest/health-auto-export", json=WORKOUT_PAYLOAD)
    assert r.status_code == 401


def test_ingest_rejects_bad_token(client):
    r = client.post(
        "/api/ingest/health-auto-export",
        json=WORKOUT_PAYLOAD,
        headers={"Authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_full_ingest_and_read_flow(client, auth_headers):
    r = client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(WORKOUT_PAYLOAD),
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["workouts"] == 1

    # Re-ingest identical payload -> duplicate short-circuits.
    r2 = client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(WORKOUT_PAYLOAD),
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert r2.json()["duplicate"] is True

    # List
    lst = client.get("/api/workouts", headers=auth_headers).json()
    assert lst["total"] == 1
    assert len(lst["items"]) == 1
    assert lst["items"][0]["uuid"] == "API-W1"
    assert lst["items"][0]["has_route"] is True

    # Detail with splits + route + hr
    detail = client.get("/api/workouts/API-W1?unit=mi", headers=auth_headers).json()
    assert detail["workout_type"] == "Outdoor Run"
    assert len(detail["route"]) == 2
    assert len(detail["splits"]) >= 1
    assert len(detail["hr_series"]) == 1

    # Dashboard
    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert "workouts_7d" in dash


def test_ingest_rejects_malformed_json(client, auth_headers):
    r = client.post(
        "/api/ingest/health-auto-export",
        content="{not valid json",
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    assert r.status_code == 400, r.text


def test_workout_404(client, auth_headers):
    assert client.get("/api/workouts/nope", headers=auth_headers).status_code == 404


def test_workouts_filter_paginate_and_types(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import Workout
    from app.timeutil import utcnow

    now = utcnow()

    def mk(uuid, wtype, day_offset):
        d = now - timedelta(days=day_offset)
        return Workout(
            uuid=uuid, workout_type=wtype, start_utc=d, end_utc=d,
            local_date=d.strftime("%Y-%m-%d"), duration_sec=600,
            has_route=False, created_utc=now, updated_utc=now,
        )

    db_session.add_all(
        [mk("w-run-0", "Run", 0), mk("w-run-1", "Run", 1), mk("w-walk-2", "Walk", 2), mk("w-walk-9", "Walk", 9)]
    )
    db_session.commit()

    # Type filter.
    r = client.get("/api/workouts?workout_type=Walk", headers=auth_headers).json()
    assert r["total"] == 2
    assert {i["uuid"] for i in r["items"]} == {"w-walk-2", "w-walk-9"}

    # Pagination: total reflects the full match; items are the page; newest first.
    r = client.get("/api/workouts?limit=2&offset=0", headers=auth_headers).json()
    assert r["total"] == 4
    assert [i["uuid"] for i in r["items"]] == ["w-run-0", "w-run-1"]
    r2 = client.get("/api/workouts?limit=2&offset=2", headers=auth_headers).json()
    assert [i["uuid"] for i in r2["items"]] == ["w-walk-2", "w-walk-9"]

    # Date range: last 3 days excludes the 9-day-old walk.
    since = (now - timedelta(days=3)).strftime("%Y-%m-%d")
    r = client.get(f"/api/workouts?date_from={since}", headers=auth_headers).json()
    assert r["total"] == 3
    assert "w-walk-9" not in {i["uuid"] for i in r["items"]}

    # Distinct types for the filter dropdown.
    assert client.get("/api/workouts/types", headers=auth_headers).json() == ["Run", "Walk"]


def test_workout_detail_prev_next_navigation(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import Workout
    from app.timeutil import utcnow

    now = utcnow()

    def mk(uuid, day_offset):
        d = now - timedelta(days=day_offset)
        return Workout(
            uuid=uuid, workout_type="Run", start_utc=d, end_utc=d,
            local_date=d.strftime("%Y-%m-%d"), duration_sec=600,
            has_route=False, created_utc=now, updated_utc=now,
        )

    # newest -> oldest: n0, n1, n2
    db_session.add_all([mk("n0", 0), mk("n1", 1), mk("n2", 2)])
    db_session.commit()

    # Middle workout links to the older one (prev) and the newer one (next).
    mid = client.get("/api/workouts/n1", headers=auth_headers).json()
    assert mid["prev_uuid"] == "n2"  # older
    assert mid["next_uuid"] == "n0"  # newer

    # Ends: newest has no newer, oldest has no older.
    newest = client.get("/api/workouts/n0", headers=auth_headers).json()
    assert newest["next_uuid"] is None
    assert newest["prev_uuid"] == "n1"
    oldest = client.get("/api/workouts/n2", headers=auth_headers).json()
    assert oldest["prev_uuid"] is None
    assert oldest["next_uuid"] == "n1"


def test_sample_indices_preserves_endpoints_and_cap():
    from app.routers import workouts as wr

    idxs = wr._sample_indices(1000, 100)
    assert len(idxs) <= 100
    assert idxs[0] == 0 and idxs[-1] == 999
    assert idxs == sorted(idxs)  # ascending, no dupes
    assert idxs == wr._sample_indices(1000, 100)  # deterministic


def test_sample_indices_noop_when_within_cap():
    from app.routers import workouts as wr

    assert wr._sample_indices(3, 500) == [0, 1, 2]
    assert wr._sample_indices(0, 500) == []
    assert wr._sample_indices(2, 1) == [0]


def _ingest(client, auth_headers, payload=WORKOUT_PAYLOAD):
    return client.post(
        "/api/ingest/health-auto-export",
        content=json.dumps(payload),
        headers={**auth_headers, "Content-Type": "application/json"},
    )


def test_workout_detail_downsamples_and_full_opt_in(client, auth_headers, monkeypatch):
    from app.routers import workouts as wr

    assert _ingest(client, auth_headers).status_code == 200
    monkeypatch.setattr(wr, "MAX_ROUTE_POINTS", 1)  # force downsampling of the 2-point route

    d = client.get("/api/workouts/API-W1?unit=mi", headers=auth_headers).json()
    assert d["route_total"] == 2
    assert d["route_downsampled"] is True
    assert len(d["route"]) == 1

    full = client.get("/api/workouts/API-W1?full=true", headers=auth_headers).json()
    assert len(full["route"]) == 2
    assert full["route_downsampled"] is False


def test_workout_detail_returns_both_unit_splits(client, auth_headers):
    assert _ingest(client, auth_headers).status_code == 200

    d = client.get("/api/workouts/API-W1", headers=auth_headers).json()
    assert len(d["splits"]) >= 2
    units = {s["unit_system"] for s in d["splits"]}
    assert units == {"mi", "km"}  # both unit systems returned; client selects locally


def test_ingest_rejects_oversized_payload(client, auth_headers):
    from app.config import get_settings

    get_settings().max_ingest_bytes = 10  # tiny cap; any real payload exceeds it
    try:
        r = _ingest(client, auth_headers)
        assert r.status_code == 413, r.text
    finally:
        get_settings().max_ingest_bytes = 25 * 1024 * 1024


def test_ingest_streams_and_caps_body_without_content_length(client, auth_headers):
    """A chunked upload (no Content-Length) must still be capped by the streaming
    guard, not buffered unbounded into memory."""
    from app.config import get_settings

    def _body():
        # Yielding chunks makes httpx use chunked transfer encoding (no
        # Content-Length header), so only the stream-side cap can reject it.
        for _ in range(50):
            yield b"x" * 1000

    get_settings().max_ingest_bytes = 100
    try:
        r = client.post(
            "/api/ingest/health-auto-export",
            content=_body(),
            headers={**auth_headers, "Content-Type": "application/json"},
        )
        assert r.status_code == 413, r.text
    finally:
        get_settings().max_ingest_bytes = 25 * 1024 * 1024


def test_dashboard_trends_are_windowed(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import Workout
    from app.timeutil import utcnow

    now = utcnow()
    recent, old = now - timedelta(days=1), now - timedelta(days=30)
    # Two workouts on the same recent day must count as one active day.
    recent2 = recent - timedelta(hours=3)
    db_session.add_all(
        [
            Workout(
                uuid="recent", workout_type="Walk", start_utc=recent, end_utc=recent,
                local_date=recent.strftime("%Y-%m-%d"), duration_sec=600,
                has_route=False, created_utc=now, updated_utc=now,
            ),
            Workout(
                uuid="recent2", workout_type="Run", start_utc=recent2, end_utc=recent2,
                local_date=recent.strftime("%Y-%m-%d"), duration_sec=900,
                has_route=False, created_utc=now, updated_utc=now,
            ),
            Workout(
                uuid="old", workout_type="Walk", start_utc=old, end_utc=old,
                local_date=old.strftime("%Y-%m-%d"), duration_sec=600,
                has_route=False, created_utc=now, updated_utc=now,
            ),
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["workouts_7d"] == 1  # two same-day workouts count as one active day
    dates = [p["local_date"] for p in dash["weekly_minutes"]]
    assert recent.strftime("%Y-%m-%d") in dates
    assert old.strftime("%Y-%m-%d") not in dates


def test_dashboard_vo2max_band_and_trend(client, auth_headers, db_session, monkeypatch):
    from datetime import date, timedelta

    from app.models import DailyMetric
    from app.routers import dashboard
    from app.timeutil import utcnow

    now = utcnow()
    recent = (now - timedelta(days=2)).strftime("%Y-%m-%d")
    old = (now - timedelta(days=400)).strftime("%Y-%m-%d")
    db_session.add_all(
        [
            DailyMetric(metric_type="vo2_max", local_date=recent, value=38.8, unit="ml/kg/min", updated_utc=now),
            DailyMetric(metric_type="vo2_max", local_date=old, value=30.0, unit="ml/kg/min", updated_utc=now),
        ]
    )
    db_session.commit()

    class _S:
        athlete_birth_date = date(1970, 9, 20)
        athlete_sex = "male"

    monkeypatch.setattr(dashboard, "get_settings", lambda: _S())
    monkeypatch.setattr(dashboard.vo2max, "age_on", lambda bd, on=None: 55)

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["latest_vo2max"] == 38.8
    assert dash["vo2max_band"]["category"] == "Good"
    assert dash["vo2max_band"]["next_at"] == 41.0
    # 400-day-old point is outside the 365-day window.
    trend_dates = [p["local_date"] for p in dash["vo2max_trend"]]
    assert recent in trend_dates
    assert old not in trend_dates


def test_dashboard_vo2max_band_omitted_when_profile_unset(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import DailyMetric
    from app.timeutil import utcnow

    recent = (utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    db_session.add(
        DailyMetric(
            metric_type="vo2_max", local_date=recent, value=42.0, unit="ml/kg/min", updated_utc=utcnow()
        )
    )
    db_session.commit()

    # Default test settings have no athlete profile -> no interpretation.
    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["latest_vo2max"] == 42.0
    assert dash["vo2max_band"] is None


def test_dashboard_sleep_band_and_trend(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import DailyMetric
    from app.timeutil import utcnow

    now = utcnow()
    recent = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    old = (now - timedelta(days=40)).strftime("%Y-%m-%d")
    db_session.add_all(
        [
            DailyMetric(metric_type="sleep_asleep_hours", local_date=recent, value=7.5, unit="hr", updated_utc=now),
            DailyMetric(metric_type="sleep_asleep_hours", local_date=old, value=6.0, unit="hr", updated_utc=now),
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["latest_sleep_hours"] == 7.5
    assert dash["sleep_band"]["category"] == "Excellent"
    assert dash["sleep_band"]["category_index"] == 3
    # 40-day-old point is outside the 30-day sleep window.
    trend_dates = [p["local_date"] for p in dash["sleep_trend"]]
    assert recent in trend_dates
    assert old not in trend_dates


def test_dashboard_steps_trend(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import DailyMetric
    from app.timeutil import utcnow

    now = utcnow()
    recent = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    old = (now - timedelta(days=40)).strftime("%Y-%m-%d")
    db_session.add_all(
        [
            DailyMetric(metric_type="step_count", local_date=recent, value=8200.0, unit="count", updated_utc=now),
            DailyMetric(metric_type="step_count", local_date=old, value=5000.0, unit="count", updated_utc=now),
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    # latest = most recent day with data; stored float is rounded to an int.
    assert dash["latest_steps"] == 8200
    assert dash["latest_steps_date"] == recent
    # 40-day-old point is outside the 30-day steps window.
    trend_dates = [p["local_date"] for p in dash["steps_trend"]]
    assert recent in trend_dates
    assert old not in trend_dates


def test_dashboard_steps_summed_from_ingest(client, auth_headers):
    """Intraday step points (multiple per day, mixed sources) sum into the
    dashboard's daily total rather than showing a single point's count."""
    from datetime import timedelta

    from app.timeutil import utcnow

    day = (utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    payload = {
        "data": {
            "workouts": [],
            "metrics": [
                {
                    "name": "step_count",
                    "units": "count",
                    "data": [
                        {"date": f"{day} 08:00:00 -0700", "qty": 5000, "source": "iPhone"},
                        {"date": f"{day} 12:00:00 -0700", "qty": 4000, "source": "Apple Watch"},
                        {"date": f"{day} 18:00:00 -0700", "qty": 1234, "source": "Apple Watch|iPhone"},
                    ],
                }
            ],
        }
    }
    assert _ingest(client, auth_headers, payload=payload).status_code == 200

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    same_day = [p for p in dash["steps_trend"] if p["local_date"] == day]
    # One aggregated point summing every intraday count (not the last, not the max).
    assert len(same_day) == 1
    assert same_day[0]["value"] == 10234
    assert dash["latest_steps"] == 10234
    assert dash["latest_steps_date"] == day


def test_dashboard_steps_block_avg7(client, auth_headers, db_session):
    """steps_avg7_trend is a stepped 7-day *block* average anchored to today: the
    most recent 7 days form one block, the prior 7 another, etc. Every day in a
    block reports that block's mean over the days that have data."""
    from datetime import timedelta

    from app.models import DailyMetric
    from app.timeutil import utcnow

    now = utcnow()
    # 8 consecutive days ending yesterday, values 1000..8000.
    days = [(now - timedelta(days=8 - i)).strftime("%Y-%m-%d") for i in range(8)]
    values = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]
    db_session.add_all(
        [
            DailyMetric(metric_type="step_count", local_date=d, value=float(v), unit="count", updated_utc=now)
            for d, v in zip(days, values, strict=True)
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    avg = {p["local_date"]: p["value"] for p in dash["steps_avg7_trend"]}
    # Block 0 = today back through today-6, so today-1..today-6 (values 3000..8000)
    # → mean 5500. Every day in the block reports the same value.
    assert avg[days[7]] == 5500  # today-1
    assert avg[days[6]] == 5500  # today-2
    # Block 1 = today-7 back through today-13, so today-7 (2000) + today-8 (1000)
    # → mean 1500.
    assert avg[days[1]] == 1500  # today-7
    assert avg[days[0]] == 1500  # today-8
    # One average point per steps point, and the series is padded to the window.
    assert len(dash["steps_avg7_trend"]) == len(dash["steps_trend"]) == 30


def test_dashboard_steps_trend_padded_to_window(client, auth_headers, db_session):
    """The steps trend is padded to a contiguous 30-day window (newest last);
    days without data are gaps (value=None)."""
    from datetime import timedelta

    from app.models import DailyMetric
    from app.timeutil import utcnow

    now = utcnow()
    recent = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    db_session.add(
        DailyMetric(metric_type="step_count", local_date=recent, value=8200.0, unit="count", updated_utc=now)
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    trend = dash["steps_trend"]
    assert len(trend) == 30
    # Newest day is today; oldest is 29 days back; dates are contiguous.
    assert trend[-1]["local_date"] == now.strftime("%Y-%m-%d")
    assert trend[0]["local_date"] == (now - timedelta(days=29)).strftime("%Y-%m-%d")
    by_date = {p["local_date"]: p["value"] for p in trend}
    assert by_date[recent] == 8200
    # A day with no data is present but null (a gap).
    assert by_date[now.strftime("%Y-%m-%d")] is None


def test_dashboard_workout_days_within_window(client, auth_headers, db_session):
    """workout_days lists distinct workout dates inside the 30-day steps window
    and excludes older workouts."""
    from datetime import timedelta

    from app.models import Workout
    from app.timeutil import utcnow

    now = utcnow()
    recent = now - timedelta(days=2)
    old = now - timedelta(days=45)
    recent_day = recent.strftime("%Y-%m-%d")
    old_day = old.strftime("%Y-%m-%d")
    db_session.add_all(
        [
            Workout(uuid="w-recent-1", workout_type="run", start_utc=recent, end_utc=recent,
                    local_date=recent_day, created_utc=now, updated_utc=now),
            # Second workout the same day must not duplicate the date.
            Workout(uuid="w-recent-2", workout_type="walk", start_utc=recent, end_utc=recent,
                    local_date=recent_day, created_utc=now, updated_utc=now),
            Workout(uuid="w-old", workout_type="run", start_utc=old, end_utc=old, local_date=old_day,
                    created_utc=now, updated_utc=now),
        ]
    )
    db_session.commit()

    dash = client.get("/api/dashboard", headers=auth_headers).json()
    assert dash["workout_days"].count(recent_day) == 1
    assert old_day not in dash["workout_days"]


def test_token_last_used_not_rewritten_within_window(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import ApiToken
    from app.timeutil import utcnow

    tok = db_session.query(ApiToken).one()
    recent = utcnow() - timedelta(minutes=5)
    tok.last_used_utc = recent
    db_session.commit()

    assert client.get("/api/workouts", headers=auth_headers).status_code == 200
    db_session.refresh(tok)
    assert tok.last_used_utc == recent  # within debounce window -> no rewrite


def test_token_last_used_refreshes_when_stale(client, auth_headers, db_session):
    from datetime import timedelta

    from app.models import ApiToken
    from app.timeutil import utcnow

    tok = db_session.query(ApiToken).one()
    stale = utcnow() - timedelta(hours=2)
    tok.last_used_utc = stale
    db_session.commit()

    assert client.get("/api/workouts", headers=auth_headers).status_code == 200
    db_session.refresh(tok)
    assert tok.last_used_utc > stale  # stale -> refreshed


class _NoneResult:
    """Stand-in Result whose scalar_one_or_none() reports 'no existing row'."""

    def scalar_one_or_none(self):
        return None


def test_concurrent_duplicate_ingest_is_idempotent(client, auth_headers, db_session, monkeypatch):
    from app.models import RawIngestEvent
    from app.normalize import payload_hash
    from app.timeutil import utcnow

    raw = json.dumps(WORKOUT_PAYLOAD)
    digest = payload_hash(raw)
    # A concurrent request already committed this payload.
    db_session.add(
        RawIngestEvent(
            source="health_auto_export", received_utc=utcnow(),
            payload_hash=digest, payload_json=raw, status="received",
        )
    )
    db_session.commit()

    # Force only the ingest duplicate-check SELECT to miss (as it would in a race),
    # so the handler attempts an INSERT that violates the unique payload_hash.
    real_execute = db_session.execute

    def fake_execute(stmt, *a, **k):
        if "raw_ingest_events" in str(stmt):
            return _NoneResult()
        return real_execute(stmt, *a, **k)

    monkeypatch.setattr(db_session, "execute", fake_execute)
    r = _ingest(client, auth_headers)
    monkeypatch.undo()

    assert r.status_code == 200, r.text
    assert r.json()["duplicate"] is True


def test_received_event_is_reprocessed(client, auth_headers, db_session):
    """A prior request that crashed mid-persist leaves status='received'; a retry
    of the same payload must reprocess it (not silently skip)."""
    from app.models import RawIngestEvent, Workout
    from app.normalize import payload_hash
    from app.timeutil import utcnow

    raw = json.dumps(WORKOUT_PAYLOAD)
    db_session.add(
        RawIngestEvent(
            source="health_auto_export", received_utc=utcnow(),
            payload_hash=payload_hash(raw), payload_json=raw, status="received",
        )
    )
    db_session.commit()
    assert db_session.query(Workout).count() == 0

    r = _ingest(client, auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["duplicate"] is False
    assert r.json()["workouts"] == 1
    assert db_session.query(Workout).count() == 1
