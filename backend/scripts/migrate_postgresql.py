"""Explicit, create-only migration. Snapshot files contain private health data.

Export reads only the fit schema. Import requires an empty dedicated fittrack DB.
Compare reads every column of every row in primary-key order.
"""
import argparse
import gzip
import hashlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from app.db import engine
from app.models import Base
from sqlalchemy import BigInteger, DateTime, Integer, LargeBinary, func, select, text


def canonical(row):
    return json.dumps(
        list(row),
        default=lambda value: value.isoformat(timespec="microseconds"),
        ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    )


def digest_table(connection, table, output=None):
    digest = hashlib.sha256()
    count = 0
    compressed = connection.dialect.name == "mssql" and table.name == "raw_ingest_events"
    columns = [
        func.compress(column, type_=LargeBinary).label(column.name)
        if compressed and column.name == "payload_json" else column
        for column in table.columns
    ]
    heartbeat = time.monotonic()
    for row in connection.execute(
        select(*columns).order_by(*table.primary_key.columns).execution_options(
            stream_results=True, yield_per=1, max_row_buffer=1
        )
    ):
        if compressed:
            row = list(row)
            index = list(table.columns.keys()).index("payload_json")
            row[index] = gzip.decompress(row[index]).decode("utf-16-le")
        line = canonical(row) + "\n"
        digest.update(line.encode("utf-8"))
        if output:
            output.write(line)
        count += 1
        if time.monotonic() - heartbeat >= 10:
            print(f"{table.name}: {count} rows processed", file=sys.stderr, flush=True)
            heartbeat = time.monotonic()
    return {"rows": count, "sha256": digest.hexdigest()}


def export(destination):
    destination.mkdir(parents=True, exist_ok=False)
    report = {}
    with engine.connect().execution_options(isolation_level="SERIALIZABLE") as connection:
        with connection.begin():
            for table in Base.metadata.sorted_tables:
                with gzip.open(destination / f"{table.name}.jsonl.gz", "wt", encoding="utf-8", newline="\n") as output:
                    report[table.name] = digest_table(connection, table, output)
                print(table.name, report[table.name]["rows"], flush=True)
    (destination / "manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


def load(destination):
    if engine.url.get_backend_name() != "postgresql" or engine.url.database != "fittrack":
        raise RuntimeError("Import is restricted to the dedicated fittrack PostgreSQL database")
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            if connection.execute(select(table).limit(1)).first():
                raise RuntimeError(f"Import requires empty tables: {table.name}")
        for table in Base.metadata.sorted_tables:
            batch = []
            batch_size = 1 if table.name == "raw_ingest_events" else 500
            digest = hashlib.sha256()
            count = 0
            with gzip.open(destination / f"{table.name}.jsonl.gz", "rt", encoding="utf-8") as source:
                for line in source:
                    digest.update(line.encode("utf-8"))
                    values = json.loads(line)
                    row = dict(zip(table.columns.keys(), values, strict=True))
                    for column in table.columns:
                        if row[column.name] is not None and isinstance(column.type, DateTime):
                            row[column.name] = datetime.fromisoformat(row[column.name])
                    batch.append(row)
                    count += 1
                    if len(batch) == batch_size:
                        connection.execute(table.insert(), batch)
                        batch = []
                if batch:
                    connection.execute(table.insert(), batch)
            if {"rows": count, "sha256": digest.hexdigest()} != manifest[table.name]:
                raise RuntimeError(f"Snapshot hash mismatch: {table.name}")
            for column in table.primary_key.columns:
                if isinstance(column.type, (Integer, BigInteger)) and column.autoincrement:
                    sequence = connection.execute(
                        text("SELECT pg_get_serial_sequence(:table, :column)"),
                        {"table": table.fullname, "column": column.name},
                    ).scalar()
                    if sequence:
                        maximum = connection.execute(select(func.max(column))).scalar()
                        connection.execute(
                            text("SELECT setval(:sequence, :maximum, :called)"),
                            {"sequence": sequence, "maximum": maximum or 1, "called": count > 0},
                        )
            actual = digest_table(connection, table)
            if actual != manifest[table.name]:
                raise RuntimeError(f"Imported row mismatch: {table.name}")
            print(table.name, actual["rows"], "verified", flush=True)


def compare(destination):
    expected = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    with engine.connect() as connection:
        actual = {table.name: digest_table(connection, table) for table in Base.metadata.sorted_tables}
    if actual != expected:
        raise RuntimeError("Direct database comparison failed")
    print(json.dumps({"status": "Compared", "tables": actual}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["export", "load", "compare"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    {"export": export, "load": load, "compare": compare}[args.action](args.directory)
