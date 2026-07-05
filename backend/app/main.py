"""fittrack API entrypoint.

Serves the JSON API under ``/api`` and, in production, the built React SPA as
static files. Interactive API docs are available at ``/docs`` (Swagger) and
``/redoc``.
"""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .routers import dashboard, ingest, workouts

settings = get_settings()

app = FastAPI(
    title="fittrack API",
    version="0.1.0",
    description="Apple Watch / Health workout tracker with mileage splits and route maps.",
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


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Unauthenticated liveness probe used by Azure Container Apps."""
    return {"status": "ok"}


# Serve the built SPA if present (production container).
_static = settings.static_dir
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
