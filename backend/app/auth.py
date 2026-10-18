"""Bearer-token authentication.

Tokens are generated locally (see scripts/New-IngestToken.ps1) and only their
SHA-256 hash is stored in fit.api_tokens. Requests present the raw token as
``Authorization: Bearer <token>``.
"""
import hashlib
from datetime import timedelta

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import false, select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import ApiToken
from .timeutil import utcnow

# Only refresh a token's last_used_utc at most this often, so read-only GETs
# don't turn into a DB write + commit on every request.
USAGE_UPDATE_INTERVAL = timedelta(hours=1)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[7:].strip()


def _validate(token: str, db: Session, required_scope: str) -> ApiToken:
    row = db.execute(
        select(ApiToken).where(
            ApiToken.token_hash == hash_token(token),
            ApiToken.disabled == false(),
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if row.scope != "all" and row.scope != required_scope:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Token scope insufficient")
    now = utcnow()
    if row.last_used_utc is None or (now - row.last_used_utc) >= USAGE_UPDATE_INTERVAL:
        row.last_used_utc = now
        db.commit()
    return row


def require_ingest(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> ApiToken:
    return _validate(_extract_bearer(authorization), db, "ingest")


def require_read(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> ApiToken | None:
    if get_settings().gateway_read_auth:
        return None
    return _validate(_extract_bearer(authorization), db, "read")
