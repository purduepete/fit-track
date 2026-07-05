"""Create the ``fit`` schema and all fittrack tables in Azure SQL.

Idempotent: creates the schema if missing, then issues CREATE TABLE only for
tables that don't already exist. Safe to run repeatedly.

Usage:
    python -m scripts.init_db
"""
import sys

sys.path.insert(0, ".")

from sqlalchemy import text  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


def main() -> None:
    schema = get_settings().db_schema
    with engine.begin() as conn:
        conn.execute(
            text(
                f"IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '{schema}') "
                f"EXEC('CREATE SCHEMA [{schema}]')"
            )
        )
    Base.metadata.create_all(engine)
    print(f"Schema '{schema}' and tables are ready on {get_settings().db_name}.")


if __name__ == "__main__":
    main()
