"""Permission vocabulary and the role-to-permission map.

SDD 7 requires access control enforced at the API layer, consistently across
dashboard and export endpoints, never solely as a UI restriction. Endpoints
therefore declare the *permission* they need; they never test the role directly.
That keeps the role definitions in one reviewable table rather than scattered
across route handlers where a single missed check silently widens access.
"""

from enum import StrEnum

from amrss.models.enums import Role


class Permission(StrEnum):
    # Data submission
    UPLOAD_SUBMIT = "upload:submit"
    QC_ATTEST = "qc:attest"

    # Surveillance viewing
    VIEW_OWN_FACILITY = "surveillance:view_own_facility"
    VIEW_REGIONAL = "surveillance:view_regional"
    VIEW_CROSS_FACILITY = "surveillance:view_cross_facility"

    # Data stewardship
    REVIEW_BATCH = "batch:review"
    RETRACT_BATCH = "batch:retract"
    MANAGE_DICTIONARY = "dictionary:manage"
    REVIEW_MAPPING = "mapping:review"
    MANAGE_QC_GATING = "qc:manage_gating"

    # Regional administration
    ENROLL_FACILITY = "facility:enroll"
    MANAGE_BLOCK = "block:manage"
    CONFIGURE_ALERTS = "alert:configure"
    ACKNOWLEDGE_SIGNAL = "signal:acknowledge"
    MANAGE_METHODOLOGY = "methodology:manage"

    # Accountability
    READ_AUDIT = "audit:read"

    # User and system administration
    MANAGE_FACILITY_USERS = "user:manage_facility"
    MANAGE_USERS = "user:manage"
    SYSTEM_ADMIN = "system:admin"


#: SDD 7, rendered as data.
#:
#: Two separations are deliberate and must not be collapsed for convenience:
#: the Auditor reads the trail but holds no operational permission, so
#: accountability stays independent of the administration it examines; and the
#: System Administrator manages infrastructure and accounts without gaining
#: access to surveillance data, keeping technical and clinical authority apart.
ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.LABORATORY_STAFF: frozenset(
        {
            Permission.UPLOAD_SUBMIT,
            Permission.QC_ATTEST,
            Permission.VIEW_OWN_FACILITY,
        }
    ),
    Role.FACILITY_ADMINISTRATOR: frozenset(
        {
            Permission.VIEW_OWN_FACILITY,
            Permission.MANAGE_FACILITY_USERS,
        }
    ),
    Role.DATA_STEWARD: frozenset(
        {
            Permission.VIEW_REGIONAL,
            Permission.VIEW_CROSS_FACILITY,
            Permission.REVIEW_BATCH,
            Permission.RETRACT_BATCH,
            Permission.MANAGE_DICTIONARY,
            Permission.REVIEW_MAPPING,
            Permission.MANAGE_QC_GATING,
        }
    ),
    Role.REGIONAL_AMR_ADMINISTRATOR: frozenset(
        {
            Permission.VIEW_REGIONAL,
            Permission.VIEW_CROSS_FACILITY,
            Permission.REVIEW_BATCH,
            Permission.ENROLL_FACILITY,
            Permission.MANAGE_BLOCK,
            Permission.CONFIGURE_ALERTS,
            Permission.ACKNOWLEDGE_SIGNAL,
            Permission.MANAGE_METHODOLOGY,
        }
    ),
    Role.CLINICIAN: frozenset({Permission.VIEW_REGIONAL}),
    Role.AUDITOR: frozenset({Permission.READ_AUDIT}),
    Role.SYSTEM_ADMINISTRATOR: frozenset(
        {
            Permission.MANAGE_USERS,
            Permission.MANAGE_BLOCK,
            Permission.SYSTEM_ADMIN,
        }
    ),
}


def permissions_for(role: Role) -> frozenset[Permission]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def role_has(role: Role, permission: Permission) -> bool:
    return permission in permissions_for(role)
