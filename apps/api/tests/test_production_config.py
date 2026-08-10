"""Configuration that must not reach production.

Each case here is a setting that lets the platform start, serve traffic, and be
wrong — the failure mode a startup check exists for. A missing database is not
tested because it announces itself on the first request; a development signing
key does not.
"""

import pytest

from amrss.config import DEVELOPMENT_JWT_SECRET, Settings, production_problems

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


def test_the_development_database_is_refused():
    problems = production_problems(
        settings(database_url="postgresql+psycopg://amrss:amrss_dev@localhost:5432/amrss")
    )
    assert any("development database" in p for p in problems)


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
