"""Force a password change after an administrative reset

An administrator resetting a password necessarily learns it. Until the owner
replaces it, any action taken under that account could have been taken by either
of them — and an audit trail that cannot say who acted is not an audit trail.

The flag is set by the reset and cleared when the user chooses their own
password. Existing accounts default to false: their passwords were never handed
to anyone.

Revision ID: b2e714c9d503
Revises: c5f0a1d8b7e3
Create Date: 2026-08-10 09:00:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2e714c9d503"
down_revision: str | None = "c5f0a1d8b7e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "app_user",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("app_user", "must_change_password")
