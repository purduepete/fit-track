"""Strava sync tests use fake HTTP and the existing isolated SQLite fixture."""
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from threading import Event

import httpx
import pytest
from app.models import AthleteProfile, RawIngestEvent, Workout, WorkoutRoutePoint, WorkoutSample, WorkoutSplit
from app.normalize import ParsedPayload, parse_workout, payload_hash, persist_payload
from app.strava import (
    Credentials,
    StravaBusy,
    StravaClient,
    StravaError,
    load_credentials,
    parse_strava_payload,
    persist_strava_event,
    run_sync,
    save_credentials,
    summary_digest,
    sync_once,
)
from sqlalchemy.exc import SQLAlchemyError


def ride():
    return {
        "summary": {"id": 123, "sport_type": "VirtualRide", "distance": 2000},
        "activity": {
            "id": 123, "sport_type": "VirtualRide", "device_name": "Zwift",
            "start_date": "2026-10-23T02:30:00Z",
            "start_date_local": "2026-10-22T19:30:00Z",
            "elapsed_time": 600, "moving_time": 550, "distance": 2000,
            "calories": 125, "average_heartrate": 130, "max_heartrate": 150,
        },
        "streams": {
            "time": {"data": [0, 300, 600]},
            "distance": {"data": [0, 1000, 2000]},
            "heartrate": {"data": [110, 130, 150]},
            "latlng": {"data": [[1, 2], [3, 4], [5, 6]]},
        },
    }


@pytest.fixture
def token_file(tmp_path):
    path = tmp_path / "tokens.json"
    save_credentials(path, Credentials(
        client_id=42, client_secret="fake-secret", access_token="fake-access",
        refresh_token="fake-refresh", expires_at=int(datetime.now(UTC).timestamp()) + 3600,
        athlete_id=77, import_after=int((datetime.now(UTC) - timedelta(days=90)).timestamp()),
    ))
    return path


def test_parse_ride_local_date_streams_and_elapsed_time():
    workout = parse_strava_payload(ride()).workouts[0]
    assert workout.uuid == "strava:123"
    assert workout.local_date == "2026-10-22"
    assert workout.tz_offset_minutes == -420
    assert workout.workout_type == "Indoor Cycling"
    assert workout.source_name == "Strava"
    assert workout.duration_sec == 600
    assert workout.end_utc - workout.start_utc == timedelta(seconds=600)
    assert workout.distance_m == 2000
    assert workout.active_energy_kcal == 125
    assert workout.avg_hr == 130
    assert len(workout.hr_samples) == 3
    assert sum(s.meters for s in workout.distance_samples) == 2000
    assert [(p.lat, p.lon) for p in workout.route] == [(1, 2), (3, 4), (5, 6)]
    assert [p.ts_utc for p in workout.route] == [p.ts_utc for p in workout.hr_samples]
    # Rides fetched before the altitude stream was requested keep their route.
    assert [p.elevation_m for p in workout.route] == [None, None, None]
    assert workout.elevation_gain_m is None


def climbing_ride():
    payload = ride()
    payload["activity"]["total_elevation_gain"] = 15.0
    payload["streams"]["altitude"] = {"data": [10.0, 25.0, 20.0]}
    return payload


def test_parse_altitude_stream_and_total_gain():
    workout = parse_strava_payload(climbing_ride()).workouts[0]
    assert [p.elevation_m for p in workout.route] == [10.0, 25.0, 20.0]
    assert workout.elevation_gain_m == 15.0


@pytest.mark.parametrize("data", [[10.0], [10.0, True, 20.0], [10.0, float("inf"), 20.0], [10.0, "x", 20.0]])
def test_reject_malformed_altitude(data):
    payload = climbing_ride()
    payload["streams"]["altitude"]["data"] = data
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


@pytest.mark.parametrize("value", [-1.0, float("nan"), True])
def test_reject_invalid_total_elevation_gain(value):
    payload = climbing_ride()
    payload["activity"]["total_elevation_gain"] = value
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


def test_persist_elevation_on_workout_route_and_splits(db_session):
    persist_strava_event(climbing_ride(), db_session)
    assert db_session.get(Workout, "strava:123").elevation_gain_m == 15.0
    points = db_session.query(WorkoutRoutePoint).order_by(WorkoutRoutePoint.seq).all()
    assert [p.elevation_m for p in points] == [10.0, 25.0, 20.0]
    km = db_session.query(WorkoutSplit).filter_by(unit_system="km").order_by(WorkoutSplit.split_index).all()
    # Splits keep the distance-stream axis; elevation comes from the route.
    assert [s.source for s in km] == ["sample", "sample"]
    assert [s.distance_m for s in km] == [1000, 1000]
    assert [s.elevation_gain_m for s in km] == [15.0, 0.0]


def test_newer_event_replaces_older_raw_events_for_same_ride(db_session):
    persist_strava_event(ride(), db_session)
    other = ride()
    other["summary"]["id"] = other["activity"]["id"] = 456
    persist_strava_event(other, db_session)
    changed = climbing_ride()
    changed["summary"]["distance"] = 2001
    persist_strava_event(changed, db_session)
    events = db_session.query(RawIngestEvent).all()
    assert sorted(json.loads(e.payload_json)["activity"]["id"] for e in events) == [123, 456]
    kept = next(e for e in events if json.loads(e.payload_json)["activity"]["id"] == 123)
    assert "altitude" in json.loads(kept.payload_json)["streams"]


def test_optional_data_can_be_absent():
    payload = ride()
    payload["streams"] = {}
    for key in ("calories", "average_heartrate", "max_heartrate"):
        del payload["activity"][key]
    workout = parse_strava_payload(payload).workouts[0]
    assert workout.avg_hr is None
    assert workout.active_energy_kcal is None
    assert workout.hr_samples == []
    assert workout.route == []


def test_null_stream_entries_are_treated_as_absent():
    payload = ride()
    payload["streams"]["altitude"] = None
    payload["streams"]["heartrate"] = {"data": None}
    workout = parse_strava_payload(payload).workouts[0]
    assert workout.hr_samples == []
    assert [p.elevation_m for p in workout.route] == [None, None, None]


@pytest.mark.parametrize("streams", [["time"], {"altitude": {"data": "abc"}}])
def test_reject_non_dict_streams_or_non_list_data(streams):
    payload = ride()
    payload["streams"] = streams
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


@pytest.mark.parametrize("field,value", [
    ("elapsed_time", -1), ("distance", float("nan")), ("elapsed_time", True),
    ("start_date", "bad"), ("start_date", "2026-10-23T02:30:00"),
    ("device_name", "ROUVY"), ("sport_type", "Ride"), ("id", "../123"),
])
def test_reject_invalid_or_non_zwift_activities(field, value):
    payload = ride()
    payload["activity"][field] = value
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


@pytest.mark.parametrize("key,data", [
    ("time", [0, 300, 299]), ("time", [0, 300, 601]),
    ("heartrate", [120]), ("distance", [0, 1200, 1000]),
    ("latlng", [[1, 2]]), ("latlng", [[91, 2]] * 3),
    ("latlng", [[1, -181]] * 3), ("latlng", [[True, 2]] * 3),
    ("latlng", [[1, float("nan")]] * 3), ("latlng", [[1]] * 3),
    ("latlng", [None] * 3),
])
def test_reject_malformed_streams(key, data):
    payload = ride()
    payload["streams"][key]["data"] = data
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


def test_persist_dedup_update_and_replay(db_session):
    payload = ride()
    counts = persist_strava_event(payload, db_session)
    assert counts["workouts"] == 1
    assert db_session.query(WorkoutSample).count() == 3
    assert db_session.query(WorkoutSplit).count() > 0
    assert db_session.query(WorkoutRoutePoint).count() == 3
    assert db_session.get(Workout, "strava:123").has_route
    splits = db_session.query(WorkoutSplit).filter_by(unit_system="km").all()
    assert sum(s.distance_m for s in splits) == 2000
    assert {s.source for s in splits} == {"sample"}
    assert persist_strava_event(payload, db_session)["workouts"] == 0
    changed = deepcopy(payload)
    changed["summary"]["distance"] = 2100
    changed["activity"]["distance"] = 2100
    assert persist_strava_event(changed, db_session)["workouts"] == 1
    assert db_session.query(Workout).count() == 1
    assert db_session.query(WorkoutSample).count() == 3
    assert db_session.query(WorkoutRoutePoint).count() == 3
    assert db_session.get(Workout, "strava:123").distance_m == 2100
    event = db_session.query(RawIngestEvent).order_by(RawIngestEvent.id.desc()).first()
    assert event.source == "strava"
    parsed = parse_strava_payload(json.loads(event.payload_json))
    persist_payload(parsed, db_session, ingest_source="strava")
    assert db_session.query(Workout).count() == 1
    # An edit can revert to a previously seen summary.
    payload["activity"]["calories"] = 130
    assert persist_strava_event(payload, db_session)["workouts"] == 1
    assert db_session.get(Workout, "strava:123").distance_m == 2000
    replay = db_session.query(RawIngestEvent).filter(
        RawIngestEvent.payload_hash == summary_digest(payload["summary"]),
    ).one()
    assert json.loads(replay.payload_json)["activity"]["calories"] == 130


def health_ride(*, source="Zwift", start="2026-10-23T02:30:00Z"):
    workout = parse_workout({
        "id": "apple-123", "sourceName": source, "name": "Indoor Cycling",
        "start": start, "end": "2026-10-23T02:40:00Z", "duration": 600,
    })
    assert workout is not None
    return ParsedPayload(workouts=[workout])


@pytest.mark.parametrize("health_first", [True, False])
def test_cross_source_duplicate_both_arrival_orders(db_session, health_first):
    if health_first:
        persist_payload(health_ride(), db_session)
        db_session.commit()
        assert persist_strava_event(ride(), db_session)["workouts"] == 0
    else:
        persist_strava_event(ride(), db_session)
        assert persist_payload(health_ride(), db_session)["workouts"] == 0
    assert db_session.query(Workout).count() == 1


def test_different_ride_and_watch_recordings_preserved(db_session):
    persist_strava_event(ride(), db_session)
    assert persist_payload(health_ride(start="2026-10-23T02:20:00Z"), db_session)["workouts"] == 1
    payload = health_ride(source="Apple Watch")
    payload.workouts[0].uuid = "watch-123"
    assert persist_payload(payload, db_session)["workouts"] == 1


def test_default_health_source_exclusion_remains(db_session):
    assert persist_payload(parse_strava_payload(ride()), db_session)["workouts"] == 0


def test_refresh_rotates_and_saves_tokens_before_api_call(token_file):
    credentials = load_credentials(token_file)
    credentials.expires_at = 0
    save_credentials(token_file, credentials)
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/oauth/token":
            assert b"grant_type=refresh_token" in request.content
            return httpx.Response(200, json={
                "access_token": "new-access", "refresh_token": "new-refresh",
                "expires_at": int(datetime.now(UTC).timestamp()) + 3600,
            })
        assert request.headers["authorization"] == "Bearer new-access"
        assert load_credentials(token_file).refresh_token == "new-refresh"
        return httpx.Response(200, json={"id": 77})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        assert StravaClient(token_file, http).get("athlete") == {"id": 77}
    assert calls == ["/oauth/token", "/api/v3/athlete"]


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_http_errors_are_explicit_and_redacted(token_file, status):
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, text="fake-secret"))) as http:
        with pytest.raises(StravaError) as exc:
            StravaClient(token_file, http).get("athlete")
    assert "fake-secret" not in str(exc.value)


def test_atomic_save_failure_keeps_old_tokens(token_file, monkeypatch):
    original = token_file.read_text()

    def fail(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(type(token_file), "replace", fail)
    with pytest.raises(StravaError):
        save_credentials(token_file, load_credentials(token_file))
    assert token_file.read_text() == original
    assert not token_file.with_suffix(".tmp").exists()


def test_sync_pagination_filter_and_repeat_skip(token_file, db_session):
    from contextlib import nullcontext

    payload = ride()
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        if request.url.path.endswith("/athlete/activities"):
            assert int(request.url.params["after"]) >= load_credentials(token_file).import_after - 1
            page = int(request.url.params["page"])
            return httpx.Response(200, json={
                1: [payload["summary"], {"id": 999, "sport_type": "Run"}],
                2: [{"id": 124, "sport_type": "VirtualRide"}], 3: [],
            }[page])
        if request.url.path.endswith("/124"):
            return httpx.Response(200, json={**payload["activity"], "id": 124, "device_name": "ROUVY"})
        if request.url.path.endswith("/streams"):
            assert request.url.params["keys"] == "time,distance,heartrate,latlng,altitude"
            return httpx.Response(200, json=payload["streams"])
        return httpx.Response(200, json=payload["activity"])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        factory = lambda: nullcontext(db_session)  # noqa: E731
        assert sync_once(token_file, factory, http=http) == 1
        assert load_credentials(token_file).last_sync > 0
        assert sync_once(token_file, factory, http=http) == 0
    assert calls.count("/api/v3/activities/123") == 1
    assert calls.count("/api/v3/activities/123/streams") == 1
    assert db_session.query(Workout).count() == 1


def test_sync_refreshes_pre_route_import_once(token_file, db_session):
    from contextlib import nullcontext

    payload = ride()
    old = deepcopy(payload)
    old["streams"].pop("latlng")
    persist_strava_event(old, db_session)
    event = db_session.query(RawIngestEvent).one()
    event.payload_hash = payload_hash(
        "strava:" + json.dumps(payload["summary"], sort_keys=True, separators=(",", ":"))
    )
    db_session.commit()
    stream_calls = []

    def handler(request):
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        if request.url.path.endswith("/athlete/activities"):
            return httpx.Response(200, json=[payload["summary"]] if request.url.params["page"] == "1" else [])
        if request.url.path.endswith("/streams"):
            stream_calls.append(request.url.path)
            return httpx.Response(200, json=payload["streams"])
        return httpx.Response(200, json=payload["activity"])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        assert sync_once(token_file, lambda: nullcontext(db_session), http=http) == 1
        assert sync_once(token_file, lambda: nullcontext(db_session), http=http) == 0
    assert len(stream_calls) == 1
    assert db_session.query(Workout).count() == 1
    assert db_session.query(WorkoutRoutePoint).count() == 3


def test_sync_refetches_routes_v1_import_with_altitude(token_file, db_session):
    from contextlib import nullcontext

    payload = climbing_ride()
    old = ride()
    persist_strava_event(old, db_session)
    event = db_session.query(RawIngestEvent).one()
    event.payload_hash = payload_hash(
        "strava:routes-v1:" + json.dumps(payload["summary"], sort_keys=True, separators=(",", ":"))
    )
    db_session.commit()
    stream_calls = []

    def handler(request):
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        if request.url.path.endswith("/athlete/activities"):
            return httpx.Response(200, json=[payload["summary"]] if request.url.params["page"] == "1" else [])
        if request.url.path.endswith("/streams"):
            stream_calls.append(request.url.path)
            return httpx.Response(200, json=payload["streams"])
        return httpx.Response(200, json=payload["activity"])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        assert sync_once(token_file, lambda: nullcontext(db_session), http=http) == 1
        assert sync_once(token_file, lambda: nullcontext(db_session), http=http) == 0
    assert len(stream_calls) == 1
    assert db_session.get(Workout, "strava:123").elevation_gain_m == 15.0
    assert db_session.query(RawIngestEvent).one().payload_hash == summary_digest(payload["summary"])


def test_failed_sync_keeps_watermark(token_file, db_session):
    from contextlib import nullcontext

    def handler(request):
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        return httpx.Response(429)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(StravaError, match="rate limit"):
            sync_once(token_file, lambda: nullcontext(db_session), http=http)
    assert load_credentials(token_file).last_sync == 0


@pytest.mark.parametrize("start,expected", [("2026-10-23T06:59:59Z", 0), ("2026-10-23T07:00:00Z", 1)])
def test_fixed_cutoff_excludes_older_ride_and_includes_exact_midnight(token_file, db_session, start, expected):
    from contextlib import nullcontext

    credentials = load_credentials(token_file)
    credentials.import_after = int(datetime(2026, 10, 23, 7, tzinfo=UTC).timestamp())
    save_credentials(token_file, credentials)
    payload = ride()
    payload["activity"]["start_date"] = start
    payload["activity"]["start_date_local"] = (
        "2026-10-22T23:59:59Z" if expected == 0 else "2026-10-23T00:00:00Z"
    )

    def handler(request):
        if request.url.path.endswith("/athlete"):
            return httpx.Response(200, json={"id": 77})
        if request.url.path.endswith("/athlete/activities"):
            assert int(request.url.params["after"]) == credentials.import_after - 1
            return httpx.Response(200, json=[payload["summary"]] if request.url.params["page"] == "1" else [])
        if request.url.path.endswith("/streams"):
            return httpx.Response(200, json=payload["streams"])
        return httpx.Response(200, json=payload["activity"])

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        assert sync_once(token_file, lambda: nullcontext(db_session), http=http) == expected
    assert db_session.query(Workout).count() == expected


def test_worker_logs_failure_without_secrets(token_file, monkeypatch, caplog):
    from app import strava

    stop = Event()

    def fail(*args, **kwargs):
        stop.set()
        raise SQLAlchemyError("fake-secret in database error")

    monkeypatch.setattr(strava, "sync_once", fail)
    run_sync(stop, token_file, 900, None)
    assert "Strava sync failed" in caplog.text
    assert "fake-secret" not in caplog.text


def test_simultaneous_pull_is_rejected(token_file):
    from app import strava

    assert strava._sync_lock.acquire(blocking=False)
    try:
        with httpx.Client() as http:
            with pytest.raises(StravaBusy, match="already running"):
                sync_once(token_file, None, http=http)
    finally:
        strava._sync_lock.release()


@pytest.mark.parametrize("scope", ["read,activity:read_all", "read"])
@pytest.mark.parametrize("days", [0, 90])
def test_authorization_callback_state_and_scope(tmp_path, monkeypatch, scope, days):
    from threading import Thread
    from urllib.parse import parse_qs, urlencode, urlsplit

    from scripts import authorize_strava

    threads = []
    statuses = []
    path = tmp_path / "tokens.json"
    monkeypatch.setattr("builtins.input", lambda prompt: "42")
    monkeypatch.setattr(authorize_strava.getpass, "getpass", lambda prompt: "private-client-secret")
    monkeypatch.setattr(authorize_strava, "request_json", lambda *args, **kwargs: {
        "access_token": "new-access", "refresh_token": "new-refresh",
        "expires_at": int(datetime.now(UTC).timestamp()) + 3600, "athlete": {"id": 77},
    })

    def open_browser(url):
        query = parse_qs(urlsplit(url).query)

        def send_callback():
            base = query["redirect_uri"][0]
            for state in ["wrong-state", query["state"][0]]:
                callback = base + "?" + urlencode({"state": state, "scope": scope, "code": "private-code"})
                statuses.append(httpx.get(callback, timeout=10, trust_env=False).status_code)

        thread = Thread(target=send_callback)
        threads.append(thread)
        thread.start()
        return True

    monkeypatch.setattr(authorize_strava.webbrowser, "open", open_browser)
    if "activity:read_all" in scope:
        authorize_strava.authorize(path, days)
        credentials = load_credentials(path)
        assert credentials.athlete_id == 77
        assert credentials.refresh_token == "new-refresh"
        expected = (
            int(datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
            if days == 0 else int(datetime.now(UTC).timestamp()) - days * 86400
        )
        assert abs(credentials.import_after - expected) < 5
    else:
        with pytest.raises(StravaError, match="permission missing"):
            authorize_strava.authorize(path, days)
        assert not path.exists()
    for thread in threads:
        thread.join(timeout=10)
        assert not thread.is_alive()
    assert statuses == [400, 200]


def test_ride_and_raw_event_roll_back_together(db_session, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=db_session.get_bind(), autoflush=False, expire_on_commit=False)
    with factory() as db:
        def fail_commit():
            db.flush()
            raise SQLAlchemyError("simulated commit failure")

        monkeypatch.setattr(db, "commit", fail_commit)
        with pytest.raises(SQLAlchemyError):
            persist_strava_event(ride(), db)
    assert db_session.query(Workout).count() == 0
    assert db_session.query(RawIngestEvent).count() == 0


def power_ride(watts=210.5, cadence=88.0):
    payload = ride()
    payload["activity"]["average_watts"] = watts
    payload["activity"]["average_cadence"] = cadence
    return payload


def set_weight(db, kg):
    profile = db.get(AthleteProfile, 1)
    if profile is None:
        db.add(AthleteProfile(id=1, weight_kg=kg, updated_utc=datetime(2026, 11, 13)))
    else:
        profile.weight_kg = kg
    db.commit()


def test_parse_power_and_cadence():
    workout = parse_strava_payload(power_ride()).workouts[0]
    assert workout.average_watts == 210.5
    assert workout.average_cadence == 88.0
    assert parse_strava_payload(ride()).workouts[0].average_watts is None


@pytest.mark.parametrize("key", ["average_watts", "average_cadence"])
def test_reject_negative_power_or_cadence(key):
    payload = power_ride()
    payload["activity"][key] = -1
    with pytest.raises(StravaError):
        parse_strava_payload(payload)


def test_watts_per_kg_is_set_once_and_survives_weight_changes(db_session):
    set_weight(db_session, 84.2)
    persist_strava_event(power_ride(), db_session)
    workout = db_session.get(Workout, "strava:123")
    assert (workout.average_watts, workout.average_cadence, workout.watts_per_kg) == (210.5, 88.0, 2.5)

    set_weight(db_session, 80.0)
    changed = power_ride(watts=220.0)
    changed["summary"]["distance"] = 2001
    persist_strava_event(changed, db_session)
    persist_payload(parse_strava_payload(changed), db_session, ingest_source="strava")
    db_session.commit()
    workout = db_session.get(Workout, "strava:123")
    assert workout.average_watts == 220.0
    assert workout.watts_per_kg == 2.5


def test_watts_per_kg_waits_for_a_weight_and_handles_zero_power(db_session):
    persist_strava_event(power_ride(watts=0.0), db_session)
    assert db_session.get(Workout, "strava:123").watts_per_kg is None
    set_weight(db_session, 84.2)
    persist_payload(parse_strava_payload(power_ride(watts=0.0)), db_session, ingest_source="strava")
    db_session.commit()
    assert db_session.get(Workout, "strava:123").watts_per_kg == 0.0


def test_health_workouts_have_no_power_fields(db_session):
    parsed = parse_workout({"id": "apple-1", "name": "Outdoor Walk", "start": "2026-10-23 08:00:00 -0700",
                            "end": "2026-10-23 08:30:00 -0700", "duration": 1800})
    set_weight(db_session, 84.2)
    persist_payload(ParsedPayload(workouts=[parsed]), db_session)
    db_session.commit()
    workout = db_session.get(Workout, "apple-1")
    assert (workout.average_watts, workout.average_cadence, workout.watts_per_kg) == (None, None, None)
