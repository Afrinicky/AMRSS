"""Role-based access control.

Permissions are explicit strings; roles are fixed bundles of them. Checks are
deny-by-default: an endpoint without a declared permission is unreachable by
non-superusers, and an unknown role grants nothing.
"""

from __future__ import annotations

from enum import StrEnum


class Permission(StrEnum):
    # Reference / CLSI data
    REFERENCE_READ = "reference:read"
    BREAKPOINT_READ = "breakpoint:read"
    BREAKPOINT_WRITE = "breakpoint:write"
    BREAKPOINT_ACTIVATE = "breakpoint:activate"

    # Specimens and isolates
    ISOLATE_READ = "isolate:read"
    ISOLATE_WRITE = "isolate:write"

    # Susceptibility testing
    AST_READ = "ast:read"
    AST_WRITE = "ast:write"
    AST_INTERPRET = "ast:interpret"
    AST_OVERRIDE = "ast:override"  # override an engine interpretation
    AST_RELEASE = "ast:release"  # authorise reporting to clinicians

    # Quality control
    QC_READ = "qc:read"
    QC_WRITE = "qc:write"

    # Patient identifiers (direct, unmasked)
    PATIENT_PII_READ = "patient:pii:read"

    # Surveillance reporting
    REPORT_READ = "report:read"
    REPORT_EXPORT = "report:export"

    # Administration
    USER_READ = "user:read"
    USER_WRITE = "user:write"
    AUDIT_READ = "audit:read"


class Role(StrEnum):
    VIEWER = "viewer"
    LAB_TECHNOLOGIST = "lab_technologist"
    MICROBIOLOGIST = "microbiologist"
    DATA_MANAGER = "data_manager"
    ADMIN = "admin"


_P = Permission

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset(
        {_P.REFERENCE_READ, _P.BREAKPOINT_READ, _P.ISOLATE_READ, _P.AST_READ, _P.REPORT_READ}
    ),
    Role.LAB_TECHNOLOGIST: frozenset(
        {
            _P.REFERENCE_READ,
            _P.BREAKPOINT_READ,
            _P.ISOLATE_READ,
            _P.ISOLATE_WRITE,
            _P.AST_READ,
            _P.AST_WRITE,
            _P.AST_INTERPRET,
            _P.QC_READ,
            _P.QC_WRITE,
            _P.REPORT_READ,
        }
    ),
    # Only a microbiologist may override the engine or release results to
    # clinicians - CLSI expects a qualified reviewer in that loop.
    Role.MICROBIOLOGIST: frozenset(
        {
            _P.REFERENCE_READ,
            _P.BREAKPOINT_READ,
            _P.ISOLATE_READ,
            _P.ISOLATE_WRITE,
            _P.AST_READ,
            _P.AST_WRITE,
            _P.AST_INTERPRET,
            _P.AST_OVERRIDE,
            _P.AST_RELEASE,
            _P.QC_READ,
            _P.QC_WRITE,
            _P.PATIENT_PII_READ,
            _P.REPORT_READ,
            _P.REPORT_EXPORT,
        }
    ),
    Role.DATA_MANAGER: frozenset(
        {
            _P.REFERENCE_READ,
            _P.BREAKPOINT_READ,
            _P.BREAKPOINT_WRITE,
            _P.BREAKPOINT_ACTIVATE,
            _P.ISOLATE_READ,
            _P.AST_READ,
            _P.QC_READ,
            _P.REPORT_READ,
            _P.REPORT_EXPORT,
            _P.AUDIT_READ,
        }
    ),
    # Admin manages users and reads the audit trail. Deliberately NOT granted
    # AST_RELEASE or PATIENT_PII_READ: administering the system is a different
    # job from authorising clinical results or reading identifiers.
    Role.ADMIN: frozenset(
        {
            _P.REFERENCE_READ,
            _P.BREAKPOINT_READ,
            _P.ISOLATE_READ,
            _P.AST_READ,
            _P.QC_READ,
            _P.USER_READ,
            _P.USER_WRITE,
            _P.AUDIT_READ,
            _P.REPORT_READ,
        }
    ),
}


def permissions_for(roles: object) -> frozenset[Permission]:
    """Union of permissions for an iterable of role names. Unknown roles yield none."""
    if isinstance(roles, (str, bytes)):
        roles = [roles]
    granted: set[Permission] = set()
    for name in roles:  # type: ignore[union-attr]
        try:
            role = Role(name)
        except ValueError:
            continue  # unknown role grants nothing
        granted |= ROLE_PERMISSIONS[role]
    return frozenset(granted)


def has_permission(roles: object, permission: Permission) -> bool:
    return permission in permissions_for(roles)
