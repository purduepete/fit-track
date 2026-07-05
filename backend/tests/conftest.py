"""Shared pytest fixtures.

DB_SCHEMA is cleared *before* importing any app module so the ORM models bind
to the default (schemaless) namespace, letting the suite run against in-memory
SQLite instead of Azure SQL.
"""
import os

os.environ.setdefault("DB_SCHEMA", "")
os.environ.setdefault("DB_PASSWORD", "test")

from app.timeutil import utcnow  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app import auth  # noqa: E402
from app.db import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import ApiToken, Base  # noqa: E402

TEST_TOKEN = "test-token-abc123"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = TestingSession()
    session.add(
        ApiToken(
            name="test",
            token_hash=auth.hash_token(TEST_TOKEN),
            scope="all",
            disabled=False,
            created_utc=utcnow(),
        )
    )
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def client(db_session):
    def _override():
        yield db_session

    app.dependency_overrides[get_db] = _override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {TEST_TOKEN}"}
