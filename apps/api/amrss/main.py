from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from amrss import __version__
from amrss.api.routers import (
    admin,
    auth,
    breakpoints,
    ingestion,
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
    app.include_router(breakpoints.router, prefix="/api/v1")
    app.include_router(admin.router, prefix="/api/v1")
    app.include_router(quality.router, prefix="/api/v1")
    app.include_router(reports.router, prefix="/api/v1")
    app.include_router(users.router, prefix="/api/v1")

    @app.get("/health", tags=["operations"])
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    return app


app = create_app()
