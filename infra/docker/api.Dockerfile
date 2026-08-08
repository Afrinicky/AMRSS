FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
RUN uv pip install --system --no-cache .

COPY amrss ./amrss
COPY alembic ./alembic
COPY alembic.ini ./

# The API holds de-identified surveillance data and must not run as root.
RUN useradd --create-home --uid 10001 amrss && chown -R amrss:amrss /app
USER amrss

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "amrss.main:app", "--host", "0.0.0.0", "--port", "8000"]
