"""The database's native enums must match the Python enums that declare them.

This exists because of a real failure, not a hypothetical one.
``SirResult.PENDING_INTERPRETATION`` ("PI") was added to the Python enum and the
native PostgreSQL type was never altered to match. Nothing caught it: Alembic's
autogenerate compares tables and columns, not enum *labels*, so ``alembic check``
reported no drift and the whole suite passed. The failure only appeared when a
row carrying the new value was written — which for this system means every
upload of real WHONET data, since those carry raw zone diameters recorded as PI.

A missing enum label is invisible until it is used, and by then it is a
production insert failure rather than a test one. So it is checked directly.

Skipped without a database, because the answer genuinely requires one; CI runs
against Postgres, so this executes there on every push.
"""

import os

import pytest
from sqlalchemy import Enum as SAEnum
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

from amrss.models.base import Base

DATABASE_URL = os.environ.get("AMRSS_DATABASE_URL")


def declared_enums() -> dict[str, set[str]]:
    """Every native enum the models declare, keyed by type name."""
    declared: dict[str, set[str]] = {}
    for table in Base.metadata.tables.values():
        for column in table.columns:
            column_type = column.type
            if isinstance(column_type, SAEnum) and column_type.name:
                declared.setdefault(column_type.name, set()).update(column_type.enums or ())
    return declared


def database_enums(engine) -> dict[str, set[str]]:
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT t.typname, e.enumlabel
                FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                """
            )
        ).all()
    found: dict[str, set[str]] = {}
    for name, label in rows:
        found.setdefault(name, set()).add(label)
    return found


@pytest.fixture(scope="module")
def engine():
    if not DATABASE_URL:
        pytest.skip("AMRSS_DATABASE_URL is not set; enum drift needs a live database")
    created = create_engine(DATABASE_URL)
    try:
        with created.connect():
            pass
    except OperationalError as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"database unreachable: {exc}")
    return created


def test_the_models_declare_the_enums_this_check_covers():
    """A guard on the guard.

    If the reflection above silently stopped finding enum columns — a helper
    rename, a type change — this test would pass vacuously and go on passing
    while real drift accumulated behind it.
    """
    declared = declared_enums()

    assert len(declared) >= 15, f"only found {len(declared)} enum types; reflection may be broken"
    assert "sir_result" in declared
    assert "PI" in declared["sir_result"]


def test_every_declared_enum_exists_in_the_database(engine):
    missing = sorted(set(declared_enums()) - set(database_enums(engine)))

    assert not missing, (
        f"enum types declared in the models but absent from the database: {missing}. "
        "A migration creating them is missing."
    )


def test_every_declared_enum_value_exists_in_the_database(engine):
    """The check Alembic does not perform.

    A label present in Python and absent from PostgreSQL raises
    ``invalid input value for enum`` on the first row that uses it.
    """
    in_database = database_enums(engine)
    drift = {
        name: sorted(values - in_database.get(name, set()))
        for name, values in declared_enums().items()
        if values - in_database.get(name, set())
    }

    assert not drift, (
        f"enum values declared in Python but missing from the database: {drift}. "
        "Add a migration with ALTER TYPE ... ADD VALUE inside an autocommit block."
    )


def test_no_migration_is_outstanding(engine):
    """Tables and columns, which Alembic *does* compare.

    Between this and the value check above, both halves of schema drift are
    covered — the half Alembic sees and the half it does not.
    """
    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.runtime.migration import MigrationContext

    Config("alembic.ini")  # resolves env.py's logging configuration
    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        differences = compare_metadata(context, Base.metadata)

    assert not differences, f"models and database schema disagree: {differences}"
