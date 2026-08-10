from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEVELOPMENT_JWT_SECRET = "dev-secret-not-for-production"

#: Below this, a signing key is guessable in a way that makes every session
#: forgeable. Generate one with ``python -m amrss.cli gen-secret``.
MIN_JWT_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AMRSS_", env_file=".env", extra="ignore")

    environment: Literal["development", "staging", "production"] = "development"
    database_url: str = "postgresql+psycopg://amrss:amrss_dev@localhost:5432/amrss"

    #: Where migrations run, when that differs from where the application
    #: connects. Neon's pooled endpoint runs pgbouncer in transaction mode,
    #: which cannot execute the session-level statements some DDL needs — the
    #: enum alteration in this project's own history is one. Point the
    #: application at the pooled host and migrations at the direct one.
    #: Falls back to database_url, which is right for a plain PostgreSQL.
    migration_database_url: str | None = None

    jwt_secret: str = DEVELOPMENT_JWT_SECRET
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 60
    refresh_token_ttl_days: int = 7

    # The Ingestion API rejects uploads from clients below this version (SDD 8.4).
    minimum_uploader_version: str = "0.1.0"
    max_upload_bytes: int = 64 * 1024 * 1024

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # Target processing time for analytics refresh after upload acceptance (SDD 4.1).
    # Confirmed as a performance requirement at build time; SDD 13.8.
    analytics_refresh_target_minutes: int = 15

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def migration_url(self) -> str:
        return self.migration_database_url or self.database_url

    @property
    def is_managed_postgres(self) -> bool:
        """A hosted database reached over the public internet.

        Neon and its peers are not on the deployment's private network, so the
        connection crosses the internet and must be encrypted — which is worth
        checking rather than assuming, because a URL without ``sslmode`` still
        connects.
        """
        return any(
            host in self.database_url
            for host in (".neon.tech", ".supabase.co", ".rds.amazonaws.com", ".render.com")
        )


def production_problems(settings: Settings) -> list[str]:
    """Configuration that would make a production deployment unsafe.

    Returned as a list rather than raised one at a time, so an operator fixes
    everything in one pass instead of rediscovering the next problem on each
    restart.

    Each entry is something that fails *silently* in production — a system that
    starts, serves traffic, and is wrong. A missing database is not here,
    because that announces itself on the first request.
    """
    problems: list[str] = []

    if settings.jwt_secret == DEVELOPMENT_JWT_SECRET:
        problems.append(
            "AMRSS_JWT_SECRET is the development default. Anyone reading this "
            "repository can forge a session for any account. "
            "Generate one with: python -m amrss.cli gen-secret"
        )
    elif len(settings.jwt_secret) < MIN_JWT_SECRET_LENGTH:
        problems.append(
            f"AMRSS_JWT_SECRET is {len(settings.jwt_secret)} characters; at least "
            f"{MIN_JWT_SECRET_LENGTH} are needed for a signing key that cannot be guessed."
        )

    # An empty origin list is not a problem: the dashboard calls this API from
    # its own server, never from the browser, so a deployment where no browser
    # origin is trusted is the *tighter* configuration. What is a problem is
    # trusting an origin left over from development, or one reached over plain
    # HTTP, because either widens who may drive the API from a browser.
    local_origins = [
        origin for origin in settings.cors_origins if "localhost" in origin or "127.0.0.1" in origin
    ]
    if local_origins:
        problems.append(
            f"AMRSS_CORS_ORIGINS still trusts a development origin: {', '.join(local_origins)}. "
            "Leave it empty unless a browser calls this API directly."
        )
    if any(origin.startswith("http://") for origin in settings.cors_origins):
        problems.append(
            "AMRSS_CORS_ORIGINS contains a plain-HTTP origin. Sessions and "
            "surveillance responses would cross the network unencrypted."
        )

    # The development database URL carries a password published in this
    # repository, and a deployment still pointing at it is pointing at nothing
    # real — or, worse, at something real with a known password.
    if "amrss_dev" in settings.database_url or "@localhost" in settings.database_url:
        problems.append(
            "AMRSS_DATABASE_URL still looks like the development database. "
            "Point it at the deployment's own PostgreSQL instance."
        )

    # A hosted database is reached across the public internet. Without
    # sslmode=require the driver will happily negotiate an unencrypted
    # connection, and every isolate in the region would cross the network in
    # clear text.
    if settings.is_managed_postgres and "sslmode=" not in settings.database_url:
        problems.append(
            "AMRSS_DATABASE_URL points at a hosted database but does not set "
            "sslmode. Append ?sslmode=require."
        )
    if (
        settings.migration_database_url
        and settings.is_managed_postgres
        and "sslmode=" not in settings.migration_database_url
    ):
        problems.append(
            "AMRSS_MIGRATION_DATABASE_URL does not set sslmode. Append ?sslmode=require."
        )

    # Neon's pooled endpoint cannot run all of this project's migrations. A
    # deployment pointing both at the pooler works until the next migration
    # touches an enum, and then fails halfway through a release.
    if "-pooler." in settings.database_url and "-pooler." in settings.migration_url:
        problems.append(
            "Both AMRSS_DATABASE_URL and migrations point at Neon's pooled endpoint. "
            "Set AMRSS_MIGRATION_DATABASE_URL to the direct (non-pooler) host: "
            "pgbouncer in transaction mode cannot run the session-level DDL some "
            "migrations need."
        )

    return problems


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.is_production:
        problems = production_problems(settings)
        if problems:
            raise RuntimeError(
                "Refusing to start in production with unsafe configuration:\n  - "
                + "\n  - ".join(problems)
            )
    return settings
