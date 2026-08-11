#!/bin/sh
# Container start-up, in the order a platform needs it.
#
# The ordering here is load-bearing, and was learned from a failed deploy.
# Render watches a new instance for an open port and gives up after a few
# minutes. The first version of this ran migrations *and* the demonstration
# seed before starting uvicorn, so on a free instance — a fraction of a CPU —
# nothing was listening for about seven minutes:
#
#   ==> Port scan timeout reached, no open ports detected.
#   ...
#   Bootstrap (demo): synthetic regional block loaded.
#   INFO:  Uvicorn running on http://0.0.0.0:8000
#
# The application was healthy. It was simply late, and the deploy had already
# been failed by then.
#
# So the two jobs are separated by whether serving without them would be wrong:
#
#   Migrations block. Serving against a schema older than the code is a
#   correctness failure, and they are cheap — seconds, because they are DDL.
#
#   Seeding does not block. It is slow exactly once (a synthetic block of a few
#   thousand isolates), it is idempotent, and an API with an empty dictionary
#   is merely empty, not wrong. It fills in while the service is already up.

set -e

# Bind whatever the platform asked for. Render, Fly and Heroku all inject PORT;
# a plain `docker run` injects nothing, and 8000 is what the rest of this
# repository documents.
PORT="${PORT:-8000}"

echo "==> applying migrations"
alembic upgrade head

# Backgrounded so the port opens now rather than after the seed. Failure is
# reported and then tolerated: a deployment that cannot seed itself is still a
# deployment somebody can sign in to and load data into, and taking the whole
# service down over synthetic demonstration data would be the wrong trade.
#
# `bootstrap` returns immediately when AMRSS_BOOTSTRAP is `none`, which is the
# default and the only correct value in production.
{
  if python -m amrss.cli bootstrap; then
    :
  else
    echo "==> WARNING: bootstrap failed; the API is serving but reference data may be missing" >&2
  fi
} &

echo "==> serving on port ${PORT}"
exec uvicorn amrss.main:app \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --proxy-headers \
  --no-server-header
