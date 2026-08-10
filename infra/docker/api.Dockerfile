# Surveillance API image.
#
# Built from the repository root, not from apps/api. The API depends on
# packages/clsi — the interpretive engine it shares with the laboratory service
# rather than reimplementing (ADR-0005) — and a path dependency outside the
# build context cannot be resolved, so a context of apps/api fails at install.
#
#   docker build -f infra/docker/api.Dockerfile -t amrss-api .

FROM python:3.11-slim AS build

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /src

RUN pip install --no-cache-dir uv

# The shared engine first: it changes far less often than the API, so an API
# edit does not invalidate its layer.
COPY packages/clsi ./packages/clsi

# Sources are copied before the install because the project is built as a wheel
# by hatchling, which needs the package directory present. Installing from a
# lone pyproject.toml fails with nothing to build.
COPY apps/api/pyproject.toml ./apps/api/
COPY apps/api/amrss ./apps/api/amrss

# Two steps, not one: the engine is installed first so that resolving the API's
# `amrss-clsi` requirement finds it already present, rather than depending on
# uv's handling of a path source during a bare `pip install`. It also keeps the
# engine on its own layer.
RUN uv venv /opt/venv \
    && uv pip install --python /opt/venv/bin/python --no-cache ./packages/clsi \
    && uv pip install --python /opt/venv/bin/python --no-cache ./apps/api

# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The API holds de-identified surveillance data and must not run as root.
RUN useradd --create-home --uid 10001 amrss

COPY --from=build /opt/venv /opt/venv

WORKDIR /app
COPY --chown=amrss:amrss apps/api/alembic ./alembic
COPY --chown=amrss:amrss apps/api/alembic.ini ./
# The breakpoint template ships; no breakpoint values do.
COPY --chown=amrss:amrss data/breakpoints/clsi_m100.template.csv ./data/breakpoints/

USER amrss
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"

# Migrations run at start rather than in a separate step, so a deployment can
# never serve an image against a schema older than the code in it. Alembic is
# idempotent: a container that restarts finds nothing to apply.
#
# --proxy-headers is required because TLS terminates upstream; without it every
# request appears to come from the proxy and rate limiting becomes global.
# Set --forwarded-allow-ips to the proxy's address in your deployment.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn amrss.main:app --host 0.0.0.0 --port 8000 --proxy-headers --no-server-header"]
