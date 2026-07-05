"""SQLAlchemy engine / session setup for Azure SQL.

Supports two auth modes (``DB_AUTH``):

* ``sql`` (default) — username/password via the SQLAlchemy URL.
* ``aad`` — Azure AD access token via ``DefaultAzureCredential``, which uses the
  developer's ``az login`` locally and a managed identity when running in Azure.
  No password is stored or transmitted.
"""
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

# ODBC attribute id for a pre-authenticated SQL Server access token.
_SQL_COPT_SS_ACCESS_TOKEN = 1256

_ENGINE_KW = dict(pool_pre_ping=True, pool_size=5, max_overflow=5, fast_executemany=True)


def _build_engine():
    s = get_settings()
    if s.db_auth.lower() == "aad":
        import struct

        import pyodbc
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential(exclude_shared_token_cache_credential=True)
        encrypt = "yes" if s.db_encrypt else "no"
        conn_str = (
            f"DRIVER={{{s.db_odbc_driver}}};SERVER={s.db_server},1433;"
            f"DATABASE={s.db_name};Encrypt={encrypt};TrustServerCertificate=no;"
            "Connection Timeout=30"
        )

        def creator():
            token = credential.get_token("https://database.windows.net/.default").token
            raw = token.encode("utf-16-le")
            token_struct = struct.pack(f"<I{len(raw)}s", len(raw), raw)
            return pyodbc.connect(conn_str, attrs_before={_SQL_COPT_SS_ACCESS_TOKEN: token_struct})

        return create_engine("mssql+pyodbc://", creator=creator, **_ENGINE_KW)

    return create_engine(s.sqlalchemy_url, **_ENGINE_KW)


engine = _build_engine()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
