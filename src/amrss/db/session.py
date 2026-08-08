"""Engine and session management.

The engine sets a server-side statement timeout so a pathological query cannot
pin a connection indefinitely, and disables SQLAlchemy's SQL echo unconditionally
in production so credentials and patient data never reach the logs.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from amrss.config import Settings, get_settings

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def build_engine(settings: Settings, *, readonly: bool = False) -> Engine:
    url = settings.database_url_readonly if readonly else settings.database_url
    if url is None:
        url = settings.database_url
    engine = create_engine(
        str(url),
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_pre_ping=True,
        # Recycle below typical proxy/idle timeouts to avoid stale connections.
        pool_recycle=1800,
        echo=False,
        connect_args={
            "options": f"-c statement_timeout={settings.db_statement_timeout_ms}",
            "application_name": "amrss-readonly" if readonly else "amrss",
        },
    )

    if readonly:

        @event.listens_for(engine, "connect")
        def _enforce_readonly(dbapi_connection, _record) -> None:  # noqa: ANN001
            with dbapi_connection.cursor() as cur:
                cur.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")

    return engine


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = build_engine(get_settings())
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)
    return _SessionLocal


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a session that always closes."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
