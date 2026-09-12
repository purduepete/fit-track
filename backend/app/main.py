"""fittrack API entrypoint.

Serves the JSON API under ``/api`` and, in production, the built React SPA as
static files. Interactive API docs are available at ``/docs`` (Swagger) and
``/redoc``.
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .config import get_settings
from .db import SessionLocal
from .routers import dashboard, ingest, workouts

logger = logging.getLogger("fittrack")

settings = get_settings()


def _prewarm_db() -> None:
    """Open one pooled DB connection at startup so the first user request does
    not pay the Azure AD token acquisition + ODBC connect cost (a significant
    slice of perceived cold-start latency).

    Only runs for the ``aad`` auth path (production / Azure), so the test suite
    and password-based local runs are unaffected. Best-effort: any failure is
    logged and never blocks application startup.
    """
    if settings.db_auth.lower() != "aad":
        return
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        logger.info("DB pre-warm succeeded")
    except Exception as exc:  # pragma: no cover - best effort, never blocks boot
        logger.warning("DB pre-warm failed (continuing without it): %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _prewarm_db()
    yield


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
    """Unauthenticated liveness probe used by Azure Container Apps."""
    return {"status": "ok"}


# Serve the built SPA if present (production container).
_static = settings.static_dir
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
