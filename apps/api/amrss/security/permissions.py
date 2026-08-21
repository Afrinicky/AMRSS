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

    #: Bring a regional block into existence, or retire one.
    #:
    #: Separate from MANAGE_BLOCK, which is *running* the block you belong to.
    #: A regional administrator configures its own region; deciding that a new
    #: region exists at all is a national act, and a role that could do it would
    #: be able to mint itself a second region to administer.
    CREATE_BLOCK = "block:create"

    # Breakpoint governance
    #:
    #: Publish the table the whole programme interprets against. National, and
    #: national only: two authorities publishing breakpoints means two
    #: definitions of resistance in one surveillance dataset.
    PUBLISH_NATIONAL_BREAKPOINTS = "breakpoints:publish_national"
    #: Decide which facilities may depart from that table locally. Held with the
    #: publishing permission, because permitting an exception and defining the
    #: rule are the same job.
    GRANT_BREAKPOINT_OVERRIDE = "breakpoints:grant_override"
    #: Edit breakpoints for one's own facility. Necessary but not sufficient:
    #: the facility must also carry the grant above. See
    #: ``amrss.security.breakpoint_scope``.
    EDIT_LOCAL_BREAKPOINTS = "breakpoints:edit_local"

    # Accountability
    READ_AUDIT = "audit:read"

    # User and system administration
    MANAGE_FACILITY_USERS = "user:manage_facility"
    MANAGE_USERS = "user:manage"
    SYSTEM_ADMIN = "system:admin"

    #: Destroy surveillance data. Deleting a facility with everything it
    #: submitted, or wiping the whole surveillance dataset to start a block
    #: over, is irreversible in a way no other administrative action is — so it
    #: is its own permission rather than folded into SYSTEM_ADMIN, and only the
    #: single overall authority holds it.
    PURGE_DATA = "data:purge"


#: SDD 7, rendered as data.
#:
#: Two separations are deliberate and must not be collapsed.
#:
#: **The Auditor** reads the trail but holds no operational permission, so
#: accountability stays independent of the administration it examines.
#:
#: **National authority is not regional authority.** The Superadmin holds every
#: permission there is; the Regional AMR Administrator holds nearly as many but
#: is confined by scope resolution to its own block, and lacks outright the
#: three that are national by nature — creating a regional block, publishing the
#: programme's breakpoint table, and permitting a facility to depart from it.
#: A regional role that could create blocks could hand itself a second region;
#: one that could publish breakpoints would put a second definition of
#: resistance into a shared dataset.
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
            # Holding this does not by itself allow a local departure from the
            # national table: the facility must also carry the superadmin's
            # grant. See amrss.security.breakpoint_scope.may_edit_locally.
            Permission.EDIT_LOCAL_BREAKPOINTS,
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
            # Regional surveillance oversight.
            Permission.VIEW_REGIONAL,
            Permission.VIEW_CROSS_FACILITY,
            Permission.VIEW_OWN_FACILITY,
            Permission.REVIEW_BATCH,
            Permission.ENROLL_FACILITY,
            Permission.MANAGE_BLOCK,
            Permission.CONFIGURE_ALERTS,
            Permission.ACKNOWLEDGE_SIGNAL,
            Permission.MANAGE_METHODOLOGY,
            # Also acts on the ground: the overall authority can submit uploads
            # and QC attestations for any facility in its block, not only review
            # them — so a regional programme can enter data itself where a
            # laboratory cannot.
            Permission.UPLOAD_SUBMIT,
            Permission.QC_ATTEST,
            # Data stewardship, so one authority covers the whole pipeline.
            Permission.RETRACT_BATCH,
            Permission.MANAGE_DICTIONARY,
            Permission.REVIEW_MAPPING,
            Permission.MANAGE_QC_GATING,
            # Account administration across the block. Scope resolution — not
            # this table — is what keeps it inside the block: see
            # amrss.security.scope.administers_users_of.
            Permission.MANAGE_USERS,
            Permission.SYSTEM_ADMIN,
            Permission.PURGE_DATA,
            # Local breakpoint editing for facilities in the block that the
            # superadmin has granted an override to.
            Permission.EDIT_LOCAL_BREAKPOINTS,
            # Deliberately absent: CREATE_BLOCK, PUBLISH_NATIONAL_BREAKPOINTS,
            # GRANT_BREAKPOINT_OVERRIDE. All three are national.
        }
    ),
    Role.CLINICIAN: frozenset({Permission.VIEW_REGIONAL}),
    Role.AUDITOR: frozenset({Permission.READ_AUDIT}),
    # The national authority: everything, without exception. Written as "every
    # member of Permission" rather than as a list, so a permission added later
    # cannot be one the superadmin silently lacks.
    Role.SUPERADMIN: frozenset(Permission),
}


#: Precedence, for the one question the permission set cannot answer: may this
#: administrator hand out that role?
#:
#: An administrator may grant a role no higher than its own. Without an ordering
#: the rule has to be written as a matrix that grows quadratically and gets one
#: cell wrong; with it, the rule is a comparison. Roles that confer no
#: administrative authority sit at the bottom together — the ordering is about
#: *authority over accounts*, not about seniority in a laboratory.
ROLE_RANK: dict[Role, int] = {
    Role.CLINICIAN: 0,
    Role.AUDITOR: 0,
    Role.LABORATORY_STAFF: 0,
    Role.DATA_STEWARD: 1,
    Role.FACILITY_ADMINISTRATOR: 2,
    Role.REGIONAL_AMR_ADMINISTRATOR: 3,
    Role.SUPERADMIN: 4,
}


def outranks_or_equals(actor: Role, subject: Role) -> bool:
    """Whether ``actor`` may create, edit or become ``subject``.

    Equality is allowed on purpose: a superadmin appoints the next superadmin,
    and a regional administrator appoints its successor. What is refused is
    reaching *upward* — the rule that stops a regional administrator promoting
    itself, or anyone else, to national authority.
    """
    return ROLE_RANK.get(actor, 0) >= ROLE_RANK.get(subject, 0)


def permissions_for(role: Role) -> frozenset[Permission]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def role_has(role: Role, permission: Permission) -> bool:
    return permission in permissions_for(role)
