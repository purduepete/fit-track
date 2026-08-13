"""Application configuration loaded from environment variables.

Reuses the existing webportfolio Azure SQL server; all fittrack tables live in
the ``fit`` schema of the WebPortfolio database.
"""
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote_plus

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchor the env file to the backend directory rather than the process working
# directory. A bare relative ".env" only loads when the process happens to start
# in backend/; from anywhere else pydantic silently falls back to the field
# defaults, which means db_auth="sql" and an empty password, and the connection
# then fails with a bare "Login failed for user 'sqladmin'" that says nothing
# about the real cause.
_BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_BACKEND_DIR / ".env", extra="ignore")

    # Azure SQL connection (existing webportfolio server)
    db_server: str = "sqlgkhw25ijhyzzy.database.windows.net"
    db_name: str = "WebPortfolio"
    db_user: str = "sqladmin"
    db_password: str = ""
    db_encrypt: bool = True
    db_schema: str = "fit"
    db_odbc_driver: str = "ODBC Driver 18 for SQL Server"
    # "sql" = username/password; "aad" = Azure AD token (DefaultAzureCredential:
    # az login locally, managed identity in Azure — no password needed).
    db_auth: str = "sql"

    # Reject ingest payloads larger than this (bytes) before parsing. A full
    # 30-day Health Auto Export (all intraday step points, HR arrays and routes)
    # is ~35 MiB, so allow generous headroom; the container is sized (1 GiB) to
    # deserialize a body this large without OOM.
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

    @property
    def sqlalchemy_url(self) -> str:
        encrypt = "yes" if self.db_encrypt else "no"
        driver = self.db_odbc_driver.replace(" ", "+")
        # Credentials go into a URL, so anything with @ : / ? # % in it has to be
        # percent-encoded or the URL parses into the wrong host/password.
        user = quote_plus(self.db_user)
        password = quote_plus(self.db_password)
        return (
            f"mssql+pyodbc://{user}:{password}"
            f"@{self.db_server}:1433/{self.db_name}"
            f"?driver={driver}&Encrypt={encrypt}&TrustServerCertificate=no"
            f"&Connection+Timeout=30"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
