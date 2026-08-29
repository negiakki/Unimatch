"""Profile business logic: create, read, and update the caller's own profile.

Ownership derives exclusively from the authenticated identity (`auth_user_id`
resolved from the Supabase bearer token). Client-supplied identifiers —
including an `auth_user_id` field in a request body — never influence which
profile is read, created, or updated: the value written to the database comes
only from the token. Field validation happens in the route layer (Pydantic);
this module re-checks the university reference and every selected interest
server-side and translates database constraint failures (unique profile,
FK, CHECKs) into the existing structured error envelope instead of leaking
raw Postgres messages.
`profile_prompts` / `social_links` are intentionally untouched here — they
arrive with their own slice; database defaults apply on create and updates
never modify them.

Interests: the `interests` table is a read-only catalog; selections live in
`profile_interests` and are written only for the profile resolved from the
token. Updates use replace-set semantics (delete the caller's existing links,
insert the validated new set); the maximum selection size is enforced in the
route layer (Pydantic) and re-checked here.
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

_INTEREST_COLUMNS = "id,name"

# Product rule (PRD): a profile carries at most 8 interests.
MAX_PROFILE_INTERESTS = 8


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


def get_own_profile_with_interests(
    supabase: Client, auth_user_id: UUID
) -> dict[str, Any]:
    """Return the caller's profile with its selected interests attached.

    The interests list is client-safe catalog data (`id` + `name`), ordered
    deterministically by name; an empty selection is `[]`.
    """
    profile = get_own_profile_or_not_found(supabase, auth_user_id)
    profile["interests"] = get_profile_interests(supabase, profile["id"])
    return profile


def create_profile(
    supabase: Client, auth_user_id: UUID, values: dict[str, Any]
) -> dict[str, Any]:
    """Create the authenticated user's profile (auth_user_id from the token).

    A profile already existing for the identity is a clean 409; an unknown
    university or interest or a database CHECK violation surfaces as a
    structured 422. Interest links are written after the profile insert; a
    failure there removes the just-created profile so a retry never ends in a
    half-created state.
    """
    interest_ids = _extract_interest_ids(values)
    ensure_university_exists(supabase, values["university_id"])
    ensure_interests_exist(supabase, interest_ids)

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
    profile = dict(rows[0])

    try:
        _replace_profile_interests(supabase, profile["id"], interest_ids)
    except Exception:
        # Compensating delete: never leave a profile behind without the
        # interests the caller asked for (or a misleading 503).
        try:
            supabase.table("profiles").delete().eq("id", str(profile["id"])).execute()
        except Exception:
            logger.exception("Failed to roll back profile after interest failure")
        raise
    profile["interests"] = get_profile_interests(supabase, profile["id"])
    return profile


def update_own_profile(
    supabase: Client, auth_user_id: UUID, values: dict[str, Any]
) -> dict[str, Any]:
    """Update the caller's own profile; ownership comes from the token only.

    `auth_user_id` is never part of `values` and never accepted from the
    client, so ownership cannot be changed. An unknown university or
    interest or a database CHECK violation surfaces as a structured 422.
    Interests are replaced as a set for the profile resolved from the token;
    unrelated profile fields are untouched by that step.
    """
    interest_ids = _extract_interest_ids(values)
    ensure_university_exists(supabase, values["university_id"])
    ensure_interests_exist(supabase, interest_ids)

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
    profile = dict(rows[0])
    _replace_profile_interests(supabase, profile["id"], interest_ids)
    profile["interests"] = get_profile_interests(supabase, profile["id"])
    return profile


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


def list_interests(supabase: Client) -> list[dict[str, Any]]:
    """Return the read-only interest catalog (name order).

    Interests are reference data: students can list the catalog and select
    from it but can never create or modify entries through this code path.
    Only the client-safe fields (`id`, `name`) are returned.
    """
    try:
        response = (
            supabase.table("interests")
            .select(_INTEREST_COLUMNS)
            .order("name")
            .execute()
        )
    except Exception as exc:
        logger.exception("Interest catalog lookup failed")
        raise ServiceUnavailableError(
            "The interest catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [{"id": str(row["id"]), "name": row.get("name")} for row in rows]


def get_profile_interests(supabase: Client, profile_id: str) -> list[dict[str, Any]]:
    """Return a profile's selected interests as client-safe catalog entries.

    Resolves the profile's `profile_interests` links against the catalog and
    orders deterministically by (name, id) so the response is stable. The
    profile id is always derived server-side from the token, never accepted
    from the client.
    """
    if not profile_id:
        return []
    try:
        links_response = (
            supabase.table("profile_interests")
            .select("interest_id")
            .eq("profile_id", str(profile_id))
            .execute()
        )
        links = getattr(links_response, "data", None) or []
        if not links:
            return []
        interest_ids = [link["interest_id"] for link in links]
        catalog_response = (
            supabase.table("interests")
            .select(_INTEREST_COLUMNS)
            .in_("id", interest_ids)
            .execute()
        )
        rows = getattr(catalog_response, "data", None) or []
    except Exception as exc:
        logger.exception("Profile interests lookup failed")
        raise ServiceUnavailableError(
            "The profile is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    interests = [
        {"id": str(row["id"]), "name": row.get("name")} for row in rows
    ]
    interests.sort(key=lambda interest: (interest["name"] or "", interest["id"]))
    return interests


def ensure_interests_exist(supabase: Client, interest_ids: list[UUID]) -> None:
    """Verify every selected interest exists in the read-only catalog.

    An explicit check yields a precise structured 422; the database FK
    (`profile_interests_interest_id_fkey`) remains the defense-in-depth
    guarantee.
    """
    if not interest_ids:
        return
    unique_ids = {str(interest_id) for interest_id in interest_ids}
    try:
        response = (
            supabase.table("interests")
            .select("id")
            .in_("id", sorted(unique_ids))
            .execute()
        )
    except Exception as exc:
        logger.exception("Interest lookup failed")
        raise ServiceUnavailableError(
            "The profile is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    if len(rows) != len(unique_ids):
        raise AppError(
            "One or more selected interests are not in the catalog.",
            status_code=422,
            code="validation_error",
        )


def _extract_interest_ids(values: dict[str, Any]) -> list[UUID]:
    """Pull interest selections out of the write values.

    `interest_ids` is route-layer input, not a profiles column: it is removed
    from `values` before the profiles payload is built so it can never leak
    into the profiles write. The size limit is enforced again here as
    defense-in-depth (the route's Pydantic model is the primary gate).
    """
    interest_ids = values.pop("interest_ids", None) or []
    if not isinstance(interest_ids, list) or not all(
        isinstance(item, UUID) for item in interest_ids
    ):
        raise AppError(
            "interest_ids must be a list of interest IDs.",
            status_code=422,
            code="validation_error",
        )
    if len(interest_ids) > MAX_PROFILE_INTERESTS:
        raise AppError(
            f"You can select at most {MAX_PROFILE_INTERESTS} interests.",
            status_code=422,
            code="validation_error",
        )
    return interest_ids


def _replace_profile_interests(
    supabase: Client, profile_id: str, interest_ids: list[UUID]
) -> None:
    """Replace the profile's interest links with exactly the given set.

    Replace-set semantics: the caller's existing links are deleted, then the
    validated selection is inserted (an empty selection simply clears). The
    `profile_interests` primary key and FKs remain the database-level guard;
    failures surface through the structured error envelope.
    """
    try:
        supabase.table("profile_interests").delete().eq(
            "profile_id", str(profile_id)
        ).execute()
        if interest_ids:
            payload = [
                {"profile_id": str(profile_id), "interest_id": str(interest_id)}
                for interest_id in interest_ids
            ]
            supabase.table("profile_interests").insert(payload).execute()
    except Exception as exc:
        raise _translate_write_error(exc, "update") from exc


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
    # Interest-link constraints are checked before the generic handlers so a
    # duplicate/FK failure on profile_interests never masquerades as a
    # profile/university problem.
    if "profile_interests_interest_id_fkey" in detail:
        return AppError(
            "One or more selected interests are not in the catalog.",
            status_code=422,
            code="validation_error",
        )
    if "profile_interests_pkey" in detail:
        return AppError(
            "Duplicate interests are not allowed.",
            status_code=422,
            code="validation_error",
        )
    if "profile_interests_profile_id_fkey" in detail:
        return ServiceUnavailableError(
            "The profile could not be saved. Please try again later.",
            code=(
                "database_insert_failed" if operation == "insert" else
                "database_update_failed"
            ),
        )
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
