"""Daily pickup: ingest Health Auto Export zips/JSON dropped into a folder.

Intended workflow: Health Auto Export (iOS) auto-exports a dated ``.zip`` into a
synced cloud folder (Google Drive / iCloud Drive / Dropbox / OneDrive) that lands
on this PC — e.g. ``G:\\My Drive\\fittrack`` (Google Drive) or ``fittrack/upload``.
This script extracts the JSON payload (route, heart-rate and distance samples are
embedded inside it), POSTs it to the fittrack ingest API with your bearer token,
then moves processed archives into a subfolder (``--archive-name``, default
``_archive``) so they are ingested once. Files that can never succeed (corrupt
zip, a zip with no JSON, or a client 4xx from the API) are moved to a ``_failed``
subfolder so they aren't rescanned every poll; transient failures (server 5xx /
network) are left in place to retry.

A ``--min-age-seconds`` guard skips files that were modified very recently so a
file still downloading/syncing from the cloud isn't read mid-write.

Route/splits/map all derive from the embedded JSON, so the separate ``*.gpx``
files in the zip are ignored here.

Environment:
    FITTRACK_API_URL   e.g. http://127.0.0.1:8791
    FITTRACK_TOKEN     an ingest-scoped token (see New-IngestToken.ps1)

Usage:
    python -m scripts.upload_folder --dir ..\\upload
    python -m scripts.upload_folder --dir ..\\upload --once
    python -m scripts.upload_folder --dir "G:\\My Drive\\fittrack" --archive-name processed
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime

INGEST_PATH = "/api/ingest/health-auto-export"


def _log(msg: str) -> None:
    # flush=True so output is visible immediately even under pythonw.exe (no
    # console), where stdout would otherwise be block-buffered and never flush —
    # which previously hid ingest errors from the watcher log entirely.
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def extract_json_from_zip(zip_path: str) -> str | None:
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".json")]
        if not names:
            return None
        with zf.open(names[0]) as f:
            return f.read().decode("utf-8")


def post_payload(api_url: str, token: str, raw_json: str) -> dict:
    req = urllib.request.Request(
        api_url.rstrip("/") + INGEST_PATH,
        data=raw_json.encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    # A full ~35 MiB export (30 days of intraday points) can take several
    # minutes to deserialize + upsert on a cold, low-vCPU replica, so allow a
    # generous read timeout. Too short a timeout looks like a transient failure
    # and makes the watcher retry forever without ever completing.
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def process_file(path: str, api_url: str, token: str) -> bool:
    lower = path.lower()
    if lower.endswith(".zip"):
        raw = extract_json_from_zip(path)
    elif lower.endswith(".json"):
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    else:
        return False
    if raw is None:
        _log(f"SKIP (no JSON inside): {os.path.basename(path)}")
        return False
    result = post_payload(api_url, token, raw)
    _log(f"OK {os.path.basename(path)} -> {result}")
    return True


def _is_permanent_failure(exc: Exception) -> bool:
    """True for failures that will never succeed on retry (so quarantine).

    Corrupt/undecodable files and client (4xx) responses are permanent; server
    (5xx) errors and network/transient issues are left in place to retry.
    """
    if isinstance(exc, urllib.error.HTTPError):
        return 400 <= exc.code < 500
    return isinstance(exc, (zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError))


def prune_archive(archive: str, retention_days: int) -> int:
    """Delete files in the archive folder older than retention_days.

    Age is measured from the file's modified time. A retention_days <= 0
    disables pruning. Only the archive (processed) folder is touched — the
    _failed quarantine is left alone so failures stay visible.
    """
    if retention_days <= 0 or not os.path.isdir(archive):
        return 0
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for name in os.listdir(archive):
        full = os.path.join(archive, name)
        if not os.path.isfile(full):
            continue
        try:
            if os.path.getmtime(full) < cutoff:
                os.remove(full)
                removed += 1
                _log(f"PRUNED (>{retention_days}d) from {os.path.basename(archive)}: {name}")
        except OSError as exc:
            _log(f"ERROR pruning {name}: {exc}")
    return removed


def scan_once(
    folder: str,
    api_url: str,
    token: str,
    archive_name: str = "_archive",
    min_age_seconds: int = 15,
    failed_name: str = "_failed",
    retention_days: int = 0,
) -> int:
    archive = os.path.join(folder, archive_name)
    failed = os.path.join(folder, failed_name)
    os.makedirs(archive, exist_ok=True)
    now = time.time()
    processed = 0

    def quarantine(full: str, name: str, reason: str) -> None:
        os.makedirs(failed, exist_ok=True)
        try:
            shutil.move(full, os.path.join(failed, name))
            _log(f"QUARANTINE ({reason}) -> {failed_name}: {name}")
        except OSError as move_exc:
            _log(f"ERROR quarantining {name}: {move_exc}")

    for name in sorted(os.listdir(folder)):
        if name in (archive_name, failed_name):
            continue
        full = os.path.join(folder, name)
        if not os.path.isfile(full):
            continue
        if not name.lower().endswith((".zip", ".json")):
            continue
        # Skip files still being written / synced from the cloud (Google Drive):
        # only process once they've been stable for min_age_seconds.
        if min_age_seconds > 0 and (now - os.path.getmtime(full)) < min_age_seconds:
            _log(f"WAIT (too fresh, still syncing?): {name}")
            continue
        try:
            if process_file(full, api_url, token):
                shutil.move(full, os.path.join(archive, name))
                processed += 1
            else:
                # A .zip/.json with no usable JSON inside — a poison pill that
                # would otherwise be rescanned every poll. Quarantine it.
                quarantine(full, name, "no JSON inside")
        except Exception as exc:  # noqa: BLE001 - report and continue with next file
            if _is_permanent_failure(exc):
                quarantine(full, name, f"permanent: {exc}")
            else:
                # Transient (server 5xx / network) — leave in place to retry.
                _log(f"ERROR {name} (will retry): {exc}")
    prune_archive(archive, retention_days)
    return processed


def main() -> None:
    p = argparse.ArgumentParser(description="Ingest HAE exports from a folder")
    p.add_argument("--dir", required=True, help="Folder to watch for .zip/.json exports")
    p.add_argument("--once", action="store_true", help="Process current files then exit")
    p.add_argument("--interval", type=int, default=300, help="Poll seconds (watch mode)")
    p.add_argument(
        "--archive-name",
        default="_archive",
        help="Subfolder (inside --dir) processed files are moved to. Default: _archive",
    )
    p.add_argument(
        "--min-age-seconds",
        type=int,
        default=15,
        help="Skip files modified more recently than this (avoids reading a file still "
        "syncing from the cloud). Default: 15. Use 0 to disable.",
    )
    p.add_argument(
        "--retention-days",
        type=int,
        default=0,
        help="Delete files in the archive (processed) folder older than this many days "
        "each scan. Default: 0 (disabled). Only the archive folder is pruned; _failed "
        "is left alone.",
    )
    args = p.parse_args()

    api_url = os.environ.get("FITTRACK_API_URL")
    token = os.environ.get("FITTRACK_TOKEN")
    if not api_url or not token:
        sys.exit("Set FITTRACK_API_URL and FITTRACK_TOKEN environment variables.")

    folder = os.path.abspath(args.dir)
    if not os.path.isdir(folder):
        sys.exit(f"Folder not found: {folder}")

    _log(f"Watching {folder} -> {api_url}{INGEST_PATH} (archive={args.archive_name})")
    if args.once:
        n = scan_once(
            folder, api_url, token, args.archive_name, args.min_age_seconds,
            retention_days=args.retention_days,
        )
        _log(f"Done. Processed {n} file(s).")
        return
    while True:
        scan_once(
            folder, api_url, token, args.archive_name, args.min_age_seconds,
            retention_days=args.retention_days,
        )
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
