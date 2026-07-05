"""Time helpers.

The database stores canonical UTC as *naive* datetimes (SQL Server ``DATETIME2``
has no timezone). ``datetime.utcnow()`` is deprecated from Python 3.12, so this
helper returns the timezone-aware current UTC time stripped back to naive UTC,
preserving the existing storage convention without the deprecation warning.
"""
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Return the current UTC time as a naive datetime (tzinfo removed)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
