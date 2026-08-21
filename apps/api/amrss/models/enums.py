"""Controlled vocabularies shared across the AMRSS data model.

These are stored as native PostgreSQL enums so the database itself rejects values
outside the vocabulary. Adding a member is a migration, deliberately.
"""

from enum import StrEnum


class OrganismKingdom(StrEnum):
    """Bacterial and fungal surveillance are co-equal, first-class data types (SDD 1.5)."""

    BACTERIA = "bacteria"
    FUNGI = "fungi"


class SirResult(StrEnum):
    """AST interpretation as reported by the source laboratory.

    AMRSS v1 records the laboratory's interpretation rather than re-interpreting
    MIC or zone values against breakpoints; the breakpoint edition used is carried
    on the batch. SDD (docs/STANDARDS.md, CLSI M100 row).
    """

    SUSCEPTIBLE = "S"
    INTERMEDIATE = "I"
    RESISTANT = "R"
    SUSCEPTIBLE_DOSE_DEPENDENT = "SDD"
    NON_SUSCEPTIBLE = "NS"
    #: The agent was set up but produced no usable interpretation — contaminated
    #: plate, unreadable zone, test not completed. Retained rather than discarded
    #: so that "tested" and "interpretable" counts can both be reported honestly
    #: (SDD 4.2). Dropping these at ingestion would make every denominator
    #: unauditable against the source laboratory's own records.
    NOT_INTERPRETABLE = "NI"
    #: A quantitative measurement (zone diameter or MIC) recorded without an
    #: interpretation. Real WHONET exports frequently carry only millimetre
    #: readings, so this is the common case rather than an edge case. Kept
    #: distinct from NOT_INTERPRETABLE, which means the test produced nothing
    #: usable: a pending result is good data awaiting a breakpoint, and lumping
    #: the two together would hide how much of the panel is recoverable.
    PENDING_INTERPRETATION = "PI"

    @property
    def is_interpretable(self) -> bool:
        """Whether the result belongs in a susceptibility denominator.

        A pending measurement is excluded until breakpoints resolve it. Counting
        it would require guessing a category from a raw millimetre reading, which
        is precisely the judgement AMRSS refuses to make on a laboratory's behalf.
        """
        return self not in (SirResult.NOT_INTERPRETABLE, SirResult.PENDING_INTERPRETATION)

    @property
    def awaits_interpretation(self) -> bool:
        return self is SirResult.PENDING_INTERPRETATION

    @property
    def counts_as_susceptible(self) -> bool:
        """CLSI M39 counts only S toward %S.

        SDD is susceptible at increased exposure, not at standard dosing, and is
        excluded from the numerator — reporting it as susceptible would overstate
        the coverage a clinician can expect from a standard regimen.
        """
        return self is SirResult.SUSCEPTIBLE


class AgeBand(StrEnum):
    """SDD 3.1. Exact age never travels to any cross-facility view."""

    UNDER_5 = "<5"
    FROM_5_TO_14 = "5-14"
    FROM_15_TO_44 = "15-44"
    FROM_45_TO_64 = "45-64"
    FROM_65 = "65+"
    UNKNOWN = "unknown"


class Sex(StrEnum):
    MALE = "male"
    FEMALE = "female"
    UNKNOWN = "unknown"


class CareSetting(StrEnum):
    INPATIENT = "IPD"
    OUTPATIENT = "OPD"
    UNKNOWN = "unknown"


class FacilityStatus(StrEnum):
    """Enrollment lifecycle (SDD 9.2). Only ACTIVE facilities are eligible to
    contribute to the verified regional antibiogram."""

    PENDING = "pending"
    UNDER_VERIFICATION = "under_verification"
    ACTIVE = "active"
    SUSPENDED = "suspended"
    INACTIVE = "inactive"
    RETIRED = "retired"


class BatchStatus(StrEnum):
    """Upload lifecycle (SDD 9.6). Accepted data is never hard-deleted."""

    STAGED = "staged"
    QC_HOLD = "qc_hold"
    ACCEPTED = "accepted"
    QUARANTINED = "quarantined"
    RETRACTED = "retracted"
    REJECTED = "rejected"


class QcStatus(StrEnum):
    SATISFACTORY = "satisfactory"
    UNSATISFACTORY = "unsatisfactory"
    NOT_SUBMITTED = "not_submitted"
    EXPIRED = "expired"


class EqaStatus(StrEnum):
    SATISFACTORY = "satisfactory"
    UNSATISFACTORY = "unsatisfactory"
    NOT_SUBMITTED = "not_submitted"
    EXPIRED = "expired"


class ReportPeriod(StrEnum):
    """Reporting cadences AMRSS publishes on (SDD 9.7)."""

    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    ANNUAL = "annual"
    #: An arbitrary range someone asked for. Kept distinct from the scheduled
    #: cadences so a listing can show which reports are the official series and
    #: which are one-off extracts.
    AD_HOC = "ad_hoc"


class UploadSchedule(StrEnum):
    """Facility-configurable reporting cadence (SDD 4.4)."""

    WEEKLY = "weekly"
    FORTNIGHTLY = "fortnightly"
    MONTHLY = "monthly"
    CUSTOM = "custom"


class Role(StrEnum):
    """SDD 7. Enforced at the API layer, never solely in the UI.

    Authority runs national → regional → facility, and each level is bounded by
    the one above it:

    - ``superadmin`` is **national**. It holds every permission the platform
      defines, and it is the only role that can bring a new regional block into
      existence or publish the breakpoint table the whole programme reads. It
      may sit in a facility or a block, and it may sit in neither — a national
      programme office is not a laboratory, and forcing it to pretend otherwise
      would put a national account inside one region's data.
    - ``regional_amr_administrator`` is **regional**. It is the overall
      authority *within its own block* and nowhere else: it enrols the block's
      facilities, administers the block's accounts, and cannot see or touch
      another region. It previously created blocks; that is now national.
    - everything below is facility- or function-scoped as before.

    The old ``system_administrator`` value is retained in the database enum for
    historical audit rows but is no longer assignable; the 20260817 migration
    reassigned any account that held it.
    """

    LABORATORY_STAFF = "laboratory_staff"
    FACILITY_ADMINISTRATOR = "facility_administrator"
    DATA_STEWARD = "data_steward"
    REGIONAL_AMR_ADMINISTRATOR = "regional_amr_administrator"
    #: The national authority. Deliberately last in declaration order but first
    #: in precedence — see ``amrss.security.permissions.ROLE_RANK``.
    SUPERADMIN = "superadmin"
    CLINICIAN = "clinician"
    AUDITOR = "auditor"


class MethodologyComponent(StrEnum):
    """Everything that can change the value of a published statistic (ADR-0003)."""

    ANTIBIOGRAM = "antibiogram"
    DEDUPLICATION = "deduplication"
    SUPPRESSION = "suppression"
    QC_RULES = "qc_rules"
    EMERGING_SIGNAL_TRIGGER = "emerging_signal_trigger"
    PHENOTYPE_FLAGS = "phenotype_flags"
    AST_BREAKPOINTS = "ast_breakpoints"
    ANALYTICS_ENGINE = "analytics_engine"
    LINKAGE_HASH = "linkage_hash"


class DictionaryEntityType(StrEnum):
    ORGANISM = "organism"
    ANTIBIOTIC = "antibiotic"
    SPECIMEN_TYPE = "specimen_type"


class QcFindingSeverity(StrEnum):
    """Tier-3 automated data QC outcomes (SDD 6.4).

    ERROR blocks acceptance. WARNING holds the batch for Data Steward review.
    INFO is recorded for the quality profile without affecting the lifecycle.
    """

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class MappingStatus(StrEnum):
    """Facility code mappings into the canonical dictionary require Data Steward
    approval before the mapped data contributes to aggregates (SDD 3.4)."""

    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"


class AntimicrobialClass(StrEnum):
    """Grouping used for antibiogram row ordering and the Antibiotic Explorer."""

    PENICILLIN = "penicillin"
    BETA_LACTAM_INHIBITOR = "beta_lactam_inhibitor_combination"
    CEPHALOSPORIN = "cephalosporin"
    CARBAPENEM = "carbapenem"
    MONOBACTAM = "monobactam"
    AMINOGLYCOSIDE = "aminoglycoside"
    FLUOROQUINOLONE = "fluoroquinolone"
    MACROLIDE = "macrolide"
    LINCOSAMIDE = "lincosamide"
    TETRACYCLINE = "tetracycline"
    GLYCOPEPTIDE = "glycopeptide"
    OXAZOLIDINONE = "oxazolidinone"
    FOLATE_INHIBITOR = "folate_pathway_inhibitor"
    NITROFURAN = "nitrofuran"
    POLYMYXIN = "polymyxin"
    PHENICOL = "phenicol"
    AZOLE = "azole"
    ECHINOCANDIN = "echinocandin"
    POLYENE = "polyene"
    PYRIMIDINE_ANALOGUE = "pyrimidine_analogue"
    OTHER = "other"
