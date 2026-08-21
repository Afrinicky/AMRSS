"""The national authority, and the grant that lets a facility depart from its table

Two changes, both about who decides what:

- **``superadmin``** joins ``user_role``. It is the national authority: every
  permission the platform defines, no geographic boundary, and the only role
  able to create a regional block or publish the breakpoint table the whole
  programme interprets against. Nothing is reassigned to it — a deployment
  appoints its own, and until it does the regional administrators continue
  exactly as before, minus block *creation*, which now needs national
  authority. Deployments upgrading with no superadmin yet should create one
  before they next need a new block.

- **``facility.breakpoint_override_granted``** records that the national
  authority has permitted one facility to hold its own breakpoint table instead
  of the national one. Default false, which is the whole point: every facility
  reads the national table until somebody with national authority says
  otherwise, and the exception is a row in the database with an audit entry
  behind it rather than a convention.

The enum value is added outside the migration's transaction. PostgreSQL before
12 refused ``ALTER TYPE ... ADD VALUE`` inside one entirely; 12 and later allow
it but then refuse to *use* the new value until the transaction commits, which
would break any data migration in this same revision that referenced it.
Committing first sidesteps both.

Revision ID: d4f60b8ac215
Revises: c7e1a034f9b2
Create Date: 2026-08-21 09:00:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4f60b8ac215"
down_revision: str | None = "c7e1a034f9b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    connection.commit()
    connection.execute(sa.text("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin'"))
    connection.commit()

    op.add_column(
        "facility",
        sa.Column(
            "breakpoint_override_granted",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column("facility", sa.Column("breakpoint_override_note", sa.Text(), nullable=True))
    op.add_column(
        "facility",
        sa.Column("breakpoint_override_granted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("facility", "breakpoint_override_granted_at")
    op.drop_column("facility", "breakpoint_override_note")
    op.drop_column("facility", "breakpoint_override_granted")
    # The enum value stays. PostgreSQL cannot drop one in place, and an unused
    # label is harmless; audit rows written while it existed still reference it.
