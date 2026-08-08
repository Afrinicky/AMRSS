# Build stage - wheels are built here so the runtime image carries no compilers.
FROM python:3.11-slim-bookworm AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY src ./src
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install .

# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install --no-install-recommends -y libpq5 \
    && rm -rf /var/lib/apt/lists/* \
    # Run as an unprivileged user; nothing here needs root.
    && useradd --system --create-home --uid 10001 amrss

COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=amrss:amrss alembic.ini ./
COPY --chown=amrss:amrss alembic ./alembic

USER amrss
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status==200 else 1)"

# --proxy-headers with --forwarded-allow-ips lets Starlette resolve the real
# client address from a trusted reverse proxy. Set FORWARDED_ALLOW_IPS to the
# proxy's address; never to "*", which would let any client spoof its IP and
# defeat rate limiting.
CMD ["uvicorn", "amrss.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--proxy-headers", \
     "--no-server-header"]
