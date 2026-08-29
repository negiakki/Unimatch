"""Profile endpoints for the authenticated student.

GET  /api/v1/profiles/me — the caller's own profile (404 profile_not_found
when none exists yet). POST /api/v1/profiles/me — create it (409
profile_already_exists when one exists). PUT /api/v1/profiles/me — update the
editable fields.

Ownership derives exclusively from the Supabase bearer token
(CurrentAuthenticatedUser dependency). `auth_user_id` is never part of the
request models, is never persisted from client input, and is never returned.
`profile_prompts` / `social_links` / photos are out of scope for this slice.
"""

from datetime import date
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.core.exceptions import ConflictError
from app.services import profile as profile_service

router = APIRouter(prefix="/profiles", tags=["profiles"])

Gender = Literal["woman", "man", "non_binary", "other"]
SeekingGender = Literal["women", "men", "everyone"]
RelationshipIntent = Literal["casual", "serious", "friendship", "not_sure"]

MIN_BIRTH_DATE = date(1900, 1, 1)


def _eighteenth_birthday_cutoff(today: date) -> date:
    """The latest birth date that makes someone 18+ today."""
    try:
        return today.replace(year=today.year - 18)
    except ValueError:  # Feb 29 on a non-leap year
        return today.replace(year=today.year - 18, day=28)


class ProfileWrite(BaseModel):
    """Writable profile fields, mirroring the database constraints.

    `auth_user_id` is deliberately absent: ownership comes from the token, so
    a client cannot create or adopt another user's profile, and unknown extra
    fields (Pydantic default) are ignored.
    """

    first_name: str
    date_of_birth: date
    university_id: UUID
    course: str
    academic_year: int = Field(ge=1, le=8)
    gender: Gender
    seeking_gender: SeekingGender
    bio: str
    relationship_intent: RelationshipIntent | None = None
    height_cm: int | None = Field(default=None, ge=100, le=250)
    hometown: str | None = None

    @field_validator("first_name")
    @classmethod
    def _validate_first_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("first_name must not be empty.")
        if len(trimmed) > 50:
            raise ValueError("first_name must be at most 50 characters.")
        return trimmed

    @field_validator("course")
    @classmethod
    def _validate_course(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("course must not be empty.")
        if len(trimmed) > 120:
            raise ValueError("course must be at most 120 characters.")
        return trimmed

    @field_validator("bio")
    @classmethod
    def _validate_bio(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("bio must not be empty.")
        if len(trimmed) > 500:
            raise ValueError("bio must be at most 500 characters.")
        return trimmed

    @field_validator("hometown")
    @classmethod
    def _validate_hometown(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        if len(trimmed) > 100:
            raise ValueError("hometown must be at most 100 characters.")
        return trimmed

    @field_validator("date_of_birth")
    @classmethod
    def _validate_date_of_birth(cls, value: date) -> date:
        if value < MIN_BIRTH_DATE:
            raise ValueError("date_of_birth must be 1900 or later.")
        if value > date.today():
            raise ValueError("date_of_birth cannot be in the future.")
        if value > _eighteenth_birthday_cutoff(date.today()):
            raise ValueError("You must be at least 18 years old.")
        return value


@router.get("/me")
def get_my_profile(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Return the authenticated user's own profile."""
    profile = profile_service.get_own_profile_or_not_found(supabase, auth_user_id)
    return _profile_payload(profile)


@router.post("/me", status_code=201)
def create_my_profile(
    payload: ProfileWrite,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Create the authenticated user's profile (exactly one per account)."""
    existing = profile_service.get_own_profile(supabase, auth_user_id)
    if existing is not None:
        raise ConflictError(
            "A profile already exists for this account.",
            code="profile_already_exists",
        )
    profile = profile_service.create_profile(
        supabase, auth_user_id, payload.model_dump()
    )
    return _profile_payload(profile)


@router.put("/me")
def update_my_profile(
    payload: ProfileWrite,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Update the authenticated user's own profile fields."""
    profile = profile_service.update_own_profile(
        supabase, auth_user_id, payload.model_dump()
    )
    return _profile_payload(profile)


def _profile_payload(row: dict[str, Any]) -> dict[str, Any]:
    """Project a profile row to client-safe fields.

    auth_user_id and anything verification/private related are never
    included; the client knows its own session already.
    """
    return {
        "id": str(row.get("id")),
        "first_name": row.get("first_name"),
        "date_of_birth": row.get("date_of_birth"),
        "university_id": str(row.get("university_id")),
        "course": row.get("course"),
        "academic_year": row.get("academic_year"),
        "gender": row.get("gender"),
        "seeking_gender": row.get("seeking_gender"),
        "bio": row.get("bio"),
        "relationship_intent": row.get("relationship_intent"),
        "height_cm": row.get("height_cm"),
        "hometown": row.get("hometown"),
        "profile_prompts": row.get("profile_prompts") or [],
        "social_links": row.get("social_links") or {},
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
