from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AMRSS_", env_file=".env", extra="ignore")

    environment: Literal["development", "staging", "production"] = "development"
    database_url: str = "postgresql+psycopg://amrss:amrss_dev@localhost:5432/amrss"

    jwt_secret: str = "dev-secret-not-for-production"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 60
    refresh_token_ttl_days: int = 7

    # The Ingestion API rejects uploads from clients below this version (SDD 8.4).
    minimum_uploader_version: str = "0.1.0"
    max_upload_bytes: int = 64 * 1024 * 1024

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # Target processing time for analytics refresh after upload acceptance (SDD 4.1).
    # Confirmed as a performance requirement at build time; SDD 13.8.
    analytics_refresh_target_minutes: int = 15

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.is_production and settings.jwt_secret == "dev-secret-not-for-production":
        raise RuntimeError("AMRSS_JWT_SECRET must be set in production")
    return settings
