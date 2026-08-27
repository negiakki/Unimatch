"""Application settings loaded from environment variables."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration.

    Values may be provided through a `.env` file at the backend root or real
    environment variables. See `.env.example` for the canonical list.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    project_name: str = "UniMatch API"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    # Comma-separated list of allowed CORS origins.
    cors_origins: str = "http://localhost:3000"

    # Supabase credentials are optional until database/auth integration lands;
    # they are intentionally not validated at startup yet.
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [
            origin.strip() for origin in self.cors_origins.split(",") if origin.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
