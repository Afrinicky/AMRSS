# Dashboard image.
#
# Built from the repository root so it shares a context with the API image and
# a single `docker build` invocation pattern:
#
#   docker build -f infra/docker/web.Dockerfile -t amrss-web .

FROM node:22-slim AS build

WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web ./

# AMRSS_API_URL is deliberately absent here. next.config.mjs declares no `env:`
# block, so the address is read from the environment per request at runtime —
# one image can be pointed at staging or production without rebuilding.
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.mjs ./

RUN useradd --create-home --uid 10001 amrss && chown -R amrss:amrss /app
USER amrss

EXPOSE 3000

# The sign-in page renders without an API round trip, so it answers even when
# the API is down — which is what makes this a liveness check for the dashboard
# rather than a disguised check of the API.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
