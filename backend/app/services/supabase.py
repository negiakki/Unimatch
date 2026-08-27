"""Supabase client factory (server-side, service role only).

The service-role client performs privileged operations: verification document
storage, submission inserts, and auth-token validation. The service-role key
exists only in the backend environment and must never reach any client.
"""

from functools import lru_cache

from supabase import Client, create_client

from app.core.config import get_settings


class SupabaseNotConfiguredError(RuntimeError):
    """Raised when privileged Supabase access is required but not configured."""


@lru_cache
def get_supabase_service_client() -> Client:
    """Build the cached service-role Supabase client from environment config."""
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise SupabaseNotConfiguredError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured "
            "in the backend environment."
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
