"""Environment configuration. DATABASE_URL points at the app's PostgreSQL database."""
from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchor the env file to the backend directory rather than the process working
# directory. A bare relative ".env" only loads when the process happens to start
# in backend/; from anywhere else pydantic silently falls back to the defaults.
_BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_BACKEND_DIR / ".env", extra="ignore")

    # postgresql+psycopg://<runtime role>:<password>@127.0.0.1:5432/fit_track
    database_url: str = ""
    db_schema: str = "public"
    # Enable only behind Cloudflare Access / private Tailscale with loopback binding.
    gateway_read_auth: bool = False
    strava_token_file: str = ""
    strava_poll_seconds: int = Field(default=900, ge=300)

    # Reject ingest payloads larger than this (bytes) before parsing. A full
    # 30-day Health Auto Export (all intraday step points, HR arrays and routes)
    # is ~35 MiB, so allow generous headroom.
    max_ingest_bytes: int = 64 * 1024 * 1024

    # Where the built React app lives (served by FastAPI in production)
    static_dir: str = "static"

    # Athlete profile for VO2 max interpretation (age + sex are required to map a
    # VO2 max number to a fitness category). Optional: if unset, the dashboard
    # omits the interpretation and shows the bare value.
    athlete_birth_date: date | None = None
    athlete_sex: str = ""

    @field_validator("athlete_birth_date", mode="before")
    @classmethod
    def _blank_birth_date_is_none(cls, v: object) -> object:
        # An unset ATHLETE_BIRTH_DATE arrives as an empty string from the
        # environment; treat blank as "not configured" (disables VO2 max
        # interpretation) rather than failing date parsing at startup.
        if isinstance(v, str) and v.strip() == "":
            return None
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
