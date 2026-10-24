"""Manual pull uses the same source boundary and lock as scheduled sync."""
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..auth import require_ingest
from ..config import get_settings
from ..db import SessionLocal, get_db
from ..strava import StravaBusy, StravaError, sync_once

router = APIRouter(prefix="/api/strava", tags=["strava"])
logger = logging.getLogger("fittrack.strava")


def require_sync(authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    if get_settings().gateway_read_auth:
        return
    return require_ingest(authorization, db)


@router.post("/pull")
def pull_strava(
    x_fittrack_sync: str | None = Header(default=None),
    _token=Depends(require_sync),
) -> dict[str, int]:
    # The custom header requires a CORS preflight for cross-origin browser POSTs.
    if x_fittrack_sync != "1":
        raise HTTPException(status_code=403, detail="Missing FitTrack sync header")
    path = get_settings().strava_token_file
    if not path:
        raise HTTPException(status_code=503, detail="Strava is not connected.")
    try:
        with httpx.Client(timeout=30, follow_redirects=False) as http:
            imported = sync_once(Path(path), SessionLocal, http=http)
    except StravaBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except StravaError as exc:
        logger.warning("Manual Strava pull failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from None
    except SQLAlchemyError:
        logger.error("Manual Strava pull failed: database operation failed.")
        raise HTTPException(status_code=503, detail="Strava import failed. Check database availability.") from None
    return {"workouts": imported}
