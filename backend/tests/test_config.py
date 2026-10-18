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
    """A relative env_file only resolves when the process starts in backend/.
    From any other cwd the settings silently fell back to defaults (db_auth
    "sql" with an empty password), surfacing as "Login failed for user
    'sqladmin'" with nothing pointing at the real cause."""
    env_file = Settings.model_config["env_file"]
    assert Path(env_file).is_absolute()
    assert Path(env_file).name == ".env"
    assert Path(env_file).parent.name == "backend"


def test_settings_load_identically_from_another_cwd(tmp_path, monkeypatch):
    before = Settings()
    monkeypatch.chdir(tmp_path)
    after = Settings()
    assert (after.db_auth, after.db_user, after.db_password) == (
        before.db_auth,
        before.db_user,
        before.db_password,
    )


def test_sqlalchemy_url_escapes_credentials():
    """Unescaped @ / : # in a password splits the URL at the wrong place and
    yields a bogus host, so the driver reports an invalid connection string
    rather than a bad password."""
    s = Settings(db_auth="sql", db_user="admin@srv", db_password="p@ss/w:rd#1")
    url = s.sqlalchemy_url
    assert "admin%40srv:p%40ss%2Fw%3Ard%231@" in url
    assert url.count("@") == 1


def test_postgresql_url_overrides_legacy_settings():
    url = "postgresql+psycopg://fittrack_runtime:password@127.0.0.1/fittrack"
    assert Settings(database_url=url).sqlalchemy_url == url
