"""HTTP hardening middleware."""

from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from amrss.config import Settings

# The API returns JSON only and renders nothing, so the policy can be maximally
# restrictive. Loosen it in a separate policy for the (separate) web client.
_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, settings: Settings) -> None:  # noqa: ANN001
        super().__init__(app)
        self._settings = settings

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("Content-Security-Policy", _CSP)
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        headers.setdefault(
            "Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()"
        )
        # Clinical data must never sit in a shared or browser cache.
        headers.setdefault("Cache-Control", "no-store, no-cache, must-revalidate, private")
        headers.setdefault("Pragma", "no-cache")
        if self._settings.is_production:
            headers.setdefault(
                "Strict-Transport-Security",
                f"max-age={self._settings.hsts_max_age_seconds}; includeSubDomains; preload",
            )
        # Server fingerprinting aids targeted exploitation; drop the banner.
        # MutableHeaders has no pop(), so delete only if present.
        if "server" in headers:
            del headers["server"]
        return response


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Attach a request id for correlating logs and audit entries."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-ID", "")
        # Never echo a client-supplied value verbatim into logs or headers.
        if not _is_safe_request_id(request_id):
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


def _is_safe_request_id(value: str) -> bool:
    return 0 < len(value) <= 64 and all(c.isalnum() or c in "-_" for c in value)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Fixed-window in-process rate limiter.

    Adequate for a single-instance deployment. Behind more than one worker,
    back this with Redis - otherwise the effective limit multiplies by the
    worker count. See docs/security.md.
    """

    def __init__(self, app, settings: Settings) -> None:  # noqa: ANN001
        super().__init__(app)
        self._settings = settings
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        bucket = "auth" if request.url.path.startswith("/api/v1/auth") else "api"
        limit = (
            self._settings.login_rate_limit_per_minute
            if bucket == "auth"
            else self._settings.api_rate_limit_per_minute
        )
        key = (bucket, _client_ip(request) or "unknown")
        now = time.monotonic()
        window = self._hits[key]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= limit:
            return JSONResponse(
                {"detail": "Too many requests"},
                status_code=429,
                headers={"Retry-After": "60"},
            )
        window.append(now)
        return await call_next(request)


def _client_ip(request: Request) -> str | None:
    """Client address.

    X-Forwarded-For is *not* trusted here: it is attacker-controlled unless a
    known proxy sets it. Terminate the proxy chain with uvicorn's
    --proxy-headers plus --forwarded-allow-ips so Starlette resolves
    request.client itself.
    """
    return request.client.host if request.client else None
