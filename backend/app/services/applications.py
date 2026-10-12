"""Applications: apply with the caller's EXISTING universal profile, list
them, and withdraw.

An application never creates or duplicates a profile. Apply requires the caller
to be VERIFIED (403 otherwise) and the opportunity to be PUBLISHED (404
otherwise — the same non-existence behavior as an unknown opportunity). The
profile id is derived server-side from the bearer token, so a client-supplied
`profile_id` carries no authorization weight. Duplicate applications are
prevented by the DB unique constraint and surfaced as 409. Withdraw is a
status transition (APPLIED -> WITHDRAWN), not a row deletion.

The public browse/detail projection stays in `app.services.opportunities`;
`require_published_opportunity` and `_public_payload` are shared from there so
the two cannot disagree about what is public.
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.services.discovery import _get_verified_viewer
from app.services.opportunities import (
    _PUBLIC_SELECT,
    _public_payload,
    require_published_opportunity,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Applications.
# ---------------------------------------------------------------------------


def apply_to_opportunity(
    supabase: Client, auth_user_id: UUID, opportunity_id: UUID
) -> dict[str, Any]:
    """Apply to a PUBLISHED opportunity with the caller's universal profile.

    The caller must be VERIFIED (403 otherwise) and the opportunity must be
    PUBLISHED (404 otherwise — same non-existence behavior as an unknown
    opportunity). A duplicate application is a 409. The profile id is derived
    server-side from the token; the client can never supply it.
    """
    viewer = _get_verified_viewer(
        supabase, auth_user_id, action="apply to opportunities"
    )
    require_published_opportunity(supabase, opportunity_id)
    try:
        response = (
            supabase.table("applications")
            .insert(
                {
                    "opportunity_id": str(opportunity_id),
                    "profile_id": str(viewer["id"]),
                    "status": "APPLIED",
                }
            )
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail or "applications_opportunity_profile_key" in detail:
            raise ConflictError(
                "You have already applied to this opportunity.",
                code="already_applied",
            ) from exc
        logger.exception("Application insert failed")
        raise ServiceUnavailableError(
            "The application could not be submitted. Please try again later.",
            code="database_insert_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The application could not be submitted. Please try again later.",
            code="database_insert_failed",
        )
    return _application_payload(rows[0], status_only=False)


def list_my_applications(supabase: Client, auth_user_id: UUID) -> dict[str, Any]:
    """Return the caller's applications (newest first) with opportunity context."""
    viewer = _get_verified_viewer(
        supabase, auth_user_id, action="view your applications"
    )
    viewer_id = str(viewer["id"])
    try:
        response = (
            supabase.table("applications")
            .select(
                "id,opportunity_id,status,created_at,"
                "opportunities(" + _PUBLIC_SELECT + ")"
            )
            .eq("profile_id", viewer_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("My applications lookup failed")
        raise ServiceUnavailableError(
            "Your applications are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return {
        "applications": [
            {
                "id": str(row["id"]),
                "status": row.get("status"),
                "created_at": row.get("created_at"),
                "opportunity": _public_payload(row.get("opportunities") or {}),
            }
            for row in rows
        ]
    }


def withdraw_application(
    supabase: Client, auth_user_id: UUID, application_id: UUID
) -> dict[str, Any]:
    """Withdraw the caller's application (APPLIED -> WITHDRAWN).

    The application must belong to the caller (else 404 — no existence leak)
    and must be in APPLIED state (else 409).
    """
    viewer = _get_verified_viewer(
        supabase, auth_user_id, action="manage applications"
    )
    viewer_id = str(viewer["id"])
    try:
        response = (
            supabase.table("applications")
            .select("id,status")
            .eq("id", str(application_id))
            .eq("profile_id", viewer_id)
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Application lookup failed")
        raise ServiceUnavailableError(
            "Your applications are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError("Application not found.")
    if row.get("status") != "APPLIED":
        raise ConflictError(
            "This application is not in APPLIED state.",
            code="invalid_state_transition",
        )
    try:
        response = (
            supabase.table("applications")
            .update({"status": "WITHDRAWN"})
            .eq("id", str(application_id))
            .eq("profile_id", viewer_id)
            .execute()
        )
    except Exception as exc:
        logger.exception("Application withdraw failed")
        raise ServiceUnavailableError(
            "The application could not be withdrawn. Please try again later.",
            code="database_update_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The application could not be withdrawn. Please try again later.",
            code="database_update_failed",
        )
    return _application_payload(rows[0], status_only=True)


def _application_payload(row: dict[str, Any], *, status_only: bool) -> dict[str, Any]:
    if status_only:
        return {
            "id": str(row["id"]),
            "status": row.get("status"),
            "created_at": row.get("created_at"),
        }
    return {
        "id": str(row["id"]),
        "opportunity_id": str(row["opportunity_id"]),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
    }
