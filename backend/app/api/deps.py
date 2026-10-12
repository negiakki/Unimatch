"""Shared FastAPI dependencies.

This module is the single authorization choke point for the API. Every
authenticated route already resolves its caller through
`get_current_auth_user_id`, so that dependency is also where the account-level
suspension gate lives: recording a suspension in `public.suspensions` blocks
the account everywhere at once, with no per-route checks to forget.

Enforcement is server-side and method-aware. A suspended account is
read-only:

  * any state-changing request (POST / PUT / PATCH / DELETE) is refused;
  * the two discovery feeds are refused as well — they are the entry point to
    every other interaction (likes, passes, interests, applications), so
    blocking only the writes would leave the platform half-usable;
  * ordinary reads of the caller's own data stay available.

There is no staff/admin exemption. Authorization and suspension are two
independent checks: `get_current_staff_user_id` still governs the admin
console via `staff_admins` membership, but a suspended account is gated
everywhere else too — a suspended moderator is subject to the same read-only
rule as any other suspended account. Lifting a moderator's own suspension is a
deliberate act by another (or the same, once reinstated) staff member, not
something staff status grants by default.
"""

from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from supabase import Client

from app.core.config import Settings, get_settings
from app.core.exceptions import PermissionDeniedError, UnauthorizedError
from app.services import admin as admin_service
from app.services import staff as staff_service
from app.services.supabase import get_supabase_service_client

SettingsDep = Annotated[Settings, Depends(get_settings)]
SupabaseDep = Annotated[Client, Depends(get_supabase_service_client)]

# Safe HTTP methods never mutate state, so they are never gated.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Route templates (as mounted on the app router, i.e. without the /api/v1
# prefix) whose reads are interaction entry points rather than plain reads, so
# a suspended account must not reach them either.
_SUSPENDED_READ_DENYLIST = (
    "/discovery/feed",
    "/opportunities/{opportunity_id}/discovery",
)


def get_current_auth_user_id(
    supabase: SupabaseDep,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> UUID:
    """Resolve the caller's identity from their Supabase Auth bearer token.

    The token is validated by Supabase Auth; ownership is derived exclusively
    from the authenticated identity. Client-supplied identifiers (user_id,
    profile_id, reviewer_id, status, timestamps) carry no authorization weight.

    On a request that would change state (or read a discovery feed), an active
    suspension on the caller's profile rejects the call with 403
    `account_suspended` — before any handler runs, and on admin routes too.
    Lapsed timed suspensions are ignored, so an account regains access
    automatically once one expires.
    """
    token = _extract_bearer_token(authorization)
    try:
        response = supabase.auth.get_user(token)
        user = getattr(response, "user", None)
        auth_user_id = getattr(user, "id", None)
        if auth_user_id is None:
            raise UnauthorizedError("Invalid or expired authentication token.")
        auth_user_id = UUID(str(auth_user_id))
    except UnauthorizedError:
        raise
    except Exception as exc:
        raise UnauthorizedError("Invalid or expired authentication token.") from exc

    _enforce_suspension(supabase, auth_user_id, request)
    return auth_user_id


def _enforce_suspension(
    supabase: Client, auth_user_id: UUID, request: Request
) -> None:
    """Reject an interactive request from a suspended account.

    Reuses the existing `public.suspensions` model — the same table the admin
    console writes — so there is no second moderation system. Applies to every
    route, admin included: staff authorization is checked separately and does
    not exempt an account from this gate. Fails closed: if the suspension lookup
    fails the request is refused rather than allowed.
    """
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    if route_path is None:
        # Unmatched path: it will 404 anyway, so do not spend a query on it.
        return

    if request.method.upper() in _SAFE_METHODS:
        if route_path not in _SUSPENDED_READ_DENYLIST:
            return

    if admin_service.is_suspended(supabase, auth_user_id):
        raise PermissionDeniedError(
            "This account is suspended and cannot perform this action.",
            code="account_suspended",
        )


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
