from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from amrss import __version__
from amrss.api.routers import (
    admin,
    auth,
    breakpoints,
    ingestion,
    public,
    quality,
    reports,
    surveillance,
    users,
)
from amrss.config import get_settings

DESCRIPTION = """
Antimicrobial Resistance Surveillance System.

AMRSS presents susceptibility patterns with full statistical context. It does not
compute or return treatment recommendations, and no endpoint exposes
patient-identifiable data — de-identification happens at the facility, before
transmission.
"""


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="AMRSS API",
        description=DESCRIPTION,
        version=__version__,
        docs_url="/docs" if not settings.is_production else None,
    )

    # Surveillance responses are JSON full of repeated organism and antimicrobial
    # names, so they compress to a fraction of their size — the regional
    # antibiogram goes from about 36 KB to under 5 KB. Worth it because the
    # dashboard reads this API across the public internet (Vercel in Frankfurt to
    # wherever the API is hosted), where bytes are latency. The 1 KB floor leaves
    # the small responses alone, where framing would cost more than it saves.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    app.include_router(auth.router, prefix="/api/v1")
    app.include_router(ingestion.router, prefix="/api/v1")
    app.include_router(surveillance.router, prefix="/api/v1")
    app.include_router(public.router, prefix="/api/v1")
    app.include_router(breakpoints.router, prefix="/api/v1")
    app.include_router(admin.router, prefix="/api/v1")
    app.include_router(quality.router, prefix="/api/v1")
    app.include_router(reports.router, prefix="/api/v1")
    app.include_router(users.router, prefix="/api/v1")

    @app.get("/", tags=["operations"])
    def root() -> dict[str, str]:
        """What this is, for whoever opened the address in a browser.

        Exists because the first thing anyone does with a new deployment is
        paste its URL into a browser, and answering that with a bare 404 makes
        a working service look like a broken one.

        It names the service and points at the two things worth visiting. It
        deliberately reports nothing about configuration — not the environment,
        not the database, not the origins — because this is the one endpoint
        that answers before anybody has authenticated.
        """
        return {
            "service": "AMRSS Surveillance API",
            "version": __version__,
            "documentation": "/docs",
            "health": "/health/ready",
        }

    @app.get("/health", tags=["operations"])
    def health() -> dict[str, str]:
        """Liveness: is this process running?

        Deliberately touches nothing. A liveness probe that fails when the
        database is briefly unavailable makes an orchestrator kill and restart
        a perfectly healthy process, turning a short outage into a crash loop.
        """
        return {"status": "ok", "version": __version__}

    @app.get("/health/ready", tags=["operations"])
    def readiness(response: Response) -> dict[str, str]:
        """Readiness: can this process actually serve a request?

        Every endpoint that matters reads the database, so an instance that
        cannot is not ready — and the plain liveness check above would call it
        healthy, which is how a load balancer keeps sending traffic to an
        instance that answers 500 to all of it.
        """
        from sqlalchemy import text

        from amrss.db import SessionLocal

        try:
            with SessionLocal() as db:
                db.execute(text("select 1"))
        except Exception as exc:  # the reason belongs in the response
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {
                "status": "unavailable",
                "version": __version__,
                "detail": f"database unreachable: {type(exc).__name__}",
            }
        return {"status": "ready", "version": __version__}

    return app


app = create_app()
