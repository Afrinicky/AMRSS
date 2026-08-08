"""Application entrypoint."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from amrss.api.v1.router import api_router
from amrss.config import Settings, get_settings
from amrss.middleware.security import (
    RateLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)

logger = logging.getLogger("amrss")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="AMRSS - Antimicrobial Resistance Surveillance System",
        version="0.1.0",
        # Interactive docs expose the full API shape; keep them off in production.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )

    # Order matters: the last added middleware runs first on the way in.
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)
    app.add_middleware(RateLimitMiddleware, settings=settings)
    app.add_middleware(RequestContextMiddleware)

    if settings.cors_allow_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_allow_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            max_age=600,
        )
    if settings.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts))

    app.include_router(api_router)

    @app.get("/health", tags=["ops"])
    def health() -> dict[str, str]:
        """Liveness only - deliberately reveals nothing about the deployment."""
        return {"status": "ok"}

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Echoing the submitted body back can reflect patient data into logs
        # and error trackers; return the field errors only.
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "detail": [
                    {"loc": err.get("loc"), "msg": err.get("msg"), "type": err.get("type")}
                    for err in exc.errors()
                ]
            },
        )

    @app.exception_handler(SQLAlchemyError)
    async def _db_error_handler(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        # Database errors carry table names, constraint names and sometimes row
        # values. Log them; never return them.
        logger.exception(
            "database error", extra={"request_id": getattr(request.state, "request_id", None)}
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error"},
        )

    return app


app = create_app()
