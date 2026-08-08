"""Enforce append-only semantics on the audit log.

Application code is not the right place to guarantee this: a bug, a stray
migration or a console session with the app role could rewrite history. A
trigger makes UPDATE and DELETE fail at the database, so tampering requires
superuser access and leaves the hash chain broken either way.

Revision ID: 0002_audit_append_only
Revises: 807c322fadaa
Create Date: 2026-08-08
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002_audit_append_only"
down_revision: str | None = "807c322fadaa"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION amrss_audit_log_immutable()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION
                'audit_log is append-only: % on seq % is not permitted',
                TG_OP, COALESCE(OLD.seq, NEW.seq)
                USING ERRCODE = 'restrict_violation';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_log_no_update
            BEFORE UPDATE ON audit_log
            FOR EACH ROW EXECUTE FUNCTION amrss_audit_log_immutable();
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_log_no_delete
            BEFORE DELETE ON audit_log
            FOR EACH ROW EXECUTE FUNCTION amrss_audit_log_immutable();
        """
    )
    # TRUNCATE bypasses row-level triggers, so it needs its own statement-level one.
    op.execute(
        """
        CREATE TRIGGER audit_log_no_truncate
            BEFORE TRUNCATE ON audit_log
            FOR EACH STATEMENT EXECUTE FUNCTION amrss_audit_log_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;")
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;")
    op.execute("DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;")
    op.execute("DROP FUNCTION IF EXISTS amrss_audit_log_immutable();")
