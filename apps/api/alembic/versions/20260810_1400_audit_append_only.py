"""Enforce the append-only audit trail in the database

SDD 10.2 requires an append-only trail, and until now that was a property of the
application: no code path issues an UPDATE or DELETE against ``audit_log``. That
holds exactly as long as every future change remembers, and not one moment
longer — and it offers nothing at all against someone with a database session,
which is precisely the person an audit trail exists to constrain.

A trigger moves the guarantee from convention to the database. It refuses any
UPDATE or DELETE regardless of who issues it, including the application's own
role and including a superuser who has not deliberately disabled the trigger.
TRUNCATE is refused separately, because it is neither an UPDATE nor a DELETE and
would otherwise erase the table wholesale.

This does not make the trail tamper-*proof*. Anyone who can `ALTER TABLE ...
DISABLE TRIGGER` can still remove it — but that is now a deliberate, separate,
and itself-logged act rather than a stray statement. Combine it with a database
role that does not own the table, and with exporting the trail to append-only
external storage, as docs/security.md sets out.

Revision ID: e5c8a91f4d27
Revises: b2e714c9d503
Create Date: 2026-08-10 14:00:00.000000+00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e5c8a91f4d27"
down_revision: str | None = "b2e714c9d503"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


GUARD = """
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
    op.execute(GUARD)
    op.execute(
        """
        CREATE TRIGGER audit_log_no_update_or_delete
        BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION amrss_audit_log_is_append_only();
        """
    )
    # TRUNCATE fires no row-level trigger, so it needs its own statement-level
    # one. Without it the whole table can be emptied in a single statement.
    op.execute(
        """
        CREATE TRIGGER audit_log_no_truncate
        BEFORE TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION amrss_audit_log_is_append_only();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log")
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_update_or_delete ON audit_log")
    op.execute("DROP FUNCTION IF EXISTS amrss_audit_log_is_append_only()")
