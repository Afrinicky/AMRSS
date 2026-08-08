"""Application configuration.

Security posture: every secret is required from the environment. There are no
usable defaults, so a misconfigured deployment fails to start rather than
running with a guessable key. `Settings.validate_production()` additionally
refuses weak or placeholder values when ENVIRONMENT=production.
"""

from __future__ import annotations

import base64
import re
from functools import lru_cache
from typing import Literal

from pydantic import PostgresDsn, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Values that show up in tutorials and .env.example files. Refused in production
# so a copy-pasted example can never become a live signing key.
_PLACEHOLDER_PATTERN = re.compile(
    r"change[-_ ]?me|placeholder|example|secret{2,}|^test|xxxx|password|123456",
    re.IGNORECASE,
)

MIN_SECRET_BYTES = 32

# RFC 7518 section 3.2: an HMAC key must be at least as long as the hash output.
# A shorter key silently weakens the signature below the algorithm's nominal
# strength, so it is refused rather than warned about.
_HMAC_MIN_BYTES = {"HS256": 32, "HS512": 64}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="AMRSS_",
        extra="forbid",
        # Secrets should not be echoed by accident in tracebacks / reprs.
        hide_input_in_errors=True,
    )

    environment: Literal["development", "test", "staging", "production"] = "development"
    debug: bool = False

    database_url: PostgresDsn
    # Separate, lower-privilege DSN used by read-only reporting queries.
    database_url_readonly: PostgresDsn | None = None
    db_pool_size: int = 10
    db_max_overflow: int = 5
    db_statement_timeout_ms: int = 15_000

    # --- Cryptography -----------------------------------------------------
    # JWT signing key. Base64url, >= 32 bytes of entropy.
    jwt_secret: str
    jwt_algorithm: Literal["HS256", "HS512"] = "HS512"
    access_token_ttl_seconds: int = 900  # 15 min - short by design
    refresh_token_ttl_seconds: int = 43_200  # 12 h - one shift
    jwt_issuer: str = "amrss"
    jwt_audience: str = "amrss-api"

    # AES-256-GCM key for encrypting direct patient identifiers at rest.
    field_encryption_key: str
    # HMAC key used to derive stable pseudonyms from patient identifiers.
    pseudonym_hmac_key: str

    # --- Authentication policy -------------------------------------------
    password_min_length: int = 12
    max_failed_logins: int = 5
    lockout_seconds: int = 900
    require_mfa_for_roles: tuple[str, ...] = ("admin", "data_manager")
    argon2_time_cost: int = 3
    argon2_memory_cost_kib: int = 65_536
    argon2_parallelism: int = 4

    # --- Transport / CORS -------------------------------------------------
    # Explicit allowlist only. "*" is rejected in production.
    cors_allow_origins: tuple[str, ...] = ()
    trusted_hosts: tuple[str, ...] = ("localhost", "127.0.0.1")
    hsts_max_age_seconds: int = 31_536_000
    session_cookie_secure: bool = True

    # --- Rate limiting ----------------------------------------------------
    login_rate_limit_per_minute: int = 10
    api_rate_limit_per_minute: int = 300

    # --- CLSI -------------------------------------------------------------
    # Identifier of the breakpoint set applied to new results. Interpretations
    # always record the version actually used, so historical results stay
    # reproducible after an edition rollover.
    active_breakpoint_version: str = "CLSI-M100-Ed36"
    # Block release of results whose QC is out of range or missing.
    enforce_qc_gating: bool = True
    # Suppress higher-tier agents unless cascade criteria are met (CLSI M100
    # Table 1 tiered reporting).
    enforce_cascade_reporting: bool = True

    @field_validator("jwt_secret", "field_encryption_key", "pseudonym_hmac_key")
    @classmethod
    def _validate_key_material(cls, v: str, info) -> str:  # noqa: ANN001
        try:
            raw = base64.urlsafe_b64decode(_pad_b64(v))
        except Exception as exc:  # pragma: no cover - defensive
            raise ValueError(
                f"{info.field_name} must be base64url-encoded; "
                f"generate with: python -m amrss.cli gen-key"
            ) from exc
        if len(raw) < MIN_SECRET_BYTES:
            raise ValueError(
                f"{info.field_name} must decode to >= {MIN_SECRET_BYTES} bytes (got {len(raw)})"
            )
        return v

    @model_validator(mode="after")
    def validate_signing_key_length(self) -> Settings:
        """Enforce the HMAC key length the chosen JWT algorithm requires."""
        required = _HMAC_MIN_BYTES[self.jwt_algorithm]
        actual = len(base64.urlsafe_b64decode(_pad_b64(self.jwt_secret)))
        if actual < required:
            raise ValueError(
                f"jwt_secret must decode to >= {required} bytes for "
                f"{self.jwt_algorithm} (got {actual}); generate one with: "
                f"python -m amrss.cli gen-key --bytes {required}"
            )
        return self

    @model_validator(mode="after")
    def validate_production(self) -> Settings:
        if self.environment != "production":
            return self

        problems: list[str] = []
        if self.debug:
            problems.append("debug must be false in production")
        if "*" in self.cors_allow_origins:
            problems.append("cors_allow_origins must not contain '*' in production")
        if any(o.startswith("http://") for o in self.cors_allow_origins):
            problems.append("cors_allow_origins must use https:// in production")
        if not self.session_cookie_secure:
            problems.append("session_cookie_secure must be true in production")
        if not self.enforce_qc_gating:
            problems.append(
                "enforce_qc_gating must be true in production: releasing AST results "
                "without in-range QC violates CLSI M100 QC requirements"
            )
        for name in ("jwt_secret", "field_encryption_key", "pseudonym_hmac_key"):
            value = getattr(self, name)
            # Check the decoded bytes as well as the encoded string: base64ing
            # "changeme-changeme-..." hides the placeholder from a naive scan
            # while leaving the key just as guessable.
            if _PLACEHOLDER_PATTERN.search(value) or _PLACEHOLDER_PATTERN.search(
                _decoded_text(value)
            ):
                problems.append(f"{name} looks like a placeholder value")
            if _has_low_entropy(value):
                problems.append(f"{name} has too little entropy to be a real key")
        # Distinct keys: reusing one secret for signing, encryption and
        # pseudonymisation collapses three separate blast radii into one.
        keys = {self.jwt_secret, self.field_encryption_key, self.pseudonym_hmac_key}
        if len(keys) != 3:
            problems.append(
                "jwt_secret, field_encryption_key and pseudonym_hmac_key must all differ"
            )
        if problems:
            raise ValueError("Insecure production configuration: " + "; ".join(problems))
        return self

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


def _pad_b64(value: str) -> str:
    """base64url decode without requiring the caller to include padding."""
    return value + "=" * (-len(value) % 4)


def _decoded_text(value: str) -> str:
    """Best-effort text view of decoded key material, for placeholder scanning."""
    try:
        return base64.urlsafe_b64decode(_pad_b64(value)).decode("utf-8", errors="ignore")
    except Exception:  # noqa: BLE001 - scanning only; the length check is elsewhere
        return ""


def _has_low_entropy(value: str) -> bool:
    """Catch keys built from a repeated pattern rather than a CSPRNG.

    Real random key material has close to one distinct byte per position at
    these lengths; "aaaa..." or a repeated word does not.
    """
    try:
        raw = base64.urlsafe_b64decode(_pad_b64(value))
    except Exception:  # noqa: BLE001
        return False
    return len(set(raw)) < max(8, len(raw) // 8)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
