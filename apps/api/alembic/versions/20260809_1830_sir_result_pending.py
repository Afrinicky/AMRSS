"""Add PI to the sir_result enum

``SirResult.PENDING_INTERPRETATION`` ("PI") was added to the Python enum when
the CLSI interpretation work landed, but the native PostgreSQL type was never
altered to match. The Python side and the database disagreed, and nothing
caught it: Alembic's autogenerate compares tables and columns, not enum
*labels*, so ``alembic check`` reported no drift.

The consequence was not cosmetic. Real WHONET exports carry raw zone diameters
with no S/I/R letter, which ingestion records as PI — so every upload of the
data this system was built for would have failed on insert with
``invalid input value for enum sir_result``, and the interpretation pass could
not even read the rows it was meant to resolve.

``ALTER TYPE ... ADD VALUE`` cannot be used in the same transaction that adds
it, so this runs in an autocommit block. ``IF NOT EXISTS`` makes it safe on any
database where a previous attempt already applied it.

Revision ID: c5f0a1d8b7e3
Revises: 9d31be40c7a2
Create Date: 2026-08-09 18:30:00.000000+00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c5f0a1d8b7e3"
down_revision: str | None = "9d31be40c7a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE sir_result ADD VALUE IF NOT EXISTS 'PI'")


def downgrade() -> None:
    # PostgreSQL cannot drop a value from an enum type. Removing it would mean
    # rebuilding the type and rewriting every column that uses it, which would
    # destroy the very rows this value exists to record. Left deliberately
    # irreversible: an unused enum label is harmless, and losing measurements
    # awaiting interpretation is not.
    pass
