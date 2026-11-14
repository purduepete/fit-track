"""SQLAlchemy sessions for the app's PostgreSQL database.

Without DATABASE_URL the sessions are unbound, so readiness and any query fail
instead of falling back to another database.
"""
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

_url = get_settings().database_url
engine = create_engine(_url, pool_pre_ping=True, pool_size=5, max_overflow=5, hide_parameters=True) if _url else None

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
