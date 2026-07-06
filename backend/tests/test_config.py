"""Settings loading — especially that a blank ATHLETE_BIRTH_DATE (how an unset
env var is delivered by the deploy) disables VO2 interpretation instead of
crashing the app at startup with a pydantic date-parsing error."""
from datetime import date

from app.config import Settings


def test_blank_birth_date_becomes_none():
    s = Settings(athlete_birth_date="")
    assert s.athlete_birth_date is None


def test_whitespace_birth_date_becomes_none():
    s = Settings(athlete_birth_date="   ")
    assert s.athlete_birth_date is None


def test_valid_birth_date_is_parsed():
    s = Settings(athlete_birth_date="1970-09-20")
    assert s.athlete_birth_date == date(1970, 9, 20)


def test_unset_birth_date_defaults_to_none():
    s = Settings()
    assert s.athlete_birth_date is None
