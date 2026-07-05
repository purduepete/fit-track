"""ORM models. All tables live in the ``fit`` schema of the WebPortfolio DB."""
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Unicode,
    UniqueConstraint,
)
from sqlalchemy import (
    DateTime as _SA_DateTime,
)
from sqlalchemy import (
    UnicodeText as _SA_UnicodeText,
)
from sqlalchemy.dialects import mssql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .config import get_settings

# Use modern SQL Server types on Azure SQL (DATETIME2 instead of the legacy
# DATETIME, and NVARCHAR(max) instead of the deprecated NTEXT) while falling
# back to the plain generic types on SQLite so the test suite is unaffected.
# A single type instance may safely be shared across many columns.
DateTime = _SA_DateTime().with_variant(mssql.DATETIME2, "mssql")
UnicodeText = _SA_UnicodeText().with_variant(mssql.NVARCHAR(None), "mssql")

# ``fit`` in production; tests set DB_SCHEMA="" to run on schemaless SQLite.
SCHEMA = get_settings().db_schema or None


def _fk(target: str) -> str:
    return f"{SCHEMA}.{target}" if SCHEMA else target


class Base(DeclarativeBase):
    pass


class ApiToken(Base):
    """Bearer tokens for ingest + dashboard access. Only the hash is stored."""

    __tablename__ = "api_tokens"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(Unicode(100), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    scope: Mapped[str] = mapped_column(String(20), nullable=False, default="all")  # all|ingest|read
    disabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_used_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class RawIngestEvent(Base):
    """Raw payloads are stored before normalization so parsing can be re-run."""

    __tablename__ = "raw_ingest_events"
    __table_args__ = {"schema": SCHEMA}

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    received_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    payload_json: Mapped[str] = mapped_column(UnicodeText, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="received")
    error: Mapped[str | None] = mapped_column(UnicodeText, nullable=True)
    processed_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Workout(Base):
    __tablename__ = "workouts"
    __table_args__ = (
        Index("ix_fit_workouts_start", "start_utc"),
        Index("ix_fit_workouts_type_date", "workout_type", "local_date"),
        {"schema": SCHEMA},
    )

    uuid: Mapped[str] = mapped_column(String(80), primary_key=True)
    workout_type: Mapped[str] = mapped_column(Unicode(60), nullable=False)
    source_name: Mapped[str | None] = mapped_column(Unicode(120), nullable=True)
    device_name: Mapped[str | None] = mapped_column(Unicode(120), nullable=True)

    start_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    tz_offset_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    local_date: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD (local)

    duration_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    active_energy_kcal: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_hr: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_hr: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_hr: Mapped[float | None] = mapped_column(Float, nullable=True)

    has_route: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    route_points: Mapped[list["WorkoutRoutePoint"]] = relationship(
        back_populates="workout", cascade="all, delete-orphan"
    )
    samples: Mapped[list["WorkoutSample"]] = relationship(
        back_populates="workout", cascade="all, delete-orphan"
    )
    splits: Mapped[list["WorkoutSplit"]] = relationship(
        back_populates="workout", cascade="all, delete-orphan"
    )


class WorkoutRoutePoint(Base):
    __tablename__ = "workout_route_points"
    __table_args__ = (
        Index("ix_fit_route_workout_seq", "workout_uuid", "seq"),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    workout_uuid: Mapped[str] = mapped_column(
        String(80), ForeignKey(_fk("workouts.uuid"), ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    ts_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    elevation_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed_mps: Mapped[float | None] = mapped_column(Float, nullable=True)

    workout: Mapped[Workout] = relationship(back_populates="route_points")


class WorkoutSample(Base):
    """Interval samples (heart_rate, distance, ...) tied to a workout."""

    __tablename__ = "workout_samples"
    __table_args__ = (
        Index("ix_fit_sample_workout_metric", "workout_uuid", "metric_type", "start_utc"),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    workout_uuid: Mapped[str] = mapped_column(
        String(80), ForeignKey(_fk("workouts.uuid"), ondelete="CASCADE"), nullable=False
    )
    metric_type: Mapped[str] = mapped_column(String(40), nullable=False)
    start_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    end_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str | None] = mapped_column(String(20), nullable=True)

    workout: Mapped[Workout] = relationship(back_populates="samples")


class WorkoutSplit(Base):
    """Computed per-unit (mile/km) splits."""

    __tablename__ = "workout_splits"
    __table_args__ = (
        UniqueConstraint("workout_uuid", "unit_system", "split_index", name="uq_fit_split"),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    workout_uuid: Mapped[str] = mapped_column(
        String(80), ForeignKey(_fk("workouts.uuid"), ondelete="CASCADE"), nullable=False
    )
    unit_system: Mapped[str] = mapped_column(String(4), nullable=False)  # mi|km
    split_index: Mapped[int] = mapped_column(Integer, nullable=False)  # 1-based
    distance_m: Mapped[float] = mapped_column(Float, nullable=False)
    duration_sec: Mapped[float] = mapped_column(Float, nullable=False)
    pace_sec_per_unit: Mapped[float] = mapped_column(Float, nullable=False)
    avg_hr: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(10), nullable=False)  # gps|sample

    workout: Mapped[Workout] = relationship(back_populates="splits")


class DailyMetric(Base):
    __tablename__ = "daily_metrics"
    __table_args__ = (
        UniqueConstraint("local_date", "metric_type", "source_name", name="uq_fit_daily"),
        Index("ix_fit_daily_type_date", "metric_type", "local_date"),
        {"schema": SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    local_date: Mapped[str] = mapped_column(String(10), nullable=False)
    metric_type: Mapped[str] = mapped_column(String(40), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source_name: Mapped[str | None] = mapped_column(Unicode(120), nullable=True)
    updated_utc: Mapped[datetime] = mapped_column(DateTime, nullable=False)


