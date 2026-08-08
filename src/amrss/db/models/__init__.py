"""Model registry.

Every model must be imported here so Alembic autogenerate and
`Base.metadata.create_all` see the complete schema.
"""

from amrss.db.base import Base
from amrss.db.models.audit import AuditLogEntry
from amrss.db.models.clinical import (
    ASTResult,
    InterpretationHistory,
    Isolate,
    Patient,
    Specimen,
    SurveillanceReportExport,
)
from amrss.db.models.qc import QCRangeRecord, QCResultRecord, QCStrainRecord
from amrss.db.models.reference import (
    Antimicrobial,
    BreakpointRecord,
    BreakpointSetRecord,
    IntrinsicResistanceRecord,
    Organism,
)
from amrss.db.models.user import AuthSession, LoginAttempt, User, UserInvitation

__all__ = [
    "ASTResult",
    "Antimicrobial",
    "AuditLogEntry",
    "AuthSession",
    "Base",
    "BreakpointRecord",
    "BreakpointSetRecord",
    "InterpretationHistory",
    "IntrinsicResistanceRecord",
    "Isolate",
    "LoginAttempt",
    "Organism",
    "Patient",
    "QCRangeRecord",
    "QCResultRecord",
    "QCStrainRecord",
    "Specimen",
    "SurveillanceReportExport",
    "User",
    "UserInvitation",
]
