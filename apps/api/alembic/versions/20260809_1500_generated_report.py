"""Published reports

Stores the rendered artefact rather than regenerating on download. A report
circulated to a stewardship committee in April has to keep saying in October
what the committee discussed, even after a threshold is tuned or a late upload
changes the underlying aggregate. Regenerating would silently rewrite history.

The methodology in force is snapshotted alongside for the same reason: a
quarterly report read a year later is a set of numbers whose thresholds are
otherwise unknowable.

Revision ID: 9d31be40c7a2
Revises: 4a7b19c2e08f
Create Date: 2026-08-09 15:00:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9d31be40c7a2"
down_revision: str | None = "4a7b19c2e08f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REPORT_PERIOD = postgresql.ENUM(
    "monthly", "quarterly", "annual", "ad_hoc", name="report_period", create_type=False
)


def upgrade() -> None:
    REPORT_PERIOD.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "generated_report",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("period", REPORT_PERIOD, nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("regional_block_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("district_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("facility_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("generated_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("organism_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("isolate_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("facilities_contributing", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("facilities_excluded", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "methodology_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("pdf_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("xlsx_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["regional_block_id"], ["regional_block.id"]),
        sa.ForeignKeyConstraint(["district_id"], ["district.id"]),
        sa.ForeignKeyConstraint(["facility_id"], ["facility.id"]),
        sa.ForeignKeyConstraint(["generated_by_id"], ["app_user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_report_scope_period",
        "generated_report",
        ["regional_block_id", "period_start", "period_end"],
    )


def downgrade() -> None:
    op.drop_index("ix_report_scope_period", table_name="generated_report")
    op.drop_table("generated_report")
    REPORT_PERIOD.drop(op.get_bind(), checkfirst=True)
