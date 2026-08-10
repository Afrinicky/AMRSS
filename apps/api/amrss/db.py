from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from amrss.config import get_settings

_settings = get_settings()

#: A hosted database sits behind a proxy that closes idle connections, and a
#: serverless one may have suspended the compute entirely between requests. Both
#: leave the pool holding sockets that look open and are not.
#:
#: ``pool_pre_ping`` catches that on checkout; recycling well inside the usual
#: idle timeout means it rarely has to. Without them the first request after a
#: quiet period fails, which reads as an intermittent outage rather than as
#: configuration.
engine = create_engine(
    _settings.database_url,
    pool_pre_ping=True,
    pool_recycle=280,
    # Small on purpose. A hosted plan caps connections, and several API
    # instances each holding a large pool exhausts that cap long before the
    # database itself is busy.
    pool_size=5,
    max_overflow=5,
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
