"""Daily pickup: ingest Health Auto Export zips/JSON dropped into a folder.

Intended workflow: Health Auto Export (iOS) auto-exports a dated ``.zip`` into
a synced folder (iCloud Drive / Dropbox / OneDrive) that lands here as
``fittrack/upload``. This script extracts the JSON payload (route, heart-rate
and distance samples are embedded inside it), POSTs it to the fittrack ingest
API with your bearer token, then moves processed archives into ``_archive``.

Route/splits/map all derive from the embedded JSON, so the separate ``*.gpx``
files in the zip are ignored here.

Environment:
    FITTRACK_API_URL   e.g. https://fittrack.<region>.azurecontainerapps.io
    FITTRACK_TOKEN     an ingest-scoped token (see New-IngestToken.ps1)

Usage:
    python -m scripts.upload_folder --dir ..\\upload
    python -m scripts.upload_folder --dir ..\\upload --once
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
import zipfile
from datetime import datetime

INGEST_PATH = "/api/ingest/health-auto-export"


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


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
    with urllib.request.urlopen(req, timeout=120) as resp:
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


def scan_once(folder: str, api_url: str, token: str) -> int:
    archive = os.path.join(folder, "_archive")
    os.makedirs(archive, exist_ok=True)
    processed = 0
    for name in sorted(os.listdir(folder)):
        full = os.path.join(folder, name)
        if not os.path.isfile(full):
            continue
        if not name.lower().endswith((".zip", ".json")):
            continue
        try:
            if process_file(full, api_url, token):
                shutil.move(full, os.path.join(archive, name))
                processed += 1
        except Exception as exc:  # noqa: BLE001 - report and continue with next file
            _log(f"ERROR {name}: {exc}")
    return processed


def main() -> None:
    p = argparse.ArgumentParser(description="Ingest HAE exports from a folder")
    p.add_argument("--dir", required=True, help="Folder to watch for .zip/.json exports")
    p.add_argument("--once", action="store_true", help="Process current files then exit")
    p.add_argument("--interval", type=int, default=300, help="Poll seconds (watch mode)")
    args = p.parse_args()

    api_url = os.environ.get("FITTRACK_API_URL")
    token = os.environ.get("FITTRACK_TOKEN")
    if not api_url or not token:
        sys.exit("Set FITTRACK_API_URL and FITTRACK_TOKEN environment variables.")

    folder = os.path.abspath(args.dir)
    if not os.path.isdir(folder):
        sys.exit(f"Folder not found: {folder}")

    _log(f"Watching {folder} -> {api_url}{INGEST_PATH}")
    if args.once:
        n = scan_once(folder, api_url, token)
        _log(f"Done. Processed {n} file(s).")
        return
    while True:
        scan_once(folder, api_url, token)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
