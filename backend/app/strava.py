"""Personal Strava sync. Virtual routes drive maps; distance streams drive splits."""
from __future__ import annotations

import json
import logging
import math
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event, Lock
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .geo import DistanceSample, HrSample, RoutePoint
from .models import RawIngestEvent, Workout
from .normalize import ParsedPayload, build_workout, payload_hash, persist_payload
from .timeutil import utcnow

logger = logging.getLogger("fittrack.strava")
API_URL = "https://www.strava.com/api/v3"
OAUTH_URL = "https://www.strava.com/oauth/token"
_sync_lock = Lock()


class StravaError(RuntimeError):
    """Safe to log: never contains credentials or response bodies."""


class StravaBusy(StravaError):
    """Another scheduled or manual pull is already running."""


class Credentials(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)
    client_id: int = Field(gt=0)
    client_secret: str = Field(min_length=1, repr=False)
    access_token: str = Field(min_length=1, repr=False)
    refresh_token: str = Field(min_length=1, repr=False)
    expires_at: int
    athlete_id: int = Field(gt=0)
    import_after: int
    last_sync: int = 0


def load_credentials(path: Path) -> Credentials:
    try:
        return Credentials.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as exc:
        raise StravaError("Cannot read Strava credentials; run the authorization helper.") from exc


def save_credentials(path: Path, credentials: Credentials) -> None:
    # The parent directory must already have its private ACL. Atomic replacement
    # preserves the previous refresh token if writing the replacement fails.
    temporary = path.with_suffix(".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(credentials.model_dump_json())
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    except OSError as exc:
        raise StravaError("Cannot save Strava credentials; check the private directory permissions.") from exc
    finally:
        temporary.unlink(missing_ok=True)


def request_json(client: httpx.Client, method: str, url: str, **kwargs: Any) -> Any:
    try:
        response = client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        raise StravaError("Strava network request failed; the next sync will retry.") from exc
    if response.status_code == 429:
        raise StravaError("Strava rate limit reached; the next sync will retry.")
    if response.status_code in (401, 403):
        raise StravaError("Strava authorization failed; reauthorize with activity:read_all access.")
    if not response.is_success:
        raise StravaError(f"Strava returned HTTP {response.status_code}; the next sync will retry.")
    try:
        return response.json()
    except ValueError as exc:
        raise StravaError("Strava returned invalid JSON.") from exc


class StravaClient:
    def __init__(self, path: Path, http: httpx.Client):
        self.path = path
        self.http = http
        self.credentials = load_credentials(path)

    def get(self, endpoint: str, **params: Any) -> Any:
        if self.credentials.expires_at <= int(datetime.now(UTC).timestamp()) + 300:
            result = request_json(
                self.http, "POST", OAUTH_URL,
                data={
                    "client_id": self.credentials.client_id,
                    "client_secret": self.credentials.client_secret,
                    "grant_type": "refresh_token",
                    "refresh_token": self.credentials.refresh_token,
                },
            )
            try:
                refreshed = self.credentials.model_copy()
                refreshed.access_token = result["access_token"]
                refreshed.refresh_token = result["refresh_token"]
                refreshed.expires_at = result["expires_at"]
                refreshed = Credentials.model_validate(refreshed.model_dump())
            except (KeyError, TypeError, ValidationError) as exc:
                raise StravaError("Strava returned an invalid token refresh response.") from exc
            save_credentials(self.path, refreshed)
            self.credentials = refreshed
        return request_json(
            self.http, "GET", f"{API_URL}/{endpoint}",
            params=params,
            headers={"Authorization": f"Bearer {self.credentials.access_token}"},
        )


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise StravaError(f"Strava returned an invalid {field}.")
    return float(value)


def _optional_number(activity: dict, key: str) -> float | None:
    value = activity.get(key)
    return None if value is None else _number(value, key)


def is_zwift_ride(activity: dict) -> bool:
    device = activity.get("device_name")
    return (
        activity.get("sport_type", activity.get("type")) == "VirtualRide"
        and isinstance(device, str)
        and "zwift" in device.casefold()
    )


def parse_strava_payload(payload: dict) -> ParsedPayload:
    activity = payload["activity"]
    summary = payload.get("summary")
    if not isinstance(summary, dict) or summary.get("id") != activity.get("id"):
        raise StravaError("Strava payload must contain the matching activity summary.")
    if not is_zwift_ride(activity):
        raise StravaError("Activity is not a Zwift virtual ride.")
    activity_id = activity.get("id")
    if not isinstance(activity_id, int) or isinstance(activity_id, bool) or activity_id <= 0:
        raise StravaError("Strava returned an invalid activity ID.")
    try:
        start = datetime.fromisoformat(activity["start_date"].replace("Z", "+00:00"))
        local = datetime.fromisoformat(activity["start_date_local"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise StravaError("Strava returned an invalid ride start time.") from exc
    if start.tzinfo is None:
        raise StravaError("Strava ride start time has no timezone.")
    start_utc = start.astimezone(UTC).replace(tzinfo=None)
    offset = int((local.replace(tzinfo=None) - start_utc).total_seconds() / 60)
    if abs(offset) > 14 * 60:
        raise StravaError("Strava returned an invalid local timezone offset.")
    duration = _number(activity.get("elapsed_time"), "elapsed_time")
    distance = _number(activity.get("distance"), "distance")
    if duration < 0 or distance < 0:
        raise StravaError("Strava returned a negative ride duration or distance.")
    streams = payload.get("streams", {})
    times = streams.get("time", {}).get("data", [])
    hr = streams.get("heartrate", {}).get("data", [])
    distances = streams.get("distance", {}).get("data", [])
    coordinates = streams.get("latlng", {}).get("data", [])
    if any(values and len(values) != len(times) for values in (hr, distances, coordinates)):
        raise StravaError("Strava ride streams have mismatched lengths.")
    seconds = [_number(t, "stream time") for t in times]
    if any(t < 0 or t > duration for t in seconds) or any(
        b <= a for a, b in zip(seconds, seconds[1:], strict=False)
    ):
        raise StravaError("Strava ride stream times are out of order or outside the ride.")
    hr_samples = [
        HrSample(start_utc + timedelta(seconds=t), _number(bpm, "heart rate"))
        for t, bpm in zip(seconds, hr, strict=False)
    ]
    distance_values = [_number(d, "stream distance") for d in distances]
    if any(d < 0 for d in distance_values) or any(
        b < a for a, b in zip(distance_values, distance_values[1:], strict=False)
    ):
        raise StravaError("Strava ride stream distance decreases or is negative.")
    samples = [
        DistanceSample(
            start_utc + timedelta(seconds=seconds[i - 1]),
            start_utc + timedelta(seconds=seconds[i]),
            distance_values[i] - distance_values[i - 1],
        )
        for i in range(1, len(distance_values))
    ]
    route = []
    for t, coordinate in zip(seconds, coordinates, strict=False):
        if not isinstance(coordinate, list) or len(coordinate) != 2:
            raise StravaError("Strava returned an invalid route coordinate.")
        lat, lon = (_number(value, "route coordinate") for value in coordinate)
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise StravaError("Strava returned an out-of-range route coordinate.")
        route.append(RoutePoint(start_utc + timedelta(seconds=t), lat, lon))
    workout = build_workout(
        raw_type="Indoor Cycling", workout_id=f"strava:{activity_id}",
        start_utc=start_utc, end_utc=start_utc + timedelta(seconds=duration),
        tz_offset_minutes=offset, source_name="Strava", device_name=activity["device_name"][:120],
        duration_sec=duration, distance_m=distance,
        active_energy_kcal=_optional_number(activity, "calories"),
        avg_hr=_optional_number(activity, "average_heartrate"),
        max_hr=_optional_number(activity, "max_heartrate"), min_hr=None,
        hr_samples=hr_samples, distance_samples=samples, route=route,
    )
    return ParsedPayload(workouts=[workout])


def persist_strava_event(payload: dict, db: Session) -> dict[str, int]:
    parsed = parse_strava_payload(payload)
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = summary_digest(payload["summary"])
    existing = db.scalar(select(RawIngestEvent).where(RawIngestEvent.payload_hash == digest))
    workout = db.get(Workout, parsed.workouts[0].uuid)
    if (
        existing is not None and existing.status == "processed" and existing.processed_utc is not None
        and (workout is None or workout.updated_utc <= existing.processed_utc)
    ):
        return {"workouts": 0, "daily_metrics": 0, "splits": 0, "route_points_dropped": 0}
    event = existing or RawIngestEvent(
        source="strava", received_utc=utcnow(), payload_hash=digest,
        payload_json=text, status="received",
    )
    db.add(event)
    event.payload_json = text
    counts = persist_payload(parsed, db, ingest_source="strava")
    event.status = "processed"
    event.processed_utc = utcnow()
    db.commit()
    return counts


def summary_digest(summary: dict) -> str:
    # Refresh pre-route imports once, even when Strava's summary is unchanged.
    return payload_hash("strava:routes-v1:" + json.dumps(summary, sort_keys=True, separators=(",", ":")))


def sync_once(path: Path, session_factory, *, http: httpx.Client, stop: Event | None = None) -> int:
    if not _sync_lock.acquire(blocking=False):
        raise StravaBusy("A Strava pull is already running. Please try again shortly.")
    try:
        return _sync_once(path, session_factory, http=http, stop=stop)
    finally:
        _sync_lock.release()


def _sync_once(path: Path, session_factory, *, http: httpx.Client, stop: Event | None = None) -> int:
    logger.info("Strava sync starting")
    client = StravaClient(path, http)
    started = int(datetime.now(UTC).timestamp())
    athlete = client.get("athlete")
    if not isinstance(athlete, dict) or athlete.get("id") != client.credentials.athlete_id:
        raise StravaError("Strava account differs from the authorized account; reauthorize.")
    after = max(client.credentials.import_after, client.credentials.last_sync - 7 * 86400)
    imported = 0
    page = 1
    while True:
        if stop is not None and stop.is_set():
            return imported
        activities = client.get("athlete/activities", after=after - 1, before=started, per_page=100, page=page)
        if not isinstance(activities, list):
            raise StravaError("Strava returned an invalid activity list.")
        if not activities:
            break
        for summary in activities:
            if stop is not None and stop.is_set():
                return imported
            if not isinstance(summary, dict):
                raise StravaError("Strava returned an invalid activity summary.")
            if summary.get("sport_type", summary.get("type")) != "VirtualRide":
                continue
            activity_id = summary.get("id")
            if not isinstance(activity_id, int) or isinstance(activity_id, bool) or activity_id <= 0:
                raise StravaError("Strava returned an invalid activity ID.")
            # Hash the summary before fetching detail/streams to avoid repeatedly
            # downloading unchanged rides during the rolling 7-day window.
            with session_factory() as db:
                previous = db.scalar(
                    select(RawIngestEvent).where(
                        RawIngestEvent.payload_hash == summary_digest(summary),
                        RawIngestEvent.source == "strava", RawIngestEvent.status == "processed",
                    )
                )
                if previous is not None:
                    workout = db.get(Workout, f"strava:{activity_id}")
                    if previous.processed_utc is not None and (
                        workout is None or workout.updated_utc <= previous.processed_utc
                    ):
                        continue
            activity = client.get(f"activities/{activity_id}")
            if not isinstance(activity, dict):
                raise StravaError("Strava returned invalid activity details.")
            if activity.get("id") != activity_id:
                raise StravaError("Strava returned details for a different activity.")
            if not is_zwift_ride(activity):
                logger.info("Skipping non-Zwift virtual ride %s", activity_id)
                continue
            parsed = parse_strava_payload({"summary": summary, "activity": activity})
            ride_start = parsed.workouts[0].start_utc.replace(tzinfo=UTC).timestamp()
            if ride_start < client.credentials.import_after:
                logger.info("Skipping Strava activity %s before the configured import boundary", activity_id)
                continue
            streams = client.get(
                f"activities/{activity_id}/streams", keys="time,distance,heartrate,latlng", key_by_type="true",
            )
            if not isinstance(streams, dict):
                raise StravaError("Strava returned invalid ride streams.")
            with session_factory() as db:
                counts = persist_strava_event({"summary": summary, "activity": activity, "streams": streams}, db)
            imported += counts["workouts"]
            logger.info("Strava activity %s committed: %s workout(s)", activity_id, counts["workouts"])
        logger.info("Strava sync page %s complete; %s workout(s) imported", page, imported)
        page += 1
    client.credentials.last_sync = started
    save_credentials(path, client.credentials)
    logger.info("Strava sync complete: %s workout(s) imported", imported)
    return imported


def run_sync(stop: Event, path: Path, poll_seconds: int, session_factory) -> None:
    with httpx.Client(timeout=30, follow_redirects=False) as http:
        while not stop.is_set():
            try:
                sync_once(path, session_factory, http=http, stop=stop)
            except StravaBusy:
                logger.info("Scheduled Strava pull skipped; another pull is running.")
            except Exception as exc:  # worker must retry; never log tokens or health payloads
                logger.error(
                    "Strava sync failed (%s). %s", type(exc).__name__,
                    str(exc) if isinstance(exc, StravaError) else "See configuration and database availability.",
                )
            stop.wait(poll_seconds)
