"""Profile business logic: create, read, and update the caller's own profile.

Ownership derives exclusively from the authenticated identity (`auth_user_id`
resolved from the Supabase bearer token). Client-supplied identifiers —
including an `auth_user_id` field in a request body — never influence which
profile is read, created, or updated: the value written to the database comes
only from the token. Field validation happens in the route layer (Pydantic);
this module re-checks the university reference server-side and translates
database constraint failures (unique profile, FK, CHECKs) into the existing
structured error envelope instead of leaking raw Postgres messages.
`profile_prompts` / `social_links` are intentionally untouched here — they
arrive with their own slice; database defaults apply on create and updates
never modify them.
"""

import logging
from datetime import date
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    AppError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

# Client-safe projection — auth_user_id and any verification data are
# deliberately excluded from every response built from these columns.
_PROFILE_COLUMNS = (
    "id,first_name,date_of_birth,university_id,course,academic_year,"
    "gender,seeking_gender,bio,relationship_intent,height_cm,hometown,"
    "profile_prompts,social_links,created_at,updated_at"
)

_UNIVERSITY_COLUMNS = "id,name,city,state,country"


def get_own_profile(supabase: Client, auth_user_id: UUID) -> dict[str, Any] | None:
    """Return the authenticated user's profile row, or None if none exists."""
    try:
        response = (
            supabase.table("profiles")
            .select(_PROFILE_COLUMNS)
            .eq("auth_user_id", str(auth_user_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile lookup failed")
        raise ServiceUnavailableError(
            "The profile is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    return dict(row) if row else None


def get_own_profile_or_not_found(
    supabase: Client, auth_user_id: UUID
) -> dict[str, Any]:
    """Return the caller's profile or raise 404 profile_not_found."""
    profile = get_own_profile(supabase, auth_user_id)
    if profile is None:
        raise NotFoundError(
            "No profile exists for this account yet.", code="profile_not_found"
        )
    return profile


def create_profile(
    supabase: Client, auth_user_id: UUID, values: dict[str, Any]
) -> dict[str, Any]:
    """Create the authenticated user's profile (auth_user_id from the token).

    A profile already existing for the identity is a clean 409; an unknown
    university or a database CHECK violation surfaces as a structured 422.
    """
    ensure_university_exists(supabase, values["university_id"])

    payload = {key: _serialize(key, value) for key, value in values.items()}
    payload["auth_user_id"] = str(auth_user_id)

    try:
        response = supabase.table("profiles").insert(payload).execute()
    except Exception as exc:
        raise _translate_write_error(exc, "insert") from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The profile could not be created. Please try again later.",
            code="database_insert_failed",
        )
    return dict(rows[0])


def update_own_profile(
    supabase: Client, auth_user_id: UUID, values: dict[str, Any]
) -> dict[str, Any]:
    """Update the caller's own profile; ownership comes from the token only.

    `auth_user_id` is never part of `values` and never accepted from the
    client, so ownership cannot be changed. An unknown university or a
    database CHECK violation surfaces as a structured 422.
    """
    ensure_university_exists(supabase, values["university_id"])

    payload = {key: _serialize(key, value) for key, value in values.items()}
    try:
        response = (
            supabase.table("profiles")
            .update(payload)
            .eq("auth_user_id", str(auth_user_id))
            .execute()
        )
    except Exception as exc:
        raise _translate_write_error(exc, "update") from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise NotFoundError(
            "No profile exists for this account yet.", code="profile_not_found"
        )
    return dict(rows[0])


def ensure_university_exists(supabase: Client, university_id: UUID) -> None:
    """Verify the referenced university exists in the read-only catalog.

    An explicit check yields a precise structured 422; the database FK
    (`profiles_university_id_fkey`) remains the defense-in-depth guarantee.
    """
    try:
        response = (
            supabase.table("universities")
            .select("id")
            .eq("id", str(university_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("University lookup failed")
        raise ServiceUnavailableError(
            "The profile is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise AppError(
            "The selected university is not in the supported catalog.",
            status_code=422,
            code="validation_error",
        )


def list_universities(supabase: Client) -> list[dict[str, Any]]:
    """Return the read-only university catalog (name order).

    Universities are reference data: students can list them but can never
    create or modify catalog entries through this code path.
    """
    try:
        response = (
            supabase.table("universities")
            .select(_UNIVERSITY_COLUMNS)
            .order("name")
            .execute()
        )
    except Exception as exc:
        logger.exception("University catalog lookup failed")
        raise ServiceUnavailableError(
            "The university catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        {
            "id": str(row["id"]),
            "name": row.get("name"),
            "city": row.get("city"),
            "state": row.get("state"),
            "country": row.get("country"),
        }
        for row in rows
    ]


def _serialize(key: str, value: Any) -> Any:
    """Convert Python-only types to what PostgREST expects (UUIDs, dates)."""
    if isinstance(value, UUID):
        return str(value)
    if key == "date_of_birth" and isinstance(value, date):
        return value.isoformat()
    return value


def _translate_write_error(exc: Exception, operation: str) -> Exception:
    """Map database constraint failures to the existing error envelope."""
    detail = str(exc)
    if "duplicate key" in detail or "profiles_auth_user_id_key" in detail:
        return ConflictError(
            "A profile already exists for this account.",
            code="profile_already_exists",
        )
    if "profiles_university_id_fkey" in detail or "foreign key" in detail:
        return AppError(
            "The selected university is not in the supported catalog.",
            status_code=422,
            code="validation_error",
        )
    if "profiles_age_18_plus" in detail or "profiles_date_of_birth_realistic" in detail:
        return AppError(
            "The date of birth is not valid.", status_code=422, code="validation_error"
        )
    for constraint in (
        "profiles_first_name_valid",
        "profiles_course_valid",
        "profiles_academic_year_valid",
        "profiles_gender_valid",
        "profiles_seeking_gender_valid",
        "profiles_bio_valid",
        "profiles_relationship_intent_valid",
        "profiles_height_cm_valid",
        "profiles_hometown_valid",
    ):
        if constraint in detail:
            return AppError(
                "One or more profile fields are not valid.",
                status_code=422,
                code="validation_error",
            )
    logger.exception("Profile %s failed", operation)
    code = "database_insert_failed" if operation == "insert" else "database_update_failed"
    return ServiceUnavailableError(
        "The profile could not be saved. Please try again later.", code=code
    )
