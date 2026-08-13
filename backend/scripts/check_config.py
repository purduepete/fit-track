r"""Diagnose why settings aren't loading (no secret values are printed).

Run from anywhere:

    .\.venv\Scripts\python.exe -m scripts.check_config

Reports where the env file is expected, whether it parses, what would override
it, and the effective auth mode -- then optionally opens a connection. Written
after a machine move where a copied .env was present but silently ignored, and
the only symptom was "Login failed for user 'sqladmin'" (the field default),
which says nothing about the real cause.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings, _BACKEND_DIR  # noqa: E402

DB_KEYS = (
    "DB_SERVER",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "DB_SCHEMA",
    "DB_ENCRYPT",
    "DB_AUTH",
    "DB_ODBC_DRIVER",
)


def _detect_encoding(raw: bytes) -> str:
    if raw.startswith(b"\xff\xfe"):
        return "UTF-16 LE (BOM)"
    if raw.startswith(b"\xfe\xff"):
        return "UTF-16 BE (BOM)"
    if raw.startswith(b"\xef\xbb\xbf"):
        return "UTF-8 with BOM"
    # UTF-16 without a BOM shows up as interleaved NUL bytes.
    if b"\x00" in raw:
        return "contains NUL bytes (likely UTF-16 without BOM)"
    return "UTF-8 / ASCII"


def main() -> int:
    problems: list[str] = []

    print("== paths ==")
    print(f"cwd                 {Path.cwd()}")
    print(f"backend dir         {_BACKEND_DIR}")
    env_path = Path(Settings.model_config["env_file"])
    print(f"env_file            {env_path}")
    print(f"env_file exists     {env_path.exists()}")

    if not env_path.exists():
        problems.append(f"No file at {env_path}.")
        # A hidden-extensions save turns ".env" into ".env.txt".
        near = sorted(p.name for p in _BACKEND_DIR.glob(".env*"))
        print(f"similar names       {near or 'none'}")
        if ".env.txt" in near:
            problems.append("Found .env.txt -- Windows hid the extension on save. Rename it to .env.")
    else:
        raw = env_path.read_bytes()
        encoding = _detect_encoding(raw)
        print(f"env_file size       {len(raw)} bytes")
        print(f"env_file encoding   {encoding}")
        if encoding != "UTF-8 / ASCII":
            problems.append(
                f"Env file is {encoding}. python-dotenv expects UTF-8, so every line is "
                "misparsed and all settings silently fall back to their defaults."
            )
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-16", errors="replace")
        keys = [
            line.split("=", 1)[0].strip()
            for line in text.splitlines()
            if "=" in line and not line.lstrip().startswith("#")
        ]
        print(f"keys parsed         {len(keys)}: {', '.join(keys) or 'NONE'}")
        if not keys:
            problems.append("No KEY=VALUE lines parsed out of the env file.")

    print()
    print("== process environment (overrides the env file) ==")
    overrides = [k for k in DB_KEYS if k in os.environ]
    for k in overrides:
        shown = "<set>" if k == "DB_PASSWORD" else os.environ[k]
        print(f"{k:<20}{shown}")
    if not overrides:
        print("none")
    else:
        problems.append(
            "DB_* variables are set in the process environment: "
            + ", ".join(overrides)
            + ". Pydantic ranks these ABOVE the env file, so they win. Clear them "
            "(Remove-Item Env:DB_AUTH) and open a fresh terminal."
        )

    print()
    print("== effective settings ==")
    s = Settings()
    print(f"db_auth             {s.db_auth}")
    print(f"db_user             {s.db_user}")
    print(f"db_server           {s.db_server}")
    print(f"db_name             {s.db_name}")
    print(f"db_schema           {s.db_schema}")
    print(f"db_password         {'<set>' if s.db_password else '<EMPTY>'} (len {len(s.db_password)})")
    print(f"odbc driver         {s.db_odbc_driver}")

    if s.db_auth.lower() == "sql" and not s.db_password:
        problems.append(
            "db_auth is 'sql' with an empty password. These are the hardcoded field "
            "defaults, which means the env file was not applied. That combination "
            "produces exactly \"Login failed for user 'sqladmin'\"."
        )

    print()
    print("== driver ==")
    try:
        import pyodbc

        drivers = pyodbc.drivers()
        print(f"installed           {', '.join(drivers) or 'none'}")
        if s.db_odbc_driver not in drivers:
            problems.append(f"ODBC driver '{s.db_odbc_driver}' is not installed.")
    except Exception as exc:  # pragma: no cover - environment dependent
        problems.append(f"Could not query ODBC drivers: {exc}")

    if s.db_auth.lower() == "aad":
        print()
        print("== azure ad ==")
        try:
            from azure.identity import DefaultAzureCredential

            cred = DefaultAzureCredential(exclude_shared_token_cache_credential=True)
            token = cred.get_token("https://database.windows.net/.default")
            print(f"token acquired      yes (expires {token.expires_on})")
        except Exception as exc:
            problems.append(f"Could not get an Azure AD token: {type(exc).__name__}: {exc}")
            print(f"token acquired      NO ({type(exc).__name__})")

    print()
    print("== connection ==")
    try:
        from sqlalchemy import text

        from app.db import engine

        with engine.connect() as conn:
            who = conn.execute(text("SELECT SUSER_SNAME()")).scalar()
        print(f"connected as        {who}")
    except Exception as exc:
        print(f"FAILED              {type(exc).__name__}")
        print(f"                    {str(exc).splitlines()[0][:300]}")

    print()
    if problems:
        print(f"== {len(problems)} problem(s) found ==")
        for i, p in enumerate(problems, 1):
            print(f"{i}. {p}")
        return 1
    print("== no configuration problems found ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
