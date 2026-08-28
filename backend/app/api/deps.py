"""Shared FastAPI dependencies."""

from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header
from supabase import Client

from app.core.config import Settings, get_settings
from app.core.exceptions import PermissionDeniedError, UnauthorizedError
from app.services import staff as staff_service
from app.services.supabase import get_supabase_service_client

SettingsDep = Annotated[Settings, Depends(get_settings)]
SupabaseDep = Annotated[Client, Depends(get_supabase_service_client)]


def get_current_auth_user_id(
    supabase: SupabaseDep,
    authorization: Annotated[str | None, Header()] = None,
) -> UUID:
    """Resolve the caller's identity from their Supabase Auth bearer token.

    The token is validated by Supabase Auth; ownership is derived exclusively
    from the authenticated identity. Client-supplied identifiers (user_id,
    profile_id, reviewer_id, status, timestamps) carry no authorization weight.
    """
    token = _extract_bearer_token(authorization)
    try:
        response = supabase.auth.get_user(token)
        user = getattr(response, "user", None)
        auth_user_id = getattr(user, "id", None)
        if auth_user_id is None:
            raise UnauthorizedError("Invalid or expired authentication token.")
        return UUID(str(auth_user_id))
    except UnauthorizedError:
        raise
    except Exception as exc:
        raise UnauthorizedError("Invalid or expired authentication token.") from exc


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise UnauthorizedError("Authentication required.")
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise UnauthorizedError("Authentication required.")
    return token


def get_current_staff_user_id(
    auth_user_id: Annotated[UUID, Depends(get_current_auth_user_id)],
    supabase: SupabaseDep,
) -> UUID:
    """Resolve an authorized STAFF reviewer from the bearer token.

    Reuses the student authentication machinery, then checks reviewer
    membership in `public.staff_admins` (service-role client). Authorization
    derives exclusively from the authenticated token's user ID — a client
    cannot become staff by supplying a user_id/reviewer_id.
    """
    if not staff_service.is_staff(supabase, auth_user_id):
        raise PermissionDeniedError("Reviewer authorization required.")
    return auth_user_id


CurrentAuthUserDep = Annotated[UUID, Depends(get_current_auth_user_id)]
CurrentStaffUserDep = Annotated[UUID, Depends(get_current_staff_user_id)]
