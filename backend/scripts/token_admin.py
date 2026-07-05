"""Local admin CLI for fittrack API tokens.

Tokens are generated here on your machine; only the SHA-256 hash is written to
the database, so the raw token is shown exactly once. Use the printed token in
the Health Auto Export app (ingest) and/or the web dashboard (read).

Examples:
    python -m scripts.token_admin add --name "iphone-hae" --scope ingest
    python -m scripts.token_admin add --name "dashboard" --scope read
    python -m scripts.token_admin list
    python -m scripts.token_admin disable --id 3
"""
import argparse
import secrets
import sys

# Allow running as `python scripts/token_admin.py` from the backend dir.
sys.path.insert(0, ".")

from app.auth import hash_token  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import ApiToken  # noqa: E402
from app.timeutil import utcnow  # noqa: E402


def add(name: str, scope: str) -> None:
    token = secrets.token_urlsafe(32)
    with SessionLocal() as db:
        db.add(
            ApiToken(
                name=name,
                token_hash=hash_token(token),
                scope=scope,
                disabled=False,
                created_utc=utcnow(),
            )
        )
        db.commit()
    print("\n  Token created. Copy it now — it will NOT be shown again:\n")
    print(f"    {token}\n")
    print(f"  name={name}  scope={scope}\n")


def list_tokens() -> None:
    with SessionLocal() as db:
        rows = db.query(ApiToken).order_by(ApiToken.id).all()
        if not rows:
            print("No tokens.")
            return
        for t in rows:
            state = "disabled" if t.disabled else "active"
            last = t.last_used_utc.isoformat() if t.last_used_utc else "never"
            print(f"  #{t.id:<3} {t.name:<20} scope={t.scope:<7} {state:<9} last_used={last}")


def disable(token_id: int) -> None:
    with SessionLocal() as db:
        t = db.get(ApiToken, token_id)
        if not t:
            print(f"Token #{token_id} not found.")
            return
        t.disabled = True
        db.commit()
        print(f"Token #{token_id} disabled.")


def main() -> None:
    p = argparse.ArgumentParser(description="Manage fittrack API tokens")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="Create a new token")
    a.add_argument("--name", required=True)
    a.add_argument("--scope", choices=["all", "ingest", "read"], default="all")

    sub.add_parser("list", help="List tokens")

    d = sub.add_parser("disable", help="Disable a token")
    d.add_argument("--id", type=int, required=True)

    args = p.parse_args()
    if args.cmd == "add":
        add(args.name, args.scope)
    elif args.cmd == "list":
        list_tokens()
    elif args.cmd == "disable":
        disable(args.id)


if __name__ == "__main__":
    main()
