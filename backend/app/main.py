"""fittrack API entrypoint.

Serves the JSON API under ``/api`` and, in production, the built React SPA as
static files. Interactive API docs are available at ``/docs`` (Swagger) and
``/redoc``.
"""
import logging
import os
from asyncio import to_thread
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, Thread
from typing import Literal

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select

from .auth import require_read
from .config import get_settings
from .db import SessionLocal
from .models import ApiToken
from .routers import dashboard, ingest, profile, strava, workouts
from .strava import run_sync

logger = logging.getLogger("fittrack")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = Event()
    worker = None
    if settings.strava_token_file:
        worker = Thread(
            target=run_sync,
            args=(stop, Path(settings.strava_token_file), settings.strava_poll_seconds, SessionLocal),
            name="strava-sync", daemon=True,
        )
        worker.start()
        logger.info("Strava sync enabled; interval %s seconds", settings.strava_poll_seconds)
    try:
        yield
    finally:
        stop.set()
        if worker is not None:
            await to_thread(worker.join)


app = FastAPI(
    title="Fit Track API",
    version="0.1.0",
    description="Apple Watch / Health workout tracker with mileage splits and route maps.",
    lifespan=lifespan,
)

# During local dev the React app runs on a separate Vite port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest.router)
app.include_router(workouts.router)
app.include_router(dashboard.router)
app.include_router(strava.router)
app.include_router(profile.router)


@app.middleware("http")
async def _revalidate_app_shell(request, call_next):
    """Serve the SW script and HTML shell with ``no-cache`` so a new deploy is
    picked up promptly (the browser revalidates instead of serving stale bytes
    from the HTTP cache). Content-hashed JS/CSS keep their default caching and
    are served from the service-worker precache."""
    response = await call_next(request)
    if request.url.path in ("/", "/index.html", "/sw.js"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Unauthenticated liveness probe (the public uptime check uses it)."""
    return {"status": "ok"}


@app.get("/api/auth-mode", tags=["meta"])
def auth_mode() -> dict:
    return {"gateway": settings.gateway_read_auth}

class UnitPreference(BaseModel):
    unit: Literal["mi", "km"]


@app.post("/api/preferences/units", tags=["meta"], dependencies=[Depends(require_read)])
def save_unit(preference: UnitPreference, request: Request, response: Response) -> dict:
    response.set_cookie(
        "fittrack_unit", preference.unit, max_age=31536000, path="/",
        secure=request.url.scheme == "https", samesite="lax",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"unit": preference.unit}


SortKeyName = Literal[
    "date", "duration", "distance", "pace", "kcal", "hr", "maxhr", "power", "wkg", "cadence", "elev"
]


class WorkoutTablePreference(BaseModel):
    view: Literal["ride", "power", "all"]
    sort: SortKeyName
    order: Literal["asc", "desc"]


@app.post("/api/preferences/workouts-table", tags=["meta"], dependencies=[Depends(require_read)])
def save_workout_table(preference: WorkoutTablePreference, request: Request, response: Response) -> dict:
    """Mirror the Workouts view and sort in cookies; Safari can purge localStorage after sign-in."""
    secure = request.url.scheme == "https"
    for name, value in (
        ("fittrack_workout_view", preference.view),
        ("fittrack_workout_sort", f"{preference.sort}.{preference.order}"),
    ):
        response.set_cookie(name, value, max_age=31536000, path="/", secure=secure, samesite="lax")
    response.headers["Cache-Control"] = "no-store"
    return preference.model_dump()


@app.get("/api/ready", tags=["meta"])
def ready() -> dict:
    with SessionLocal() as db:
        db.execute(select(ApiToken.id).limit(1))
    return {"status": "ok"}


# Serve the built SPA if present (production container).
_static = settings.static_dir
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
