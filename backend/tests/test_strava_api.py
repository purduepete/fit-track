from pathlib import Path

import pytest
from app.routers import strava
from app.strava import StravaBusy, StravaError


@pytest.fixture
def gateway(monkeypatch, tmp_path):
    from types import SimpleNamespace

    monkeypatch.setattr(strava, "get_settings", lambda: SimpleNamespace(
        gateway_read_auth=True, strava_token_file=str(tmp_path / "tokens.json"),
    ))


def test_pull_requires_authorization(client):
    assert client.post("/api/strava/pull", headers={"X-FitTrack-Sync": "1"}).status_code == 401


def test_gateway_pull_requires_csrf_header(client, gateway):
    assert client.post("/api/strava/pull").status_code == 403


def test_gateway_pull_uses_saved_configuration(client, gateway, monkeypatch):
    def sync(path, factory, *, http):
        assert isinstance(path, Path)
        return 1

    monkeypatch.setattr(strava, "sync_once", sync)
    response = client.post("/api/strava/pull", headers={"X-FitTrack-Sync": "1"})
    assert response.status_code == 200
    assert response.json() == {"workouts": 1}


@pytest.mark.parametrize("error,status", [
    (StravaBusy("Already running"), 409), (StravaError("Rate limit"), 502),
])
def test_pull_reports_safe_failures(client, gateway, monkeypatch, error, status):
    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(strava, "sync_once", fail)
    response = client.post("/api/strava/pull", headers={"X-FitTrack-Sync": "1"})
    assert response.status_code == status
    assert response.json()["detail"] == str(error)
