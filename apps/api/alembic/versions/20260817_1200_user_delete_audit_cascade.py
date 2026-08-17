"""Allow deleting a user without breaking the append-only audit trail

A user account can now be deleted, not only deactivated. The obstacle was the
audit trail: every action a user took carries their ``actor_id``, and the trail
is append-only — no row may be updated or deleted — so the foreign key pinned the
account in place forever.

The resolution keeps the trail's *content* immutable while letting the *pointer*
to a deleted account be severed. ``actor_id`` becomes ``ON DELETE SET NULL``, and
the append-only trigger is taught one exception: an update that clears
``actor_id`` (non-null to null) with every other column identical — exactly the
cascade a user deletion produces. The actor stays attributable through
``actor_label``, which is plain text captured at the time of the action and is
never touched. Every other update, and every delete, is still refused.

Revision ID: c7e1a034f9b2
Revises: a3d9f2c65b81
Create Date: 2026-08-17 12:00:00.000000+00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c7e1a034f9b2"
down_revision: str | None = "a3d9f2c65b81"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FK = "fk_audit_log_actor_id_app_user"

RELAXED_GUARD = """
CREATE OR REPLACE FUNCTION amrss_audit_log_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- The single permitted mutation: the ON DELETE SET NULL cascade from a
    -- deleted app_user, which clears actor_id and nothing else. The actor stays
    -- attributable through the immutable actor_label. Everything else is refused.
    IF TG_OP = 'UPDATE'
       AND OLD.actor_id IS NOT NULL
       AND NEW.actor_id IS NULL
       AND NEW.id = OLD.id
       AND NEW.occurred_at IS NOT DISTINCT FROM OLD.occurred_at
       AND NEW.actor_label IS NOT DISTINCT FROM OLD.actor_label
       AND NEW.actor_role IS NOT DISTINCT FROM OLD.actor_role
       AND NEW.action IS NOT DISTINCT FROM OLD.action
       AND NEW.entity IS NOT DISTINCT FROM OLD.entity
       AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
       AND NEW.before_state IS NOT DISTINCT FROM OLD.before_state
       AND NEW.after_state IS NOT DISTINCT FROM OLD.after_state
       AND NEW.source_ip IS NOT DISTINCT FROM OLD.source_ip
       AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
       AND NEW.note IS NOT DISTINCT FROM OLD.note
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION
        'audit_log is append-only: % is not permitted (SDD 10.2)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;
"""

STRICT_GUARD = """
CREATE OR REPLACE FUNCTION amrss_audit_log_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'audit_log is append-only: % is not permitted (SDD 10.2)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;
"""


def upgrade() -> None:
    op.execute(RELAXED_GUARD)
    op.drop_constraint(FK, "audit_log", type_="foreignkey")
    op.create_foreign_key(FK, "audit_log", "app_user", ["actor_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint(FK, "audit_log", type_="foreignkey")
    op.create_foreign_key(FK, "audit_log", "app_user", ["actor_id"], ["id"])
    op.execute(STRICT_GUARD)
