"""Security-critical behaviour: crypto, tokens, RBAC and the audit chain."""

from __future__ import annotations

import base64
import time
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.exceptions import InvalidTag

from amrss.config import Settings
from amrss.core.audit import GENESIS_HASH, AuditEntry, canonical_json, redact, verify_chain
from amrss.core.crypto import (
    FieldCipher,
    PasswordHasherService,
    Pseudonymiser,
    constant_time_equals,
    generate_key,
    hash_token,
)
from amrss.core.permissions import Permission, Role, has_permission, permissions_for
from amrss.core.tokens import TokenError, TokenService


@pytest.fixture(scope="module")
def settings() -> Settings:
    return Settings(
        environment="test",
        database_url="postgresql+psycopg://u:p@localhost/db",
        jwt_secret=generate_key(),
        field_encryption_key=generate_key(),
        pseudonym_hmac_key=generate_key(),
        # Keep Argon2 cheap so the suite stays fast; production uses the defaults.
        argon2_time_cost=1,
        argon2_memory_cost_kib=8192,
        argon2_parallelism=1,
    )


class TestPasswordHashing:
    def test_hash_is_argon2id_and_salted(self, settings):
        hasher = PasswordHasherService(settings)
        first = hasher.hash("correct horse battery staple")
        second = hasher.hash("correct horse battery staple")
        assert first.startswith("$argon2id$")
        # Distinct salts mean identical passwords never share a hash.
        assert first != second

    def test_verifies_correct_password_and_rejects_wrong_one(self, settings):
        hasher = PasswordHasherService(settings)
        stored = hasher.hash("correct horse battery staple")
        assert hasher.verify(stored, "correct horse battery staple")
        assert not hasher.verify(stored, "Correct horse battery staple")

    def test_unicode_normalisation_is_applied(self, settings):
        hasher = PasswordHasherService(settings)
        # Composed vs decomposed forms of the same string must match.
        stored = hasher.hash("paßwort-café-2026")
        assert hasher.verify(stored, "paßwort-café-2026")

    def test_oversized_password_is_rejected_not_hashed(self, settings):
        hasher = PasswordHasherService(settings)
        with pytest.raises(ValueError):
            hasher.hash("a" * 5000)
        # And verification of an oversized candidate fails without doing work.
        stored = hasher.hash("legitimate passphrase")
        assert not hasher.verify(stored, "a" * 5000)

    def test_malformed_stored_hash_does_not_raise(self, settings):
        hasher = PasswordHasherService(settings)
        assert not hasher.verify("not-a-hash", "anything")

    @pytest.mark.parametrize("password", ["short", "password123", "aaaaaaaaaaaaaaaa", "Password"])
    def test_weak_passwords_are_rejected_by_policy(self, settings, password):
        assert PasswordHasherService(settings).validate_strength(password)

    def test_strong_password_passes_policy(self, settings):
        assert PasswordHasherService(settings).validate_strength("Tr0ubad0ur-Kestrel!92") == []

    def test_dummy_verify_costs_real_work(self, settings):
        """Unknown accounts must not return faster than known ones."""
        hasher = PasswordHasherService(settings)
        stored = hasher.hash("a real passphrase here")

        start = time.perf_counter()
        hasher.verify(stored, "the wrong passphrase")
        real = time.perf_counter() - start

        start = time.perf_counter()
        hasher.dummy_verify()
        decoy = time.perf_counter() - start

        # Same order of magnitude is all that is achievable, and all that matters.
        assert 0.2 < (decoy / real) < 5.0


class TestFieldEncryption:
    def test_round_trips(self, settings):
        cipher = FieldCipher(settings.field_encryption_key)
        blob = cipher.encrypt("MRN-99182", context="patient:abc:mrn")
        assert cipher.decrypt(blob, context="patient:abc:mrn") == "MRN-99182"

    def test_ciphertext_does_not_contain_the_plaintext(self, settings):
        cipher = FieldCipher(settings.field_encryption_key)
        blob = cipher.encrypt("MRN-99182", context="patient:abc:mrn")
        assert b"MRN-99182" not in blob

    def test_nonce_is_fresh_per_encryption(self, settings):
        cipher = FieldCipher(settings.field_encryption_key)
        a = cipher.encrypt("same value", context="patient:abc:mrn")
        b = cipher.encrypt("same value", context="patient:abc:mrn")
        assert a != b

    def test_ciphertext_moved_to_another_row_fails_to_decrypt(self, settings):
        """The AAD binding is what stops a copied ciphertext impersonating a patient."""
        cipher = FieldCipher(settings.field_encryption_key)
        blob = cipher.encrypt("MRN-99182", context="patient:abc:mrn")
        with pytest.raises(InvalidTag):
            cipher.decrypt(blob, context="patient:xyz:mrn")

    def test_tampered_ciphertext_is_rejected(self, settings):
        cipher = FieldCipher(settings.field_encryption_key)
        blob = bytearray(cipher.encrypt("MRN-99182", context="patient:abc:mrn"))
        blob[-1] ^= 0x01
        with pytest.raises(InvalidTag):
            cipher.decrypt(bytes(blob), context="patient:abc:mrn")

    def test_wrong_key_cannot_decrypt(self, settings):
        blob = FieldCipher(settings.field_encryption_key).encrypt("x", context="c")
        with pytest.raises(InvalidTag):
            FieldCipher(generate_key()).decrypt(blob, context="c")

    def test_short_key_is_refused(self):
        with pytest.raises(ValueError):
            FieldCipher(base64.urlsafe_b64encode(b"tooshort").decode())

    def test_key_material_longer_than_the_aes_key_is_accepted(self):
        """HKDF derivation means the configured key need not be exactly 32 bytes."""
        cipher = FieldCipher(generate_key(64))
        blob = cipher.encrypt("value", context="ctx")
        assert cipher.decrypt(blob, context="ctx") == "value"


class TestPseudonymisation:
    def test_is_stable_for_the_same_identifier(self, settings):
        p = Pseudonymiser(settings.pseudonym_hmac_key)
        assert p.derive(identifier_type="mrn", identifier="AB-123") == p.derive(
            identifier_type="mrn", identifier="AB-123"
        )

    def test_normalises_formatting_differences(self, settings):
        p = Pseudonymiser(settings.pseudonym_hmac_key)
        # The same patient recorded three ways must link to one pseudonym.
        assert (
            p.derive(identifier_type="mrn", identifier="ab-123")
            == p.derive(identifier_type="mrn", identifier="AB 123")
            == p.derive(identifier_type="mrn", identifier=" AB123 ")
        )

    def test_different_identifiers_diverge(self, settings):
        p = Pseudonymiser(settings.pseudonym_hmac_key)
        assert p.derive(identifier_type="mrn", identifier="AB-123") != p.derive(
            identifier_type="mrn", identifier="AB-124"
        )

    def test_identifier_type_is_part_of_the_domain(self, settings):
        p = Pseudonymiser(settings.pseudonym_hmac_key)
        assert p.derive(identifier_type="mrn", identifier="123") != p.derive(
            identifier_type="national_id", identifier="123"
        )

    def test_does_not_leak_the_identifier(self, settings):
        p = Pseudonymiser(settings.pseudonym_hmac_key)
        assert "AB123" not in p.derive(identifier_type="mrn", identifier="AB-123")

    def test_empty_identifier_is_rejected(self, settings):
        with pytest.raises(ValueError):
            Pseudonymiser(settings.pseudonym_hmac_key).derive(
                identifier_type="mrn", identifier="---"
            )

    def test_key_change_changes_all_pseudonyms(self, settings):
        # Rotating the HMAC key breaks linkage - documented in docs/security.md.
        a = Pseudonymiser(settings.pseudonym_hmac_key).derive(
            identifier_type="mrn", identifier="AB-123"
        )
        b = Pseudonymiser(generate_key()).derive(identifier_type="mrn", identifier="AB-123")
        assert a != b


class TestTokens:
    def test_access_token_round_trips(self, settings):
        service = TokenService(settings)
        token, claims = service.issue_access_token(
            subject="user-1", session_id="sess-1", roles=("viewer",), mfa_satisfied=True
        )
        decoded = service.decode_access_token(token)
        assert decoded.subject == "user-1"
        assert decoded.session_id == "sess-1"
        assert decoded.roles == ("viewer",)
        assert decoded.jti == claims.jti

    def test_expired_token_is_rejected(self, settings):
        service = TokenService(settings.model_copy(update={"access_token_ttl_seconds": -1}))
        token, _ = service.issue_access_token(
            subject="u", session_id="s", roles=(), mfa_satisfied=False
        )
        with pytest.raises(TokenError):
            service.decode_access_token(token)

    def test_token_signed_with_another_key_is_rejected(self, settings):
        token, _ = TokenService(settings).issue_access_token(
            subject="u", session_id="s", roles=("admin",), mfa_satisfied=True
        )
        other = TokenService(settings.model_copy(update={"jwt_secret": generate_key()}))
        with pytest.raises(TokenError):
            other.decode_access_token(token)

    def test_alg_none_token_is_rejected(self, settings):
        """The classic JWT bypass: an unsigned token claiming alg=none."""
        forged = jwt.encode(
            {
                "sub": "attacker",
                "sid": "s",
                "roles": ["admin"],
                "iss": settings.jwt_issuer,
                "aud": settings.jwt_audience,
                "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp()),
                "iat": int(datetime.now(UTC).timestamp()),
                "nbf": int(datetime.now(UTC).timestamp()),
                "jti": "x",
                "typ": "access",
            },
            key="",
            algorithm="none",
        )
        with pytest.raises(TokenError):
            TokenService(settings).decode_access_token(forged)

    def test_wrong_audience_is_rejected(self, settings):
        issuer = TokenService(settings.model_copy(update={"jwt_audience": "other-api"}))
        token, _ = issuer.issue_access_token(
            subject="u", session_id="s", roles=(), mfa_satisfied=False
        )
        with pytest.raises(TokenError):
            TokenService(settings).decode_access_token(token)

    def test_refresh_token_is_opaque_and_stored_hashed(self, settings):
        issued = TokenService(settings).issue_refresh_token()
        # Not a JWT - nothing to decode, nothing to forge.
        assert issued.token.count(".") == 0
        assert issued.token_hash == hash_token(issued.token)
        assert issued.token not in issued.token_hash

    def test_refresh_tokens_are_unique(self, settings):
        service = TokenService(settings)
        tokens = {service.issue_refresh_token().token for _ in range(50)}
        assert len(tokens) == 50

    def test_garbage_token_is_rejected(self, settings):
        with pytest.raises(TokenError):
            TokenService(settings).decode_access_token("not.a.token")

    def test_signing_key_meets_the_algorithms_length_requirement(self, settings):
        """HS512 with a 32-byte key is weaker than it looks; config must refuse it."""
        with pytest.raises(ValueError, match="64 bytes"):
            weak = settings.model_copy(update={"jwt_secret": generate_key(32)})
            weak.validate_signing_key_length()

    def test_hs256_accepts_a_32_byte_key(self, settings):
        ok = Settings(
            environment="test",
            database_url="postgresql+psycopg://u:p@localhost/db",
            jwt_algorithm="HS256",
            jwt_secret=generate_key(32),
            field_encryption_key=generate_key(),
            pseudonym_hmac_key=generate_key(),
        )
        assert ok.jwt_algorithm == "HS256"


class TestPermissions:
    def test_roles_map_to_their_bundles(self):
        assert Permission.AST_RELEASE in permissions_for([Role.MICROBIOLOGIST])
        assert Permission.AST_RELEASE not in permissions_for([Role.LAB_TECHNOLOGIST])

    def test_unknown_role_grants_nothing(self):
        assert permissions_for(["superuser"]) == frozenset()

    def test_multiple_roles_union(self):
        combined = permissions_for([Role.VIEWER, Role.DATA_MANAGER])
        assert Permission.BREAKPOINT_ACTIVATE in combined
        assert Permission.ISOLATE_READ in combined

    def test_admin_cannot_release_results_or_read_identifiers(self):
        """Administering the system is a different job from clinical sign-out."""
        admin = permissions_for([Role.ADMIN])
        assert Permission.AST_RELEASE not in admin
        assert Permission.PATIENT_PII_READ not in admin
        assert Permission.AST_OVERRIDE not in admin

    def test_technologist_cannot_override_the_engine(self):
        assert not has_permission([Role.LAB_TECHNOLOGIST], Permission.AST_OVERRIDE)

    def test_viewer_is_read_only(self):
        viewer = permissions_for([Role.VIEWER])
        assert not any(str(p).endswith((":write", ":release", ":override")) for p in viewer)

    def test_string_role_is_accepted(self):
        assert Permission.ISOLATE_READ in permissions_for("viewer")

    def test_empty_roles_grant_nothing(self):
        assert permissions_for([]) == frozenset()


class TestAuditChain:
    def _entry(self, previous: str, action: str = "test.action") -> AuditEntry:
        return AuditEntry(
            occurred_at=datetime(2026, 6, 1, 12, 0, tzinfo=UTC),
            action=action,
            actor_id="user-1",
            actor_ip="203.0.113.10",
            target_type="isolate",
            target_id="iso-1",
            outcome="success",
            detail={"note": "value"},
            previous_hash=previous,
        )

    def test_hash_is_deterministic(self):
        assert self._entry(GENESIS_HASH).compute_hash() == self._entry(GENESIS_HASH).compute_hash()

    def test_changing_any_field_changes_the_hash(self):
        base = self._entry(GENESIS_HASH).compute_hash()
        assert self._entry(GENESIS_HASH, action="other.action").compute_hash() != base

    def test_valid_chain_verifies(self):
        rows = self._build_chain(3)
        ok, bad = verify_chain(rows)
        assert ok and bad is None

    def test_edited_entry_is_detected(self):
        rows = self._build_chain(3)
        rows[1].action = "tampered.action"
        ok, bad = verify_chain(rows)
        assert not ok
        assert bad == 1

    def test_deleted_entry_is_detected(self):
        rows = self._build_chain(4)
        del rows[1]
        ok, bad = verify_chain(rows)
        # Removing a link breaks the previous_hash of everything after it.
        assert not ok
        assert bad == 1

    def test_reordered_entries_are_detected(self):
        rows = self._build_chain(3)
        rows[0], rows[1] = rows[1], rows[0]
        ok, _ = verify_chain(rows)
        assert not ok

    def _build_chain(self, n: int) -> list:
        class Row:
            pass

        rows = []
        previous = GENESIS_HASH
        for i in range(n):
            entry = self._entry(previous, action=f"action.{i}")
            row = Row()
            for field_name in (
                "occurred_at",
                "action",
                "actor_id",
                "actor_ip",
                "target_type",
                "target_id",
                "outcome",
                "detail",
                "previous_hash",
            ):
                setattr(row, field_name, getattr(entry, field_name))
            row.entry_hash = entry.compute_hash()
            rows.append(row)
            previous = row.entry_hash
        return rows


class TestAuditRedaction:
    def test_sensitive_keys_are_redacted(self):
        cleaned = redact({"password": "hunter2", "email": "a@b.test"})
        assert cleaned["password"] == "[redacted]"
        assert cleaned["email"] == "a@b.test"

    def test_redaction_is_recursive(self):
        cleaned = redact({"outer": {"token": "abc", "list": [{"mrn": "123"}]}})
        assert cleaned["outer"]["token"] == "[redacted]"
        assert cleaned["outer"]["list"][0]["mrn"] == "[redacted]"

    def test_patient_identifiers_never_reach_the_log(self):
        cleaned = redact({"mrn": "99182", "national_id": "X", "date_of_birth": "1990-01-01"})
        assert set(cleaned.values()) == {"[redacted]"}

    def test_key_matching_is_case_insensitive(self):
        assert redact({"Password": "x", "TOKEN": "y"}) == {
            "Password": "[redacted]",
            "TOKEN": "[redacted]",
        }

    def test_canonical_json_is_order_independent(self):
        assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})


class TestConstantTimeCompare:
    def test_matches_equal_strings(self):
        assert constant_time_equals("abc", "abc")

    def test_rejects_different_strings(self):
        assert not constant_time_equals("abc", "abd")
        assert not constant_time_equals("abc", "abcd")
