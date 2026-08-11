"""Configuration that must not reach production.

Each case here is a setting that lets the platform start, serve traffic, and be
wrong — the failure mode a startup check exists for. A missing database is not
tested because it announces itself on the first request; a development signing
key does not.
"""

import pytest

from amrss.config import (
    DEVELOPMENT_JWT_SECRET,
    Settings,
    connection_url_problems,
    production_problems,
)

GOOD_SECRET = "P" * 40
NEON_POOLED = (
    "postgresql+psycopg://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/amrss?sslmode=require"
)
NEON_DIRECT = "postgresql+psycopg://u:p@ep-x.eu-central-1.aws.neon.tech/amrss?sslmode=require"


def settings(**overrides) -> Settings:
    base = {
        "environment": "production",
        "jwt_secret": GOOD_SECRET,
        "database_url": NEON_POOLED,
        "migration_database_url": NEON_DIRECT,
        "cors_origins": [],
    }
    return Settings(**{**base, **overrides})


def test_a_correct_production_configuration_has_no_problems():
    assert production_problems(settings()) == []


def test_the_development_signing_key_is_refused():
    """It is published in this repository, so anyone reading it could forge a
    session for any account."""
    problems = production_problems(settings(jwt_secret=DEVELOPMENT_JWT_SECRET))
    assert any("development default" in p for p in problems)


def test_a_short_signing_key_is_refused():
    problems = production_problems(settings(jwt_secret="short"))
    assert any("characters" in p for p in problems)


def test_a_hosted_database_without_tls_is_refused():
    """Neon is reached across the public internet, and psycopg will negotiate an
    unencrypted connection without complaint."""
    problems = production_problems(
        settings(database_url=NEON_POOLED.replace("?sslmode=require", ""))
    )
    assert any("sslmode" in p for p in problems)


def test_migrations_pointed_at_the_pooler_are_refused():
    """pgbouncer in transaction mode cannot run the session-level DDL this
    project's own enum migration needs, and the failure lands halfway through a
    release rather than at the start."""
    problems = production_problems(settings(migration_database_url=NEON_POOLED))
    assert any("pooled endpoint" in p for p in problems)


def test_the_published_development_password_is_refused():
    problems = production_problems(
        settings(database_url="postgresql+psycopg://amrss:amrss_dev@db.internal:5432/amrss")
    )
    assert any("development password" in p for p in problems)


def test_a_loopback_database_is_allowed():
    """A virtual machine running PostgreSQL beside the API is a legitimate
    deployment. Refusing it would push an operator to work around the check,
    and a database that genuinely is not there answers at /health/ready."""
    local = "postgresql+psycopg://amrss:a-real-password@localhost:5432/amrss"
    assert production_problems(settings(database_url=local)) == []


@pytest.mark.parametrize(
    "origins", [["http://localhost:3000"], ["https://amrss.example.org", "http://127.0.0.1:3000"]]
)
def test_a_leftover_development_origin_is_refused(origins):
    assert any(
        "development origin" in p for p in production_problems(settings(cors_origins=origins))
    )


def test_a_plain_http_origin_is_refused():
    problems = production_problems(settings(cors_origins=["http://amrss.example.org"]))
    assert any("plain-HTTP" in p for p in problems)


def test_no_trusted_browser_origin_is_correct_not_a_problem():
    """The dashboard calls the API from its own server, so a deployment that
    trusts no browser origin is the tighter one — flagging it would push an
    operator to widen access for no reason."""
    assert production_problems(settings(cors_origins=[])) == []


def test_migrations_fall_back_to_the_application_url():
    """Right for a plain PostgreSQL, where there is only one endpoint."""
    plain = "postgresql+psycopg://u:p@db.internal:5432/amrss"
    assert settings(database_url=plain, migration_database_url=None).migration_url == plain


def test_development_is_not_held_to_production_rules():
    """Otherwise nobody could run the stack locally without inventing secrets."""
    from amrss.config import get_settings

    get_settings.cache_clear()
    assert not Settings(environment="development").is_production


# ---- Bootstrap ------------------------------------------------------------


def test_bootstrap_defaults_to_loading_nothing():
    """A deployment that silently seeded itself would be a deployment whose
    contents nobody decided on."""
    assert Settings().bootstrap == "none"


def test_demo_bootstrap_is_expressible_only_outside_production():
    """The setting can be `demo` anywhere — it is the seed itself that refuses,
    so a misconfigured production deployment fails loudly at start rather than
    quietly loading known-password accounts."""
    assert Settings(environment="staging", bootstrap="demo").bootstrap == "demo"
    assert not Settings(environment="staging").is_production


# ---- Malformed connection URLs --------------------------------------------
#
# These are checked in every environment, not just production, because the
# deployment that prompted them was running as `staging` — where none of the
# checks above run at all.


def test_a_neon_url_left_as_neon_gave_it_is_accepted():
    """The correct action is to change the scheme and nothing else."""
    assert (
        connection_url_problems(
            "postgresql+psycopg://u:p@ep-x.eu-west-2.aws.neon.tech/amrss"
            "?sslmode=require&channel_binding=require",
            "AMRSS_DATABASE_URL",
        )
        == []
    )


def test_appending_a_second_query_string_is_refused():
    """The real failure, verbatim.

    docs/DEPLOYMENT.md used to say "append ?sslmode=require" to a Neon string
    that already carried its own parameters. The append landed inside the last
    value instead of adding a parameter, and Render died with
    `invalid channel_binding value: "require?sslmode=require"` — an error that
    names neither the setting nor the fix.
    """
    problems = connection_url_problems(
        "postgresql+psycopg://u:p@ep-calm-glade-za0n4q4f.c-2.eu-west-2.aws.neon.tech/amrss"
        "?sslmode=require&channel_binding=require?sslmode=require",
        "AMRSS_DATABASE_URL",
    )
    assert len(problems) == 1
    assert "more than one '?'" in problems[0]
    assert "AMRSS_DATABASE_URL" in problems[0]
    assert "&" in problems[0]


def test_a_parameter_whose_value_swallowed_a_query_string_is_refused():
    """The same mistake caught by its result rather than its shape, for a URL
    that reached this state some other way."""
    problems = connection_url_problems(
        "postgresql+psycopg://u:p@host/amrss?channel_binding=require%3Fsslmode%3Drequire",
        "AMRSS_DATABASE_URL",
    )
    assert len(problems) == 1
    assert "channel_binding" in problems[0]


def test_a_driverless_scheme_is_refused():
    """psycopg is the only driver in the image; a bare postgresql:// URL sends
    SQLAlchemy looking for psycopg2 and fails as if the image were broken."""
    problems = connection_url_problems(
        "postgresql://u:p@ep-x.aws.neon.tech/amrss?sslmode=require", "AMRSS_DATABASE_URL"
    )
    assert len(problems) == 1
    assert "postgresql+psycopg://" in problems[0]


def test_the_development_default_is_well_formed():
    """The default must not trip a check that runs in every environment."""
    assert connection_url_problems(Settings().database_url, "AMRSS_DATABASE_URL") == []


def test_a_malformed_url_refuses_to_start_outside_production(monkeypatch):
    """The staging deployment that hit this had no production checks running."""
    from amrss.config import get_settings

    monkeypatch.setenv("AMRSS_ENVIRONMENT", "staging")
    monkeypatch.setenv(
        "AMRSS_DATABASE_URL",
        "postgresql+psycopg://u:p@host/amrss?sslmode=require&channel_binding=require"
        "?sslmode=require",
    )
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="unusable database URL"):
        get_settings()
    get_settings.cache_clear()


def test_a_malformed_migration_url_is_refused_too(monkeypatch):
    """Migrations run first in the container, against their own URL."""
    from amrss.config import get_settings

    monkeypatch.setenv("AMRSS_ENVIRONMENT", "staging")
    monkeypatch.setenv("AMRSS_DATABASE_URL", NEON_POOLED)
    monkeypatch.setenv("AMRSS_MIGRATION_DATABASE_URL", NEON_DIRECT + "?sslmode=require")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="AMRSS_MIGRATION_DATABASE_URL"):
        get_settings()
    get_settings.cache_clear()


# ---- The address someone pastes into a browser -----------------------------


def test_the_root_answers_something_useful():
    """A bare 404 at the base URL makes a working deployment look broken — the
    first thing anyone does with a new service is open its address."""
    from fastapi.testclient import TestClient

    from amrss.main import app

    body = TestClient(app).get("/").json()
    assert body["service"] == "AMRSS Surveillance API"
    assert body["health"] == "/health/ready"


def test_the_root_discloses_nothing_about_configuration():
    """It answers before anyone has authenticated, so it must not describe the
    deployment — not the environment, the database, or the trusted origins."""
    from fastapi.testclient import TestClient

    from amrss.main import app

    text = TestClient(app).get("/").text.lower()
    for leak in ("postgres", "database", "secret", "environment", "origin", "neon"):
        assert leak not in text, f"root endpoint leaked {leak!r}"
