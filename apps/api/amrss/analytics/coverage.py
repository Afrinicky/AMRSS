"""Surveillance coverage (SDD 4.3) and data freshness (SDD 4.2).

This module answers the question a regional percentage cannot answer about
itself: *is this pattern actually representative?* Fourteen of eighteen
facilities reporting is a different claim from eighteen of eighteen, and a
clinician who cannot see which one they are looking at has been given a number
without its most important qualifier.

Every analytical view carries a freshness summary. AMRSS is only ever as current
as its most recent accepted upload, and it does not simulate a currency it does
not have (SDD 4.1).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from amrss.models import District, Facility, Isolate, UploadBatch
from amrss.models.enums import BatchStatus, FacilityStatus, UploadSchedule

SCHEDULE_DAYS: dict[UploadSchedule, int] = {
    UploadSchedule.WEEKLY: 7,
    UploadSchedule.FORTNIGHTLY: 14,
    UploadSchedule.MONTHLY: 31,
}

#: Grace beyond the nominal interval before a facility counts as overdue. A
#: laboratory that uploads every Monday should not be flagged on Tuesday because
#: a public holiday moved their run by a day.
OVERDUE_GRACE_DAYS = 2


@dataclass(frozen=True)
class FacilityReportingStatus:
    facility_id: uuid.UUID
    facility_name: str
    district_name: str
    schedule: UploadSchedule
    expected_interval_days: int
    last_accepted_upload_at: datetime | None
    days_since_last_upload: int | None
    is_overdue: bool
    quality_verified: bool


@dataclass(frozen=True)
class DataFreshness:
    """The banner required on every analytical view (SDD 4.2)."""

    data_last_updated: datetime | None
    coverage_start: date | None
    coverage_end: date | None
    facilities_contributing: int
    facilities_expected: int
    latest_facility_submission: datetime | None
    completeness_percent: float | None

    @property
    def is_stale(self) -> bool:
        """No accepted upload within a month of the most recent one anywhere."""
        if self.data_last_updated is None:
            return True
        return (datetime.now(UTC) - self.data_last_updated) > timedelta(days=31)


@dataclass(frozen=True)
class CoverageSummary:
    enrolled_facilities: int
    active_facilities: int
    reporting_this_week: int
    reporting_this_month: int
    overdue_facilities: int
    isolates_this_month: int
    districts_covered: int
    districts_total: int
    facilities_excluded_by_quality: int
    facility_status: list[FacilityReportingStatus]


def _facility_scope(regional_block_id: uuid.UUID | None) -> Select:
    stmt = select(Facility, District).join(District, District.id == Facility.district_id)
    if regional_block_id is not None:
        stmt = stmt.where(District.regional_block_id == regional_block_id)
    return stmt


def expected_interval_days(facility: Facility) -> int:
    if facility.upload_schedule is UploadSchedule.CUSTOM:
        return facility.upload_interval_days or SCHEDULE_DAYS[UploadSchedule.WEEKLY]
    return SCHEDULE_DAYS[facility.upload_schedule]


def summarise_coverage(
    db: Session,
    *,
    regional_block_id: uuid.UUID | None,
    as_of: date | None = None,
) -> CoverageSummary:
    as_of = as_of or date.today()
    now = datetime.now(UTC)
    week_ago = now - timedelta(days=7)
    month_start = as_of.replace(day=1)

    rows = db.execute(_facility_scope(regional_block_id)).all()

    statuses: list[FacilityReportingStatus] = []
    active = 0
    reporting_week = 0
    reporting_month = 0
    overdue = 0
    excluded_by_quality = 0

    for facility, district in rows:
        if facility.status is not FacilityStatus.ACTIVE:
            statuses.append(
                FacilityReportingStatus(
                    facility_id=facility.id,
                    facility_name=facility.name,
                    district_name=district.name,
                    schedule=facility.upload_schedule,
                    expected_interval_days=expected_interval_days(facility),
                    last_accepted_upload_at=facility.last_accepted_upload_at,
                    days_since_last_upload=None,
                    is_overdue=False,
                    quality_verified=False,
                )
            )
            continue

        active += 1
        last_upload = facility.last_accepted_upload_at
        interval = expected_interval_days(facility)

        if last_upload is None:
            days_since = None
            is_overdue = True
        else:
            days_since = (now - last_upload).days
            is_overdue = days_since > interval + OVERDUE_GRACE_DAYS
            if last_upload >= week_ago:
                reporting_week += 1
            if last_upload.date() >= month_start:
                reporting_month += 1

        if is_overdue:
            overdue += 1

        verified = facility.quality_is_current(as_of)
        if not verified:
            excluded_by_quality += 1

        statuses.append(
            FacilityReportingStatus(
                facility_id=facility.id,
                facility_name=facility.name,
                district_name=district.name,
                schedule=facility.upload_schedule,
                expected_interval_days=interval,
                last_accepted_upload_at=last_upload,
                days_since_last_upload=days_since,
                is_overdue=is_overdue,
                quality_verified=verified,
            )
        )

    isolates_this_month = (
        db.scalar(
            select(func.count(Isolate.id))
            .join(UploadBatch, UploadBatch.id == Isolate.upload_batch_id)
            .join(Facility, Facility.id == Isolate.facility_id)
            .join(District, District.id == Facility.district_id)
            .where(
                UploadBatch.status == BatchStatus.ACCEPTED,
                Isolate.specimen_date >= month_start,
                *(
                    [District.regional_block_id == regional_block_id]
                    if regional_block_id is not None
                    else []
                ),
            )
        )
        or 0
    )

    districts_total = len({district.id for _, district in rows})
    districts_covered = len(
        {
            district.id
            for facility, district in rows
            if facility.status is FacilityStatus.ACTIVE
            and facility.last_accepted_upload_at is not None
            and facility.last_accepted_upload_at.date() >= month_start
        }
    )

    return CoverageSummary(
        enrolled_facilities=len(rows),
        active_facilities=active,
        reporting_this_week=reporting_week,
        reporting_this_month=reporting_month,
        overdue_facilities=overdue,
        isolates_this_month=isolates_this_month,
        districts_covered=districts_covered,
        districts_total=districts_total,
        facilities_excluded_by_quality=excluded_by_quality,
        facility_status=statuses,
    )


def freshness(
    db: Session,
    *,
    regional_block_id: uuid.UUID | None,
    contributing_facility_ids: set[uuid.UUID] | None = None,
    coverage_start: date | None = None,
    coverage_end: date | None = None,
) -> DataFreshness:
    """Freshness context for one analytical view.

    ``completeness_percent`` is the share of active facilities that contributed to
    *this* view, not a data-quality score. It answers "how much of the region is
    in this number", which is the question a clinician is actually asking.
    """
    scope_filter = (
        [District.regional_block_id == regional_block_id] if regional_block_id is not None else []
    )

    latest = db.scalar(
        select(func.max(UploadBatch.uploaded_at))
        .join(Facility, Facility.id == UploadBatch.facility_id)
        .join(District, District.id == Facility.district_id)
        .where(UploadBatch.status == BatchStatus.ACCEPTED, *scope_filter)
    )

    expected = (
        db.scalar(
            select(func.count(Facility.id))
            .join(District, District.id == Facility.district_id)
            .where(Facility.status == FacilityStatus.ACTIVE, *scope_filter)
        )
        or 0
    )

    contributing = len(contributing_facility_ids) if contributing_facility_ids else 0
    completeness = round(100.0 * contributing / expected, 1) if expected else None

    return DataFreshness(
        data_last_updated=latest,
        coverage_start=coverage_start,
        coverage_end=coverage_end,
        facilities_contributing=contributing,
        facilities_expected=expected,
        latest_facility_submission=latest,
        completeness_percent=completeness,
    )
