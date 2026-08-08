"""Integration tests against a real PostgreSQL database.

Skipped unless AMRSS_TEST_DATABASE_URL is set, because these exercise
PostgreSQL-specific behaviour (ARRAY, JSONB, advisory locks, the append-only
triggers) that no in-memory database reproduces.

    export AMRSS_TEST_DATABASE_URL=postgresql+psycopg://amrss:x@127.0.0.1:5433/amrss_test
    pytest tests/test_db_integration.py
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import DBAPIError, InternalError
from sqlalchemy.orm import Session, sessionmaker

from amrss.config import Settings
from amrss.core.audit import AuditAction, verify_chain
from amrss.core.crypto import FieldCipher, PasswordHasherService, generate_key
from amrss.core.tokens import TokenService
from amrss.db.models import Base
from amrss.db.models.audit import AuditLogEntry
from amrss.db.models.user import AuthSession, User
from amrss.services import audit_service, auth_service, breakpoint_service

DB_URL = os.environ.get("AMRSS_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DB_URL, reason="AMRSS_TEST_DATABASE_URL not set; skipping database integration tests"
)

PASSWORD = "Tr0ubad0ur-Kestrel!92"


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(DB_URL, poolclass=None)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine) -> Session:
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    # Start each test from a clean slate; audit_log is append-only in
    # production, but the trigger is not installed by create_all.
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(text(f'TRUNCATE TABLE "{table.name}" RESTART IDENTITY CASCADE'))
    session.commit()
    yield session
    session.rollback()
    session.close()


@pytest.fixture(scope="module")
def settings() -> Settings:
    return Settings(
        environment="test",
        database_url=DB_URL.replace("+psycopg", ""),
        jwt_secret=generate_key(),
        field_encryption_key=generate_key(),
        pseudonym_hmac_key=generate_key(),
        argon2_time_cost=1,
        argon2_memory_cost_kib=8192,
        argon2_parallelism=1,
        max_failed_logins=3,
        lockout_seconds=900,
    )


@pytest.fixture
def hasher(settings) -> PasswordHasherService:
    return PasswordHasherService(settings)


@pytest.fixture
def tokens(settings) -> TokenService:
    return TokenService(settings)


@pytest.fixture
def cipher(settings) -> FieldCipher:
    return FieldCipher(settings.field_encryption_key)


def make_user(db: Session, hasher: PasswordHasherService, **overrides) -> User:
    user = User(
        email=overrides.get("email", "tech@lab.test"),
        full_name="Test Technologist",
        password_hash=hasher.hash(overrides.get("password", PASSWORD)),
        roles=overrides.get("roles", ["lab_technologist"]),
        is_active=overrides.get("is_active", True),
    )
    db.add(user)
    db.commit()
    return user


def login(db, settings, hasher, tokens, cipher, **kwargs):
    return auth_service.authenticate(
        db,
        email=kwargs.get("email", "tech@lab.test"),
        password=kwargs.get("password", PASSWORD),
        totp_code=kwargs.get("totp_code"),
        settings=settings,
        hasher=hasher,
        tokens=tokens,
        cipher=cipher,
        source_ip=kwargs.get("source_ip", "203.0.113.5"),
        user_agent="pytest",
    )


class TestAuditChainPersistence:
    def test_entries_are_linked_in_order(self, db):
        for i in range(5):
            audit_service.record(db, action=f"test.action.{i}", detail={"index": i})
        db.commit()

        rows = list(db.scalars(select(AuditLogEntry).order_by(AuditLogEntry.seq)))
        assert len(rows) == 5
        ok, bad = verify_chain(rows)
        assert ok, f"chain broken at index {bad}"

    def test_first_entry_links_to_genesis(self, db):
        audit_service.record(db, action="first.entry")
        db.commit()
        row = db.scalar(select(AuditLogEntry))
        assert row.previous_hash == "0" * 64

    def test_secrets_are_redacted_before_storage(self, db):
        audit_service.record(
            db, action="test.redaction", detail={"password": "hunter2", "mrn": "99182"}
        )
        db.commit()
        row = db.scalar(select(AuditLogEntry))
        assert row.detail["password"] == "[redacted]"
        assert row.detail["mrn"] == "[redacted]"
        # And the raw value must appear nowhere in the row.
        assert "hunter2" not in str(row.detail)

    def test_tampering_is_detectable_after_the_fact(self, db):
        for i in range(3):
            audit_service.record(db, action=f"test.{i}")
        db.commit()

        rows = list(db.scalars(select(AuditLogEntry).order_by(AuditLogEntry.seq)))
        rows[1].action = "quietly.changed"
        db.commit()

        fresh = list(db.scalars(select(AuditLogEntry).order_by(AuditLogEntry.seq)))
        ok, bad = verify_chain(fresh)
        assert not ok
        assert bad == 1


class TestAppendOnlyTriggers:
    """The triggers ship in migration 0002 rather than in create_all."""

    @pytest.fixture
    def db_with_triggers(self, db):
        db.execute(
            text(
                """
                CREATE OR REPLACE FUNCTION amrss_audit_log_immutable()
                RETURNS TRIGGER AS $$
                BEGIN
                    RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
                        USING ERRCODE = 'restrict_violation';
                END;
                $$ LANGUAGE plpgsql;
                """
            )
        )
        for op_name in ("UPDATE", "DELETE"):
            db.execute(
                text(
                    f"CREATE TRIGGER audit_log_no_{op_name.lower()} BEFORE {op_name} "
                    "ON audit_log FOR EACH ROW "
                    "EXECUTE FUNCTION amrss_audit_log_immutable();"
                )
            )
        db.commit()
        yield db
        db.rollback()
        for op_name in ("update", "delete"):
            db.execute(text(f"DROP TRIGGER IF EXISTS audit_log_no_{op_name} ON audit_log;"))
        db.commit()

    def test_insert_is_permitted(self, db_with_triggers):
        audit_service.record(db_with_triggers, action="test.insert")
        db_with_triggers.commit()
        assert db_with_triggers.scalar(select(AuditLogEntry)) is not None

    def test_update_is_rejected_by_the_database(self, db_with_triggers):
        audit_service.record(db_with_triggers, action="test.insert")
        db_with_triggers.commit()
        with pytest.raises((DBAPIError, InternalError), match="append-only"):
            db_with_triggers.execute(text("UPDATE audit_log SET action = 'tampered'"))
            db_with_triggers.commit()

    def test_delete_is_rejected_by_the_database(self, db_with_triggers):
        audit_service.record(db_with_triggers, action="test.insert")
        db_with_triggers.commit()
        with pytest.raises((DBAPIError, InternalError), match="append-only"):
            db_with_triggers.execute(text("DELETE FROM audit_log"))
            db_with_triggers.commit()


class TestAuthenticationFlow:
    def test_successful_login_issues_tokens_and_audits(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        result = login(db, settings, hasher, tokens, cipher)
        db.commit()

        assert result.access_token and result.refresh_token
        claims = tokens.decode_access_token(result.access_token)
        assert claims.subject == str(result.user.id)

        actions = set(db.scalars(select(AuditLogEntry.action)))
        assert AuditAction.LOGIN_SUCCESS in actions

    def test_refresh_token_is_stored_only_as_a_hash(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        result = login(db, settings, hasher, tokens, cipher)
        db.commit()
        session = db.get(AuthSession, result.session.id)
        assert session.refresh_token_hash != result.refresh_token
        assert session.refresh_token_hash == TokenService.hash_refresh_token(result.refresh_token)

    def test_wrong_password_is_rejected_and_counted(self, db, settings, hasher, tokens, cipher):
        user = make_user(db, hasher)
        with pytest.raises(auth_service.AuthenticationError):
            login(db, settings, hasher, tokens, cipher, password="wrong-password-here")
        db.commit()
        db.refresh(user)
        assert user.failed_login_count == 1

    def test_account_locks_after_repeated_failures(self, db, settings, hasher, tokens, cipher):
        user = make_user(db, hasher)
        for _ in range(settings.max_failed_logins):
            with pytest.raises(auth_service.AuthenticationError):
                login(db, settings, hasher, tokens, cipher, password="wrong-password-here")
            db.commit()

        db.refresh(user)
        assert user.locked_until is not None
        # Even the correct password must not open a session while locked.
        with pytest.raises(auth_service.AccountLocked):
            login(db, settings, hasher, tokens, cipher)

    def test_unknown_account_gives_the_same_error(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        with pytest.raises(auth_service.AuthenticationError) as unknown:
            login(db, settings, hasher, tokens, cipher, email="nobody@lab.test")
        db.commit()
        with pytest.raises(auth_service.AuthenticationError) as wrong:
            login(db, settings, hasher, tokens, cipher, password="wrong-password-here")
        # Identical messages, so the response cannot enumerate accounts.
        assert str(unknown.value) == str(wrong.value)

    def test_inactive_account_cannot_log_in(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher, is_active=False)
        with pytest.raises(auth_service.AuthenticationError):
            login(db, settings, hasher, tokens, cipher)

    def test_role_requiring_mfa_cannot_log_in_without_enrolment(
        self, db, settings, hasher, tokens, cipher
    ):
        make_user(db, hasher, email="admin@lab.test", roles=["admin"])
        with pytest.raises(auth_service.AuthenticationError, match="Multi-factor"):
            login(db, settings, hasher, tokens, cipher, email="admin@lab.test")

    def test_successful_login_clears_the_failure_counter(
        self, db, settings, hasher, tokens, cipher
    ):
        user = make_user(db, hasher)
        with pytest.raises(auth_service.AuthenticationError):
            login(db, settings, hasher, tokens, cipher, password="wrong-password-here")
        db.commit()
        login(db, settings, hasher, tokens, cipher)
        db.commit()
        db.refresh(user)
        assert user.failed_login_count == 0
        assert user.last_login_at is not None


class TestRefreshTokenRotation:
    def test_refresh_issues_a_new_pair(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        first = login(db, settings, hasher, tokens, cipher)
        db.commit()

        second = auth_service.rotate_refresh_token(
            db,
            presented_token=first.refresh_token,
            tokens=tokens,
            settings=settings,
            source_ip="203.0.113.5",
        )
        db.commit()
        assert second.refresh_token != first.refresh_token

    def test_replaying_a_rotated_token_revokes_the_session(
        self, db, settings, hasher, tokens, cipher
    ):
        """The signature of a stolen refresh token."""
        make_user(db, hasher)
        first = login(db, settings, hasher, tokens, cipher)
        db.commit()
        session_id = first.session.id

        auth_service.rotate_refresh_token(
            db,
            presented_token=first.refresh_token,
            tokens=tokens,
            settings=settings,
            source_ip="203.0.113.5",
        )
        db.commit()

        # The old token is presented again - by an attacker, or by the victim.
        with pytest.raises(auth_service.AuthenticationError):
            auth_service.rotate_refresh_token(
                db,
                presented_token=first.refresh_token,
                tokens=tokens,
                settings=settings,
                source_ip="198.51.100.9",
            )
        db.commit()

        session = db.get(AuthSession, session_id)
        assert session.revoked_at is not None
        assert session.revoked_reason == "refresh_token_reuse"
        assert AuditAction.TOKEN_REUSE_DETECTED in set(db.scalars(select(AuditLogEntry.action)))

    def test_revoked_session_cannot_refresh(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        result = login(db, settings, hasher, tokens, cipher)
        db.commit()
        auth_service.revoke_session(
            db, session_id=result.session.id, actor_id=result.user.id, source_ip=None
        )
        db.commit()
        with pytest.raises(auth_service.AuthenticationError):
            auth_service.rotate_refresh_token(
                db,
                presented_token=result.refresh_token,
                tokens=tokens,
                settings=settings,
                source_ip=None,
            )

    def test_expired_session_cannot_refresh(self, db, settings, hasher, tokens, cipher):
        make_user(db, hasher)
        result = login(db, settings, hasher, tokens, cipher)
        session = db.get(AuthSession, result.session.id)
        session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
        with pytest.raises(auth_service.AuthenticationError):
            auth_service.rotate_refresh_token(
                db,
                presented_token=result.refresh_token,
                tokens=tokens,
                settings=settings,
                source_ip=None,
            )

    def test_unknown_token_is_rejected(self, db, settings, tokens):
        with pytest.raises(auth_service.AuthenticationError):
            auth_service.rotate_refresh_token(
                db,
                presented_token="not-a-real-token-value-here",
                tokens=tokens,
                settings=settings,
                source_ip=None,
            )


class TestBreakpointImport:
    ROWS = [
        {
            "organism_group": "Enterobacterales",
            "agent_code": "CIP",
            "method": "MIC",
            "mic_susceptible_max": "0.25",
            "mic_resistant_min": "1",
            "table_reference": "Fixture",
            "tier": "1",
        },
        {
            "organism_group": "Enterobacterales",
            "agent_code": "AMP",
            "method": "DISK",
            "disk_susceptible_min": "17",
            "disk_resistant_max": "13",
            "disk_content": "10 ug",
            "tier": "1",
        },
    ]

    def test_import_creates_an_inactive_set(self, db):
        record = breakpoint_service.import_set(
            db,
            version="TEST-v1",
            source_edition="Fixture edition",
            rows=self.ROWS,
            actor_id=None,
        )
        db.commit()
        # An imported set must be reviewed before it can interpret anything.
        assert record.activated_at is None
        assert not record.is_active
        assert len(record.breakpoints) == 2

    def test_import_records_a_checksum_of_the_source(self, db):
        record = breakpoint_service.import_set(
            db, version="TEST-v1", source_edition="Fixture", rows=self.ROWS, actor_id=None
        )
        db.commit()
        assert record.source_checksum and len(record.source_checksum) == 64

    def test_invalid_table_is_rejected_entirely(self, db):
        bad = [{**self.ROWS[0], "mic_susceptible_max": "8", "mic_resistant_min": "1"}]
        with pytest.raises(breakpoint_service.BreakpointImportError):
            breakpoint_service.import_set(
                db, version="TEST-bad", source_edition="Fixture", rows=bad, actor_id=None
            )
        db.rollback()
        # Nothing partially loaded.
        assert breakpoint_service.load_set(db, "TEST-bad") is None

    def test_duplicate_version_is_refused(self, db):
        breakpoint_service.import_set(
            db, version="TEST-v1", source_edition="Fixture", rows=self.ROWS, actor_id=None
        )
        db.commit()
        with pytest.raises(ValueError, match="already exists"):
            breakpoint_service.import_set(
                db, version="TEST-v1", source_edition="Fixture", rows=self.ROWS, actor_id=None
            )

    def test_activation_retires_the_previous_set(self, db):
        breakpoint_service.import_set(
            db, version="TEST-v1", source_edition="Ed1", rows=self.ROWS, actor_id=None
        )
        breakpoint_service.import_set(
            db, version="TEST-v2", source_edition="Ed2", rows=self.ROWS, actor_id=None
        )
        db.commit()

        breakpoint_service.activate_set(db, version="TEST-v1", actor_id=None)
        db.commit()
        assert breakpoint_service.load_active_set(db).version == "TEST-v1"

        breakpoint_service.activate_set(db, version="TEST-v2", actor_id=None)
        db.commit()
        active = breakpoint_service.load_active_set(db)
        assert active.version == "TEST-v2"

    def test_activation_is_audited(self, db):
        breakpoint_service.import_set(
            db, version="TEST-v1", source_edition="Ed1", rows=self.ROWS, actor_id=None
        )
        breakpoint_service.activate_set(db, version="TEST-v1", actor_id=None)
        db.commit()
        actions = set(db.scalars(select(AuditLogEntry.action)))
        assert AuditAction.BREAKPOINT_SET_IMPORTED in actions
        assert AuditAction.BREAKPOINT_SET_ACTIVATED in actions

    def test_loaded_set_interprets_correctly(self, db):
        from amrss.clsi.breakpoints import Category, Method
        from amrss.clsi.interpretation import interpret
        from amrss.clsi.mic import MICValue

        breakpoint_service.import_set(
            db, version="TEST-v1", source_edition="Ed1", rows=self.ROWS, actor_id=None
        )
        breakpoint_service.activate_set(db, version="TEST-v1", actor_id=None)
        db.commit()

        bp_set = breakpoint_service.load_active_set(db)
        result = interpret(
            breakpoint_set=bp_set,
            organism_groups=("Escherichia coli", "Enterobacterales"),
            agent_code="CIP",
            method=Method.MIC,
            mic=MICValue.parse("0.25"),
        )
        # Round-trip through the database must preserve Decimal precision.
        assert result.category is Category.S
        assert result.set_version == "TEST-v1"


class TestPatientPrivacy:
    def test_identifiers_are_stored_encrypted_and_searchable_by_pseudonym(
        self, db, settings, cipher
    ):
        from amrss.core.crypto import Pseudonymiser
        from amrss.db.models.clinical import Patient

        pseudonymiser = Pseudonymiser(settings.pseudonym_hmac_key)
        patient = Patient(
            pseudonym=pseudonymiser.derive(identifier_type="mrn", identifier="MRN-99182"),
            identifier_type="mrn",
            birth_year=1984,
            sex="female",
        )
        db.add(patient)
        db.flush()
        patient.mrn_encrypted = cipher.encrypt("MRN-99182", context=patient.pii_context("mrn"))
        db.commit()

        # The raw identifier appears nowhere in the stored row.
        stored = db.get(Patient, patient.id)
        assert b"MRN-99182" not in stored.mrn_encrypted
        # But the same patient is still findable on a later visit.
        found = db.scalar(
            select(Patient).where(
                Patient.pseudonym
                == pseudonymiser.derive(identifier_type="mrn", identifier="mrn 99182")
            )
        )
        assert found is not None and found.id == patient.id
        assert cipher.decrypt(found.mrn_encrypted, context=found.pii_context("mrn")) == "MRN-99182"

    def test_ast_override_requires_a_reason(self, db):
        """Enforced by a database CHECK, not just application code."""
        from sqlalchemy.exc import IntegrityError

        from amrss.db.models.clinical import ASTResult

        db.add(
            ASTResult(
                isolate_id=uuid.uuid4(),
                agent_code="CIP",
                method="MIC",
                mic_operator="=",
                mic_value=1,
                overridden_category="R",
                override_reason=None,
                tested_at=datetime.now(UTC),
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
