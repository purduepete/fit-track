"""VO2 max interpretation using The Cooper Institute normative categories.

VO2 max (mL/kg/min) is only meaningful relative to age and sex, so a bare number
on the dashboard is hard to read. This maps a value to one of six categories
(Very Poor -> Superior) for the athlete's age band and sex, and reports the
current band range plus what it takes to reach the next tier.

Norms adapted from The Cooper Institute / ACSM (mL/kg/min). Each entry lists the
*lower bound* of Poor, Fair, Good, Excellent and Superior for that age band;
below the first bound is Very Poor.
"""
from datetime import date

CATEGORIES = ("Very Poor", "Poor", "Fair", "Good", "Excellent", "Superior")

# (max_age_inclusive, (poor, fair, good, excellent, superior) lower bounds)
_MEN: list[tuple[int, tuple[float, float, float, float, float]]] = [
    (19, (35.0, 38.4, 45.2, 51.0, 56.0)),
    (29, (33.0, 36.5, 42.5, 46.5, 52.5)),
    (39, (31.5, 35.5, 41.0, 45.0, 49.5)),
    (49, (30.2, 33.6, 39.5, 43.5, 48.1)),
    (59, (26.1, 31.0, 35.8, 41.0, 45.4)),
    (200, (20.5, 26.0, 32.3, 36.5, 44.3)),
]
_WOMEN: list[tuple[int, tuple[float, float, float, float, float]]] = [
    (19, (25.0, 29.0, 33.0, 37.0, 42.0)),
    (29, (23.6, 29.0, 33.0, 37.0, 41.1)),
    (39, (22.8, 27.0, 31.5, 35.7, 40.1)),
    (49, (21.0, 24.5, 29.0, 32.9, 37.0)),
    (59, (20.2, 22.8, 27.0, 31.5, 35.8)),
    (200, (17.5, 20.2, 24.5, 30.3, 31.5)),
]


def age_on(birth_date: date, on: date | None = None) -> int:
    """Whole years old on ``on`` (defaults to today)."""
    on = on or date.today()
    years = on.year - birth_date.year
    if (on.month, on.day) < (birth_date.month, birth_date.day):
        years -= 1
    return years


def _normalize_sex(sex: str) -> str | None:
    s = sex.strip().lower()
    if s in ("m", "male", "man"):
        return "male"
    if s in ("f", "female", "woman"):
        return "female"
    return None


def _bounds_for(sex: str, age: int) -> tuple[float, float, float, float, float] | None:
    table = _MEN if sex == "male" else _WOMEN
    for max_age, bounds in table:
        if age <= max_age:
            return bounds
    return None


def classify(value: float, age: int, sex: str) -> dict | None:
    """Classify a VO2 max value for the given age/sex.

    Returns a dict with the category, its index (0=Very Poor .. 5=Superior), the
    current band's [low, high] range, and the next category + the value needed to
    reach it (both ``None`` when already Superior). Returns ``None`` when the sex
    is unrecognized so callers can omit interpretation rather than mislead.
    """
    norm = _normalize_sex(sex)
    if norm is None or age <= 0:
        return None
    bounds = _bounds_for(norm, age)
    if bounds is None:
        return None
    # index = how many lower-bounds the value meets or exceeds (0..5).
    idx = sum(1 for b in bounds if value >= b)
    low = bounds[idx - 1] if idx > 0 else None
    high = bounds[idx] if idx < len(bounds) else None
    next_category = CATEGORIES[idx + 1] if idx < len(CATEGORIES) - 1 else None
    next_at = high  # the lower bound of the next tier is this band's upper edge
    return {
        "category": CATEGORIES[idx],
        "category_index": idx,
        "range_low": low,
        "range_high": high,
        "next_category": next_category,
        "next_at": next_at,
        "age": age,
        "sex": norm,
    }
