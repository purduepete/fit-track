"""Settings loading — especially that a blank ATHLETE_BIRTH_DATE (how an unset
env var is delivered by the deploy) disables VO2 interpretation instead of
crashing the app at startup with a pydantic date-parsing error."""
from datetime import date
from pathlib import Path

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


def test_env_file_is_anchored_to_backend_dir():
    """A relative env_file only resolves when the process starts in backend/."""
    env_file = Settings.model_config["env_file"]
    assert Path(env_file).is_absolute()
    assert Path(env_file).name == ".env"
    assert Path(env_file).parent.name == "backend"


def test_settings_load_identically_from_another_cwd(tmp_path, monkeypatch):
    before = Settings()
    monkeypatch.chdir(tmp_path)
    after = Settings()
    assert (after.database_url, after.db_schema) == (before.database_url, before.db_schema)
