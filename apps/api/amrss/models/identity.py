import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import Role

if TYPE_CHECKING:
    from amrss.models.region import Facility


class AppUser(Base, TimestampMixin):
    """Named ``app_user`` rather than ``user``: ``user`` is a reserved word in
    PostgreSQL and quoting it everywhere invites mistakes."""

    __tablename__ = "app_user"

    id: Mapped[uuid.UUID] = pk_column()
    email: Mapped[str] = mapped_column(String(256), unique=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(256), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[Role] = mapped_column(pg_enum(Role, "user_role"), nullable=False)

    #: Scope. A facility-scoped role carries facility_id; a regional role carries
    #: regional_block_id; a system-wide role carries neither. Enforced in
    #: amrss.security.rbac, not left to callers.
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("facility.id"), index=True)
    regional_block_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("regional_block.id"), index=True
    )

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Set when an administrator resets a password, cleared when the user
    #: chooses their own. Between those two points the password is known to
    #: someone other than its owner, so an action taken under it is not
    #: attributable — which is the whole basis of the audit trail.
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    #: Read-only convenience for naming a user's facility in the console.
    #: Lazy by default: most queries touching users never need it.
    facility: Mapped["Facility | None"] = relationship(viewonly=True)
