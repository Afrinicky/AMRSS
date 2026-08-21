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

``ALTER TYPE ... ADD VALUE`` needs its own transaction: PostgreSQL before 12
refused it inside one entirely, and 12 and later allow it but then refuse to
*use* the new value until that transaction commits. Alembic's
``autocommit_block`` is the way to get one — it suspends the migration's
transaction, runs the statement on its own, and resumes.

What must **not** be done here is calling ``op.get_bind().commit()`` by hand.
It ends the transaction Alembic is running the migration in, and everything
after it — including the ``alembic_version`` bump — is then discarded without
an error. The migration logs "Running upgrade", adds the enum value, applies
none of the columns below, and leaves the version at the previous revision.
The next thing to touch ``facility`` is what discovers it.

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
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'superadmin'")

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
