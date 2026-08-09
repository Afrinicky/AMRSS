"""CLSI mapping columns on the canonical dictionary

Adds the two fields the interpretation bridge needs to look a measurement up in
a laboratory's loaded CLSI table:

- ``canonical_organism.clsi_organism_groups`` — the CLSI organism groups an
  organism belongs to, most specific first. M100 nests species inside broader
  groups and a criterion may be defined at either level.
- ``canonical_antibiotic.clsi_agent_code`` — the agent code as it appears in
  that table, which need not match the dictionary's own code.

Both are data rather than code (ADR-0002): mapping species to CLSI groups in
Python would force a deployment every time a laboratory adds an organism, and
would bake one region's dictionary into the engine.

Existing rows get an empty group list and a null agent code, which is the
correct starting state — the interpreter falls back to the organism's own name
and the dictionary code, and reports anything it cannot cover rather than
guessing.

Revision ID: 4a7b19c2e08f
Revises: 81c454dd741d
Create Date: 2026-08-09 11:30:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4a7b19c2e08f"
down_revision: str | None = "81c454dd741d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "canonical_organism",
        sa.Column(
            "clsi_organism_groups",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )
    op.add_column(
        "canonical_antibiotic",
        sa.Column("clsi_agent_code", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("canonical_antibiotic", "clsi_agent_code")
    op.drop_column("canonical_organism", "clsi_organism_groups")
