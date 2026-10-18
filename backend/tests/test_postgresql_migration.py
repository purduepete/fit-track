"""Migration hashing must preserve data and leave subsequent writes usable."""
import hashlib
from datetime import datetime

from app.models import ApiToken
from scripts.migrate_postgresql import canonical, digest_table


def test_canonical_preserves_unicode_float_and_datetime():
    line = canonical(("Jim’s Watch", 0.20000000000000004, datetime(2026, 1, 2, 3, 4, 5), None))
    assert line == '["Jim’s Watch",0.20000000000000004,"2026-01-02T03:04:05.000000",null]'


def test_digest_does_not_enable_streaming_for_later_writes(db_session):
    connection = db_session.connection()
    before = dict(connection.get_execution_options())
    result = digest_table(connection, ApiToken.__table__)
    assert result["rows"] == 1
    assert len(result["sha256"]) == hashlib.sha256().digest_size * 2
    assert dict(connection.get_execution_options()) == before
    connection.execute(ApiToken.__table__.update().values(name="Still writable"))
