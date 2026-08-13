from functools import lru_cache
from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEVELOPMENT_JWT_SECRET = "dev-secret-not-for-production"

#: The password in the development compose file and in this module's default
#: URL. Anyone reading the repository knows it.
DEVELOPMENT_DB_PASSWORD = "amrss_dev"

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

    #: How long a loaded isolate population stays reusable, in seconds.
    #:
    #: The analytics engine recomputes every answer from raw isolates, and the
    #: expensive part is materialising some 64,000 AST rows into Python objects —
    #: about 1.2 s of CPU on the demonstration block, against 14 ms of actual
    #: database time. That cost is per request and CPU-bound, so on a fractional
    #: CPU it both dominates the response and serialises behind the GIL when a
    #: dashboard page fetches several endpoints at once.
    #:
    #: Sixty seconds is well inside the staleness the product already accepts —
    #: the public pages revalidate on a ten-minute ISR window, and every page
    #: states its true data date in the freshness banner regardless. Acceptance,
    #: retraction and quarantine all clear the cache immediately, so the window
    #: bounds nothing but the lag behind a change made directly in the database.
    #:
    #: Set to 0 to disable, which is what the test suite does: a test that seeds
    #: rows and immediately queries must not be answered from a previous test's
    #: population.
    analytics_cache_ttl_seconds: int = 60

    #: How many scopes to keep loaded at once.
    #:
    #: Each entry holds every isolate in its scope — roughly 17 MB for the
    #: demonstration block — and the free tier this is deployed on gives the
    #: whole process 512 MB. Four covers the public dashboard's working set (the
    #: regional population, with and without panels, plus the empiric sites in
    #: rotation) with room to spare. Raise it only alongside more memory.
    analytics_cache_entries: int = 4

    #: What to load into an empty database when the container starts.
    #:
    #: Exists because the free tiers this project is demonstrated on give no
    #: shell: there is no way to run `python -m amrss.seed` after a deploy, so a
    #: deployment that cannot seed itself cannot be used at all.
    #:
    #: - ``none``       load nothing. The default, and correct for production,
    #:                  where reference data is loaded deliberately and once.
    #: - ``reference``  the organism, antimicrobial and specimen dictionaries
    #:                  and the methodology versions. Safe anywhere.
    #: - ``demo``       the above plus a synthetic regional block with
    #:                  known-password accounts. Refused in production.
    #:
    #: Every mode is idempotent, so a container that restarts re-runs it
    #: harmlessly — which matters on a free tier that sleeps when idle.
    bootstrap: Literal["none", "reference", "demo"] = "none"

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


def connection_url_problems(url: str, label: str) -> list[str]:
    """Ways a database URL is malformed before anything tries to connect.

    Unlike :func:`production_problems`, these are checked in *every*
    environment, because a URL that cannot be parsed is not a policy question.

    This exists because of a real deployment. Neon hands out a string that
    already carries its own query parameters::

        postgresql://u:p@ep-xxx.aws.neon.tech/db?sslmode=require&channel_binding=require

    and docs/DEPLOYMENT.md used to say "append ``?sslmode=require``". Appending
    a second ``?`` does not add a parameter — it lands inside the value of the
    last one, so ``channel_binding`` became ``require?sslmode=require``. The
    container then died deep inside psycopg with ``invalid channel_binding
    value``, which says nothing about where the mistake was or how to fix it.

    The parsing here is deliberately shallow: it looks for the shapes an
    operator produces by hand, not for every invalid URL. Anything subtler is
    the driver's job to report.
    """
    problems: list[str] = []
    if not url:
        return problems

    if url.count("?") > 1:
        problems.append(
            f"{label} contains more than one '?'. A query string was appended to a URL "
            "that already had one, which puts the addition inside the previous "
            "parameter's value rather than adding a parameter. Join them with '&': "
            "'...?sslmode=require&channel_binding=require'."
        )
    else:
        # The same mistake, caught by its result rather than its shape — a
        # value that swallowed a query string.
        for key, value in parse_qsl(urlsplit(url).query):
            if "?" in value:
                problems.append(
                    f"{label} has the parameter '{key}' set to {value!r}, which has a "
                    "query string inside it. Separate parameters with '&', not '?'."
                )

    # psycopg is the only driver installed. A bare postgresql:// URL sends
    # SQLAlchemy looking for psycopg2 and fails with a missing-module error
    # that reads like a broken image rather than a mistyped setting.
    scheme = urlsplit(url).scheme
    if scheme in {"postgres", "postgresql"}:
        problems.append(
            f"{label} uses '{scheme}://', which selects a driver this image does not "
            "carry. Change the scheme to 'postgresql+psycopg://' — only the scheme; "
            "leave the rest of the string exactly as your provider gave it."
        )

    return problems


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

    # The published development credential, and only that. A loopback host is
    # not evidence of anything — a virtual machine running PostgreSQL beside
    # the API is a legitimate deployment — and refusing it would push an
    # operator to work around the check, which is worse than not having one.
    # A database that genuinely is not there announces itself at /health/ready.
    if DEVELOPMENT_DB_PASSWORD in settings.database_url:
        problems.append(
            "AMRSS_DATABASE_URL carries the development password, which is "
            "published in this repository. Point it at the deployment's own "
            "PostgreSQL instance."
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

    # A malformed URL is wrong everywhere, so this is not gated on the
    # environment — the deployment that prompted it was running as `staging`,
    # where the production checks below never ran at all.
    malformed = connection_url_problems(settings.database_url, "AMRSS_DATABASE_URL")
    if settings.migration_database_url:
        malformed += connection_url_problems(
            settings.migration_database_url, "AMRSS_MIGRATION_DATABASE_URL"
        )
    if malformed:
        raise RuntimeError(
            "Refusing to start with an unusable database URL:\n  - " + "\n  - ".join(malformed)
        )

    if settings.is_production:
        problems = production_problems(settings)
        if problems:
            raise RuntimeError(
                "Refusing to start in production with unsafe configuration:\n  - "
                + "\n  - ".join(problems)
            )
    return settings
