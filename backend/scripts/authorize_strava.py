"""Run in your own terminal. Secrets are prompted privately, never passed as arguments."""
from __future__ import annotations

import argparse
import getpass
import secrets
import time
import webbrowser
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from app.strava import OAUTH_URL, Credentials, StravaError, request_json, save_credentials
from pydantic import ValidationError


def authorize(token_file: Path, days: int) -> None:
    client_id = int(input("Strava Client ID: ").strip())
    client_secret = getpass.getpass("Strava Client Secret (hidden): ").strip()
    if client_id <= 0 or not client_secret:
        raise StravaError("A positive Client ID and a nonempty Client Secret are required.")
    state = secrets.token_urlsafe(32)
    result: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *args) -> None:
            pass  # The default logger would disclose the authorization code.

        def do_GET(self) -> None:  # noqa: N802 - HTTPServer method name
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            valid = (
                parsed.path == "/callback"
                and secrets.compare_digest(query.get("state", [""])[0], state)
            )
            if not valid:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Invalid authorization callback.")
                return
            scopes = set(query.get("scope", [""])[0].split(","))
            code = query.get("code", [""])[0]
            if query.get("error") or not code or "activity:read_all" not in scopes:
                result["error"] = "Authorization denied or activity:read_all permission missing."
            else:
                result["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Return to the FitTrack setup terminal. You can close this tab.")

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://localhost:{server.server_port}/callback"
        url = "https://www.strava.com/oauth/authorize?" + urlencode({
            "client_id": client_id, "response_type": "code", "redirect_uri": redirect,
            "approval_prompt": "force", "scope": "read,activity:read_all", "state": state,
        })
        print("Opening Strava. Approve access to your activities, including private activities.", flush=True)
        if not webbrowser.open(url):
            print(f"Open this authorization URL in your browser:\n{url}", flush=True)
        deadline = time.monotonic() + 300
        next_message = time.monotonic() + 30
        while not result and time.monotonic() < deadline:
            server.handle_request()
            if time.monotonic() >= next_message:
                print("Still waiting for Strava approval. Setup times out after 5 minutes.", flush=True)
                next_message += 30
    if not result:
        raise StravaError("Strava authorization timed out; rerun setup.")
    if "error" in result:
        raise StravaError(result["error"])
    with httpx.Client(timeout=30, follow_redirects=False) as http:
        token = request_json(http, "POST", OAUTH_URL, data={
            "client_id": client_id, "client_secret": client_secret,
            "code": result["code"], "grant_type": "authorization_code", "redirect_uri": redirect,
        })
    boundary = (
        int(datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        if days == 0 else int(datetime.now(UTC).timestamp()) - days * 86400
    )
    try:
        credentials = Credentials(
            client_id=client_id, client_secret=client_secret,
            access_token=token["access_token"], refresh_token=token["refresh_token"],
            expires_at=token["expires_at"], athlete_id=token["athlete"]["id"],
            import_after=boundary,
        )
    except (KeyError, TypeError, ValidationError) as exc:
        raise StravaError("Strava returned an invalid authorization response.") from exc
    save_credentials(token_file, credentials)
    print(f"Authorization saved privately. Import history: {'from today onward' if days == 0 else f'{days} days'}.",
          flush=True)
    print("No workouts have been imported yet.", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--days", type=int, choices=range(0, 366), default=0, metavar="0-365")
    args = parser.parse_args()
    if not args.token_file.parent.is_dir():
        parser.error("Use Connect-Strava.ps1 first to create a protected credential directory.")
    try:
        authorize(args.token_file, args.days)
    except (StravaError, ValueError) as exc:
        print(f"Setup failed: {exc if isinstance(exc, StravaError) else 'Client ID must be a number.'}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
