"""Cryptographic primitives: password hashing, field encryption, pseudonymisation.

Design notes
------------
* Passwords use Argon2id (memory-hard) rather than bcrypt/PBKDF2.
* Direct patient identifiers are encrypted with AES-256-GCM. The record's
  primary key is bound in as associated data, so a ciphertext copied from one
  row to another fails to decrypt instead of silently impersonating a patient.
* Pseudonyms are HMAC-SHA256 over the identifier, giving a stable, non-
  reversible key for linking a patient's isolates across time without storing
  the identifier in any index.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import secrets
import unicodedata

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from amrss.config import Settings, _pad_b64

# Bound the input to Argon2 so a multi-megabyte "password" cannot be used to
# burn CPU. 1024 bytes is far beyond any legitimate passphrase.
MAX_PASSWORD_BYTES = 1024
NONCE_BYTES = 12
MIN_KEY_BYTES = 32


class PasswordHasherService:
    def __init__(self, settings: Settings) -> None:
        self._hasher = PasswordHasher(
            time_cost=settings.argon2_time_cost,
            memory_cost=settings.argon2_memory_cost_kib,
            parallelism=settings.argon2_parallelism,
        )
        self._min_length = settings.password_min_length
        # Decoy hash for timing equalisation on unknown accounts; built with
        # the same cost parameters so verification work is indistinguishable.
        self._decoy_hash = self._hasher.hash(secrets.token_urlsafe(32))

    @staticmethod
    def _normalize(password: str) -> str:
        # NFKC so visually identical passwords typed on different keyboards or
        # platforms hash identically.
        return unicodedata.normalize("NFKC", password)

    def validate_strength(self, password: str) -> list[str]:
        """Return a list of policy violations (empty means acceptable)."""
        pw = self._normalize(password)
        problems: list[str] = []
        if len(pw) < self._min_length:
            problems.append(f"must be at least {self._min_length} characters")
        if len(pw.encode()) > MAX_PASSWORD_BYTES:
            problems.append("is too long")
        # Composition rules are deliberately light; length and blocklists do
        # more real work than symbol requirements (NIST SP 800-63B).
        if pw.lower() in _COMMON_PASSWORDS:
            problems.append("is a commonly used password")
        if len(set(pw)) < 5:
            problems.append("has too little variety")
        return problems

    def hash(self, password: str) -> str:
        pw = self._normalize(password)
        if len(pw.encode()) > MAX_PASSWORD_BYTES:
            raise ValueError("password too long")
        return self._hasher.hash(pw)

    def verify(self, stored_hash: str, password: str) -> bool:
        pw = self._normalize(password)
        if len(pw.encode()) > MAX_PASSWORD_BYTES:
            return False
        try:
            return self._hasher.verify(stored_hash, pw)
        except (VerifyMismatchError, InvalidHashError):
            return False

    def needs_rehash(self, stored_hash: str) -> bool:
        try:
            return self._hasher.check_needs_rehash(stored_hash)
        except InvalidHashError:
            return True

    def dummy_verify(self) -> None:
        """Burn a comparable amount of CPU for unknown usernames.

        Without this, a login attempt for a non-existent user returns markedly
        faster than one for a real user, which enumerates accounts. The decoy
        hash is generated once with this instance's real Argon2 parameters, so
        the work performed matches a genuine verification.
        """
        with contextlib.suppress(VerifyMismatchError, InvalidHashError):
            self._hasher.verify(self._decoy_hash, secrets.token_urlsafe(16))


_COMMON_PASSWORDS = frozenset(
    {
        "password",
        "password1",
        "password123",
        "qwerty",
        "letmein",
        "welcome",
        "admin",
        "administrator",
        "changeme",
        "iloveyou",
        "monkey",
        "dragon",
        "123456",
        "12345678",
        "123456789",
        "1234567890",
        "microbiology",
        "laboratory",
        "hospital",
    }
)


class FieldCipher:
    """Authenticated encryption for individual database columns.

    The configured key is not used as the AES key directly. It is run through
    HKDF-SHA256 with a fixed info label, which accepts key material of any
    length >= 32 bytes and domain-separates this use from anything else derived
    from the same secret.
    """

    # Changing this label makes every existing ciphertext undecryptable.
    _HKDF_INFO = b"amrss/field-encryption/v1"

    def __init__(self, key_b64: str) -> None:
        material = base64.urlsafe_b64decode(_pad_b64(key_b64))
        if len(material) < MIN_KEY_BYTES:
            raise ValueError(
                f"field_encryption_key must decode to >= {MIN_KEY_BYTES} bytes "
                f"(got {len(material)})"
            )
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,  # AES-256
            salt=None,
            info=self._HKDF_INFO,
        ).derive(material)
        self._aead = AESGCM(key)

    def encrypt(self, plaintext: str, *, context: str) -> bytes:
        """Encrypt, binding `context` (e.g. "patient:<uuid>:mrn") as AAD."""
        nonce = secrets.token_bytes(NONCE_BYTES)
        ct = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return nonce + ct

    def decrypt(self, blob: bytes, *, context: str) -> str:
        if len(blob) <= NONCE_BYTES:
            raise ValueError("ciphertext too short")
        nonce, ct = blob[:NONCE_BYTES], blob[NONCE_BYTES:]
        return self._aead.decrypt(nonce, ct, context.encode("utf-8")).decode("utf-8")


class Pseudonymiser:
    """Derives stable, irreversible patient keys for surveillance linkage."""

    def __init__(self, key_b64: str) -> None:
        self._key = base64.urlsafe_b64decode(_pad_b64(key_b64))

    def derive(self, *, identifier_type: str, identifier: str) -> str:
        # Normalise so "AB-123 " and "ab123" do not become different patients.
        normalised = "".join(ch for ch in identifier.upper() if ch.isalnum())
        if not normalised:
            raise ValueError("identifier contains no usable characters")
        msg = f"{identifier_type.lower()}|{normalised}".encode()
        return hmac.new(self._key, msg, hashlib.sha256).hexdigest()


def generate_key(n_bytes: int = 64) -> str:
    """Generate base64url key material suitable for the settings above.

    Defaults to 64 bytes, which satisfies HS512 (RFC 7518 section 3.2) as well
    as every other key in the configuration.
    """
    return base64.urlsafe_b64encode(secrets.token_bytes(n_bytes)).decode().rstrip("=")


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def hash_token(token: str) -> str:
    """Hash a bearer/refresh token for storage.

    Tokens are high-entropy already, so a single SHA-256 is sufficient and
    keeps lookup cheap; the point is that a database leak yields no usable
    tokens.
    """
    return hashlib.sha256(token.encode()).hexdigest()
