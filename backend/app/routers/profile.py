"""Athlete weight used when a Strava ride's W/kg is first calculated."""
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..auth import require_control, require_read
from ..db import get_db
from ..models import AthleteProfile
from ..schemas import AthleteWeight, AthleteWeightUpdate
from ..timeutil import utcnow

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("/weight", response_model=AthleteWeight)
def get_weight(db: Session = Depends(get_db), _token=Depends(require_read)) -> AthleteWeight:
    profile = db.get(AthleteProfile, 1)
    return AthleteWeight(weight_kg=profile.weight_kg if profile else None)


@router.put("/weight", response_model=AthleteWeight)
def save_weight(
    update: AthleteWeightUpdate,
    x_fittrack_edit: str | None = Header(default=None),
    db: Session = Depends(get_db),
    _token=Depends(require_control),
) -> AthleteWeight:
    if x_fittrack_edit != "1":
        raise HTTPException(status_code=403, detail="Missing FitTrack edit header")
    # Stored W/kg values stay as they are; only rides without one use the new weight.
    profile = db.get(AthleteProfile, 1)
    if profile is None:
        profile = AthleteProfile(id=1, weight_kg=update.weight_kg, updated_utc=utcnow())
        db.add(profile)
    else:
        profile.weight_kg = update.weight_kg
        profile.updated_utc = utcnow()
    db.commit()
    return AthleteWeight(weight_kg=profile.weight_kg)
