"""Application-level behaviour: headers, config hardening, error handling."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from amrss.config import Settings
from amrss.core.crypto import generate_key
from amrss.main import create_app


def make_settings(**overrides) -> Settings:
    base = {
        "environment": "test",
        "database_url": "postgresql+psycopg://u:p@localhost/db",
        "jwt_secret": generate_key(),
        "field_encryption_key": generate_key(),
        "pseudonym_hmac_key": generate_key(),
        # TestClient issues requests to http://testserver by default.
        "trusted_hosts": ("testserver", "lab.example"),
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(make_settings()))


class TestSecurityHeaders:
    def test_health_endpoint_responds(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    @pytest.mark.parametrize(
        ("header", "expected"),
        [
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("Cross-Origin-Opener-Policy", "same-origin"),
        ],
    )
    def test_hardening_headers_are_present(self, client, header, expected):
        assert client.get("/health").headers[header] == expected

    def test_csp_denies_everything_by_default(self, client):
        csp = client.get("/health").headers["Content-Security-Policy"]
        assert "default-src 'none'" in csp
        assert "frame-ancestors 'none'" in csp

    def test_clinical_responses_are_not_cacheable(self, client):
        assert "no-store" in client.get("/health").headers["Cache-Control"]

    def test_hsts_only_in_production(self, client):
        assert "Strict-Transport-Security" not in client.get("/health").headers

    def test_request_id_is_returned(self, client):
        assert client.get("/health").headers["X-Request-ID"]

    def test_client_supplied_request_id_is_echoed_when_safe(self, client):
        response = client.get("/health", headers={"X-Request-ID": "abc-123_XYZ"})
        assert response.headers["X-Request-ID"] == "abc-123_XYZ"

    def test_malicious_request_id_is_replaced(self, client):
        # A header value carrying CRLF or control characters must never be
        # reflected into logs or response headers.
        response = client.get("/health", headers={"X-Request-ID": "bad\r\nInjected: 1"})
        assert response.headers["X-Request-ID"] != "bad\r\nInjected: 1"
        assert "Injected" not in response.headers


class TestAuthenticationRequired:
    def test_protected_endpoint_rejects_anonymous_requests(self, client):
        response = client.post(
            "/api/v1/clsi/interpret",
            json={"organism_code": "ECO", "agent_code": "CIP", "method": "MIC", "mic": "1"},
        )
        assert response.status_code == 401
        assert response.headers.get("WWW-Authenticate") == "Bearer"

    def test_malformed_bearer_token_is_rejected(self, client):
        response = client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
        )
        assert response.status_code == 401

    def test_unknown_scheme_is_rejected(self, client):
        response = client.get("/api/v1/auth/me", headers={"Authorization": "Basic abc123"})
        assert response.status_code == 401


class TestInputValidation:
    def test_unknown_fields_are_rejected(self, client):
        # extra="forbid" stops mass-assignment style payloads.
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "a@b.test", "password": "x", "is_admin": True},
        )
        assert response.status_code == 422

    def test_validation_errors_do_not_echo_the_submitted_body(self, client):
        response = client.post(
            "/api/v1/auth/login",
            json={"email": "not-an-email", "password": "s3cr3t-value-here"},
        )
        assert response.status_code == 422
        # The password must not come back in the error response.
        assert "s3cr3t-value-here" not in response.text

    def test_oversized_password_is_rejected_by_schema(self, client):
        response = client.post(
            "/api/v1/auth/login", json={"email": "a@b.test", "password": "x" * 2000}
        )
        assert response.status_code == 422


class TestProductionHardening:
    def test_production_rejects_wildcard_cors(self):
        with pytest.raises(ValidationError, match="cors_allow_origins"):
            make_settings(environment="production", cors_allow_origins=("*",))

    def test_production_rejects_plaintext_origins(self):
        with pytest.raises(ValidationError, match="https"):
            make_settings(environment="production", cors_allow_origins=("http://lab.example",))

    def test_production_rejects_debug_mode(self):
        with pytest.raises(ValidationError, match="debug"):
            make_settings(environment="production", debug=True)

    def test_production_rejects_disabling_qc_gating(self):
        # Releasing AST results without in-range QC is a CLSI violation.
        with pytest.raises(ValidationError, match="enforce_qc_gating"):
            make_settings(environment="production", enforce_qc_gating=False)

    def test_production_rejects_placeholder_secrets(self):
        # Base64-encoding a placeholder hides the word from a naive scan but
        # leaves the key just as guessable, so the decoded form is checked too.
        encoded = base64.urlsafe_b64encode(b"changeme" * 9).decode().rstrip("=")
        with pytest.raises(ValidationError, match="placeholder"):
            make_settings(
                environment="production",
                cors_allow_origins=("https://lab.example",),
                jwt_secret=encoded,
            )

    def test_production_rejects_low_entropy_secrets(self):
        repeated = base64.urlsafe_b64encode(b"\xab" * 96).decode().rstrip("=")
        with pytest.raises(ValidationError, match="entropy"):
            make_settings(
                environment="production",
                cors_allow_origins=("https://lab.example",),
                jwt_secret=repeated,
            )

    def test_production_rejects_reused_keys(self):
        shared = generate_key()
        with pytest.raises(ValidationError, match="must all differ"):
            make_settings(
                environment="production",
                cors_allow_origins=("https://lab.example",),
                jwt_secret=shared,
                field_encryption_key=shared,
                pseudonym_hmac_key=shared,
            )

    def test_valid_production_config_is_accepted(self):
        settings = make_settings(
            environment="production", cors_allow_origins=("https://lab.example",)
        )
        assert settings.is_production

    def test_docs_are_disabled_in_production(self):
        app = create_app(
            make_settings(
                environment="production",
                cors_allow_origins=("https://lab.example",),
                trusted_hosts=("lab.example",),
            )
        )
        with TestClient(app, base_url="https://lab.example") as prod_client:
            assert prod_client.get("/docs").status_code == 404
            assert prod_client.get("/openapi.json").status_code == 404

    def test_hsts_is_set_in_production(self):
        app = create_app(
            make_settings(
                environment="production",
                cors_allow_origins=("https://lab.example",),
                trusted_hosts=("lab.example",),
            )
        )
        with TestClient(app, base_url="https://lab.example") as prod_client:
            hsts = prod_client.get("/health").headers["Strict-Transport-Security"]
            assert "includeSubDomains" in hsts


class TestTrustedHosts:
    def test_unknown_host_is_rejected(self):
        app = create_app(make_settings(trusted_hosts=("lab.example",)))
        with TestClient(app, base_url="http://attacker.example") as bad_client:
            assert bad_client.get("/health").status_code == 400


class TestRateLimiting:
    def test_auth_endpoint_is_throttled(self):
        app = create_app(make_settings(login_rate_limit_per_minute=3))
        with TestClient(app) as limited:
            statuses = [
                limited.post(
                    "/api/v1/auth/login", json={"email": "a@b.test", "password": "wrong-pass"}
                ).status_code
                for _ in range(6)
            ]
        assert 429 in statuses
