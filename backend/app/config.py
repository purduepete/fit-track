"""Application configuration loaded from environment variables.

Reuses the existing webportfolio Azure SQL server; all fittrack tables live in
the ``fit`` schema of the WebPortfolio database.
"""
from datetime import date
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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

    # Reject ingest payloads larger than this (bytes) before parsing. The real
    # Health Auto Export daily export is a few MB; 25 MiB is a generous ceiling.
    max_ingest_bytes: int = 25 * 1024 * 1024

    # Where the built React app lives (served by FastAPI in production)
    static_dir: str = "static"

    # Athlete profile for VO2 max interpretation (age + sex are required to map a
    # VO2 max number to a fitness category). Optional: if unset, the dashboard
    # omits the interpretation and shows the bare value.
    athlete_birth_date: date | None = None
    athlete_sex: str = ""

    @property
    def sqlalchemy_url(self) -> str:
        encrypt = "yes" if self.db_encrypt else "no"
        driver = self.db_odbc_driver.replace(" ", "+")
        return (
            f"mssql+pyodbc://{self.db_user}:{self.db_password}"
            f"@{self.db_server}:1433/{self.db_name}"
            f"?driver={driver}&Encrypt={encrypt}&TrustServerCertificate=no"
            f"&Connection+Timeout=30"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
