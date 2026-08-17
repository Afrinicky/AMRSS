"""Username login handle, and the system administrator merged into the regional admin

Two account changes ship together:

- **Username.** Accounts gain an optional ``username`` alongside ``email``; a
  login accepts either. Existing accounts keep ``NULL`` and sign in by email as
  before. The column is unique so two accounts cannot share a handle.

- **One overall authority.** The separate ``system_administrator`` role is
  retired: the regional AMR administrator now holds both regional oversight and
  platform/account administration. Every account that still held the old role is
  reassigned to ``regional_amr_administrator`` here, and — because that role is
  block-scoped — given a regional block if it had none and exactly one block
  exists. The ``system_administrator`` label stays in the ``user_role`` enum
  type: PostgreSQL cannot drop an enum value in place, historical audit rows
  reference it, and an unused label is harmless. No new account can be given it,
  because the application enum no longer offers it.

Revision ID: a3d9f2c65b81
Revises: e5c8a91f4d27
Create Date: 2026-08-17 09:00:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3d9f2c65b81"
down_revision: str | None = "e5c8a91f4d27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("app_user", sa.Column("username", sa.String(length=64), nullable=True))
    op.create_unique_constraint("uq_app_user_username", "app_user", ["username"])

    # Reassign any surviving system administrators to the merged role, giving a
    # block to those that carried none when the deployment has a single block.
    op.execute(
        sa.text(
            """
            UPDATE app_user
            SET role = 'regional_amr_administrator',
                regional_block_id = COALESCE(
                    regional_block_id,
                    CASE
                        WHEN (SELECT count(*) FROM regional_block) = 1
                        THEN (SELECT id FROM regional_block)
                        ELSE NULL
                    END
                )
            WHERE role = 'system_administrator'
            """
        )
    )


def downgrade() -> None:
    # The role reassignment is not reversed: the original role of each migrated
    # account is not recorded, and the enum label it would revert to still
    # exists, so a downgrade leaves those accounts as regional administrators.
    op.drop_constraint("uq_app_user_username", "app_user", type_="unique")
    op.drop_column("app_user", "username")
