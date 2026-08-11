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
#
# --no-sources is what makes the image work at all. apps/api declares
# `[tool.uv.sources] amrss-clsi = { path = "../../packages/clsi", editable = true }`
# for local development, and honouring it here installs a .pth file pointing at
# /src — a path this stage discards. The container then migrated fine, because
# Alembic does not import the engine, and died the moment uvicorn loaded the
# app. Ignoring the source declaration copies the package into site-packages
# instead, so nothing in the image depends on a build-time path.
RUN uv venv /opt/venv \
    && uv pip install --python /opt/venv/bin/python --no-cache --no-sources ./packages/clsi \
    && uv pip install --python /opt/venv/bin/python --no-cache --no-sources ./apps/api \
    && test ! -e /opt/venv/lib/python3.11/site-packages/__editable__.amrss_clsi-0.1.0.pth

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
COPY --chown=amrss:amrss --chmod=0755 infra/docker/entrypoint.sh ./entrypoint.sh

USER amrss

# Documentation only, and only for the default: the process binds $PORT when the
# platform sets one, which Render, Fly and Heroku all do.
EXPOSE 8000

# Liveness, deliberately, and for the same reason as infra/render/render.yaml:
# a probe that queries the database on a timer keeps a metered database awake
# for as long as the container runs, which on Neon's free plan exhausts a
# month's compute allowance answering health checks.
#
# Reachability is proven once, at start, by the migrations in entrypoint.sh —
# a container that cannot reach its database never binds a port. Repeating that
# check every thirty seconds buys nothing here and costs the allowance.
#
# The start period covers migrations, which run before the port opens. It does
# not need to cover seeding, which no longer does.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','8000')+'/health')"

# The ordering of migrations, seeding and serving is explained in entrypoint.sh,
# and one deploy failure is the reason it is a script rather than a one-liner.
CMD ["./entrypoint.sh"]
