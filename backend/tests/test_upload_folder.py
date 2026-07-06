"""Unit tests for the folder-watch ingest client (scripts/upload_folder.py)."""
import json
import os
import time
import zipfile

import pytest
from scripts import upload_folder


def _make_zip(path: str, payload: dict) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("HealthAutoExport.json", json.dumps(payload))


def test_extract_json_from_zip(tmp_path):
    z = tmp_path / "export.zip"
    _make_zip(str(z), {"data": {"workouts": []}})
    raw = upload_folder.extract_json_from_zip(str(z))
    assert raw is not None
    assert json.loads(raw) == {"data": {"workouts": []}}


def test_extract_json_from_zip_without_json_returns_none(tmp_path):
    z = tmp_path / "nojson.zip"
    with zipfile.ZipFile(str(z), "w") as zf:
        zf.writestr("route.gpx", "<gpx/>")
    assert upload_folder.extract_json_from_zip(str(z)) is None


def test_scan_moves_processed_file_to_custom_archive(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    watch.mkdir()
    z = watch / "export.zip"
    _make_zip(str(z), {"data": {}})
    # Make the file old enough to pass the min-age guard.
    old = time.time() - 3600
    os.utime(str(z), (old, old))

    posted: list[str] = []

    def fake_post(api_url, token, raw_json):
        posted.append(raw_json)
        return {"status": "ok"}

    monkeypatch.setattr(upload_folder, "post_payload", fake_post)

    n = upload_folder.scan_once(str(watch), "http://x", "t", archive_name="processed")

    assert n == 1
    assert len(posted) == 1
    # Original moved into the custom subfolder; not left in the watch dir.
    assert not z.exists()
    assert (watch / "processed" / "export.zip").exists()


def test_scan_skips_files_newer_than_min_age(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    watch.mkdir()
    z = watch / "fresh.zip"
    _make_zip(str(z), {"data": {}})  # just written -> "too fresh"

    monkeypatch.setattr(
        upload_folder,
        "post_payload",
        lambda *a, **k: pytest.fail("should not POST a still-syncing file"),
    )

    n = upload_folder.scan_once(
        str(watch), "http://x", "t", archive_name="processed", min_age_seconds=999
    )

    assert n == 0
    assert z.exists()  # left in place for a later poll


def test_scan_ignores_the_archive_subfolder(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    (watch / "processed").mkdir(parents=True)
    monkeypatch.setattr(upload_folder, "post_payload", lambda *a, **k: {"status": "ok"})
    # No processable files -> zero, and no crash on the archive dir.
    assert upload_folder.scan_once(str(watch), "http://x", "t", archive_name="processed") == 0


def test_failed_post_leaves_file_in_place(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    watch.mkdir()
    z = watch / "export.zip"
    _make_zip(str(z), {"data": {}})
    old = time.time() - 3600
    os.utime(str(z), (old, old))

    def boom(*a, **k):
        raise RuntimeError("500")

    monkeypatch.setattr(upload_folder, "post_payload", boom)

    n = upload_folder.scan_once(str(watch), "http://x", "t", archive_name="processed")

    assert n == 0
    assert z.exists()  # not moved on failure
    assert not (watch / "processed" / "export.zip").exists()


def test_poison_pill_without_json_is_quarantined(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    watch.mkdir()
    z = watch / "nojson.zip"
    with zipfile.ZipFile(str(z), "w") as zf:
        zf.writestr("route.gpx", "<gpx/>")  # no JSON inside -> unprocessable
    old = time.time() - 3600
    os.utime(str(z), (old, old))

    monkeypatch.setattr(
        upload_folder, "post_payload", lambda *a, **k: pytest.fail("should not POST")
    )

    n = upload_folder.scan_once(str(watch), "http://x", "t")

    assert n == 0
    assert not z.exists()  # moved out of the watch dir
    assert (watch / "_failed" / "nojson.zip").exists()


def test_client_4xx_is_quarantined_but_5xx_retries(tmp_path, monkeypatch):
    import urllib.error

    watch = tmp_path / "gdrive"
    watch.mkdir()
    bad = watch / "bad.zip"
    _make_zip(str(bad), {"data": {}})
    old = time.time() - 3600
    os.utime(str(bad), (old, old))

    def client_error(*a, **k):
        raise urllib.error.HTTPError("http://x", 400, "Bad Request", {}, None)

    monkeypatch.setattr(upload_folder, "post_payload", client_error)
    assert upload_folder.scan_once(str(watch), "http://x", "t") == 0
    assert not bad.exists()
    assert (watch / "_failed" / "bad.zip").exists()

    # A 5xx is transient and must be left in place to retry.
    srv = watch / "srv.zip"
    _make_zip(str(srv), {"data": {}})
    os.utime(str(srv), (old, old))

    def server_error(*a, **k):
        raise urllib.error.HTTPError("http://x", 503, "Unavailable", {}, None)

    monkeypatch.setattr(upload_folder, "post_payload", server_error)
    assert upload_folder.scan_once(str(watch), "http://x", "t") == 0
    assert srv.exists()  # left for a later poll
    assert not (watch / "_failed" / "srv.zip").exists()


def test_scan_ignores_the_failed_subfolder(tmp_path, monkeypatch):
    watch = tmp_path / "gdrive"
    (watch / "_failed").mkdir(parents=True)
    monkeypatch.setattr(upload_folder, "post_payload", lambda *a, **k: {"status": "ok"})
    assert upload_folder.scan_once(str(watch), "http://x", "t") == 0
