"""Profile endpoints for the authenticated student.

GET  /api/v1/profiles/me — the caller's own profile (404 profile_not_found
when none exists yet), including the selected interests. POST
/api/v1/profiles/me — create it (409 profile_already_exists when one exists).
PUT /api/v1/profiles/me — update the editable fields and replace the interest
selection.

Ownership derives exclusively from the Supabase bearer token
(CurrentAuthenticatedUser dependency). `auth_user_id` is never part of the
request models, is never persisted from client input, and is never returned.
Interest selections are validated against the catalog server-side: catalog
ids and custom interest names together are limited to 8 entries, with no
duplicates and catalog membership required for every id. Custom interests
(names supplied by the user) are separate profile-owned rows and are
rejected when they duplicate a catalog entry case-insensitively.
`motivations` is an optional multi-select of controlled values ("why I'm
here"); duplicates are rejected and the value set is controlled by Literal
types mirroring the database CHECK. `profile_prompts` / `social_links` /
photos are out of scope for this slice.
"""

from datetime import date
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator, model_validator

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.core.exceptions import ConflictError
from app.services import profile as profile_service

router = APIRouter(prefix="/profiles", tags=["profiles"])

Gender = Literal["woman", "man", "non_binary", "other"]
SeekingGender = Literal["women", "men", "everyone"]
RelationshipIntent = Literal["casual", "serious", "friendship", "not_sure"]
Motivation = Literal["dating", "making_friends", "confidence_and_communication"]

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
    fields (Pydantic default) are ignored. `interest_ids` and
    `custom_interest_names` are route input — the service layer removes them
    before any profiles write. Their combined length is capped at the product
    maximum (8) so one selection surface cannot exceed the limit.
    """

    first_name: str
    date_of_birth: date
    university_id: UUID
    course: str
    academic_year: int = Field(ge=1, le=6)
    gender: Gender
    seeking_gender: SeekingGender
    bio: str
    relationship_intent: RelationshipIntent | None = None
    height_cm: int | None = Field(default=None, ge=100, le=250)
    hometown: str | None = None
    # Optional for backward compatibility (omitted -> []); when explicitly
    # supplied it must carry 1-3 controlled values. Pydantic does not validate
    # defaults, so the default empty list never trips min_length.
    motivations: list[Motivation] = Field(
        default_factory=list, min_length=1, max_length=3
    )
    interest_ids: list[UUID] = Field(default_factory=list, max_length=8)
    custom_interest_names: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("interest_ids")
    @classmethod
    def _validate_interest_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("interest_ids must not contain duplicates.")
        return value

    @field_validator("motivations")
    @classmethod
    def _validate_motivations(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("motivations must not contain duplicates.")
        return value

    @field_validator("custom_interest_names")
    @classmethod
    def _validate_custom_interest_names(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for name in value:
            trimmed = name.strip()
            if not trimmed:
                raise ValueError("custom_interest_names must not be empty.")
            if len(trimmed) > profile_service.MAX_CUSTOM_INTEREST_NAME_LENGTH:
                raise ValueError(
                    "Custom interests must be at most "
                    f"{profile_service.MAX_CUSTOM_INTEREST_NAME_LENGTH} characters."
                )
            key = trimmed.casefold()
            if key in seen:
                raise ValueError(
                    "custom_interest_names must not contain duplicates."
                )
            seen.add(key)
            normalized.append(trimmed)
        return normalized

    @model_validator(mode="after")
    def _validate_combined_interests(self) -> "ProfileWrite":
        combined = len(self.interest_ids) + len(self.custom_interest_names)
        if combined > profile_service.MAX_PROFILE_INTERESTS:
            raise ValueError(
                f"You can select at most {profile_service.MAX_PROFILE_INTERESTS} "
                "interests in total."
            )
        return self

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
    """Return the authenticated user's own profile with selected interests."""
    profile = profile_service.get_own_profile_with_interests(supabase, auth_user_id)
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
    included; the client knows its own session already. Interests are
    client-safe entries (`id` + `name` + `source`) resolved server-side for
    the token-owned profile only; `source` distinguishes catalog entries
    from user-created custom interests.
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
        "motivations": row.get("motivations") or [],
        "interests": row.get("interests") or [],
        "profile_prompts": row.get("profile_prompts") or [],
        "social_links": row.get("social_links") or {},
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }
