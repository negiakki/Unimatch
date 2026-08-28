# UniMatch — API Reference

Base URL (local): `http://localhost:8000`
Interactive docs: `/docs` (Swagger UI) and `/redoc`

All endpoints are versioned under `/api/v1`.

> Status: surface below is the **planned** API scope. Individual request/
> response contracts are **TBD** and will be documented here before each
> module's implementation. Nothing beyond Health exists yet.

## Conventions

- All errors share one envelope:
  `{ "error": { "code": "...", "message": "..." } }`
- Known codes today: `internal_error` (500), `validation_error` (422),
  `bad_request` (400), `unauthorized` (401), `permission_denied` (403),
  `not_found` (404), `method_not_allowed` (405), `conflict` (409).
  More codes will be added as modules land.
- CORS origins are configured via the backend's `CORS_ORIGINS` setting.
- Authentication: all endpoints except Health require a valid Supabase Auth
  JWT. Verification-gated endpoints additionally require status `VERIFIED`.
- Sensitive operations (verification review, report viewing, private-media
  signing) require reviewer/admin authorization evaluated server-side in
  FastAPI: the caller's Supabase Auth bearer token is resolved to an auth
  user, and that user must have a row in `public.staff_admins` (checked with
  the backend-only service-role client). Client-supplied identifiers never
  grant authorization.

## Health

### `GET /api/v1/health`

Liveness probe. No authentication.

```json
{ "status": "ok", "service": "UniMatch API", "version": "0.1.0" }
```

## Planned modules

### Authentication / session

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Signup/sign-in/sign-out | `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout` | Supabase Auth performs credential exchange; contract TBD |
| Current session/user | `GET /auth/me` | Returns account + verification status; the client uses this to drive gating UX |

Signup collects date of birth; the backend rejects users under 18
(server-side check; the client prompt is UX only).

### Profile

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Get/update my profile | `GET/PUT /profiles/me` | Field set per PRD Profiles section |
| Interests | managed within profile ops | Catalog + selections; exact shape TBD |
| Photos | `POST/DELETE /profiles/me/photos`, reorder endpoint, set-primary | Private storage upload flow (direct-to-Supabase vs proxied) TBD |
| View others' profile | `GET /profiles/{user_id}` | Authorized only when viewer may legitimately see that profile |

### Verification

User-facing:

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Submit student ID | `POST /verifications` | Upload to private bucket + create `PENDING` record |
| My verification status/history | `GET /verifications/me` | Includes rejection reason if `REJECTED` |

Reviewer-facing (staff authorization required — see "Admin (reviewer)"):

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| List verification queue | `GET /admin/verifications?status=PENDING` | **Implemented** — metadata-only view; contract below |
| Securely view submitted ID | `GET /admin/verifications/{id}/document-url` | **Implemented** — short-lived signed URL; generated server-side only; contract below |
| Decide | `POST /admin/verifications/{id}/decision` | **Implemented** — `VERIFIED` / `REJECTED` (+ required reason on reject); every decision appended to audit trail; contract below |

No automated decisioning exists in v1; automation may only assist reviewers later.

### Admin (reviewer)

Staff-only surface. Access requires a valid Supabase Auth JWT whose auth user
has a row in `public.staff_admins`; the membership check happens server-side
in FastAPI via the service-role client. Authorization derives exclusively
from the token identity — client-supplied `user_id`/`reviewer_id` values
carry no weight. The service-role key never reaches any client.

#### `GET /api/v1/admin/verifications`

Reviewer queue metadata, oldest submissions first, capped at the 100 oldest.

Query parameters:

| Param | Values | Default |
| --- | --- | --- |
| `status` | `PENDING` \| `VERIFIED` \| `REJECTED` | `PENDING` |

Response `200`:

```json
[
  {
    "id": "0b8f7c2e-1d3a-4c5b-9e2f-a1b2c3d4e5f6",
    "profile_id": "5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d",
    "status": "PENDING",
    "submitted_at": "2026-08-28T10:00:00+00:00",
    "student": {
      "first_name": "Jamie",
      "date_of_birth": "2003-04-12",
      "course": "Computer Science",
      "academic_year": 3,
      "university": {
        "name": "State University",
        "city": "College Town",
        "state": "CA",
        "country": "USA"
      }
    }
  }
]
```

Deliberately **not** included: `storage_path` (the private document
reference), the document itself, any signed URL, reviewer fields, or profile
fields unnecessary for ID review (bio, social links, auth identity).
Documents remain unviewable until the future signed-URL endpoint.

Errors: `unauthorized` (401, missing/invalid token), `permission_denied`
(403, authenticated non-staff), `validation_error` (422, unknown `status`),
`database_unavailable` (503).

#### `GET /api/v1/admin/verifications/{verification_id}/document-url`

Returns a **short-lived signed URL** for a submission's private ID document so
a staff reviewer can view it. Staff authorization is required and is enforced
server-side: the caller's Supabase Auth bearer token is resolved to an auth
user, and that user must have a row in `public.staff_admins` (checked with the
backend-only service-role client). Authorization derives exclusively from the
token identity — client-supplied `user_id`/`reviewer_id` values carry no
weight.

Path parameters:

| Param | Type | Notes |
| --- | --- | --- |
| `verification_id` | UUID | The only client-supplied identifier. |

The submission's document reference (`storage_path`) is resolved **server-side
from the database**; the client can neither supply nor override it. The signed
URL is generated by the backend-only service-role client against the **private**
`verification-documents` bucket. The bucket is never made public and no public
URL or Storage policy is created. The document path is never returned to the
client — only the short-lived URL.

Response `200`:

```json
{
  "url": "https://<project>.supabase.co/storage/v1/object/sign/verification-documents/<auth-user>/<file-id>.png?token=...",
  "expires_in": 300
}
```

The signed URL expires after `expires_in` seconds (default **300** / 5 minutes,
configurable via the backend's `VERIFICATION_SIGNED_URL_TTL_SECONDS` setting).
Once it expires the reviewer must request a fresh URL.

Errors: `unauthorized` (401, missing/invalid token), `permission_denied`
(403, authenticated non-staff), `validation_error` (422, malformed
`verification_id`), `verification_not_found` (404, no such submission),
`document_unavailable` (503, submission has no stored document reference),
`database_unavailable` (503), `storage_signing_failed` (503, Storage could
not produce a signed URL).

#### `POST /api/v1/admin/verifications/{verification_id}/decision`

Records a staff reviewer's decision on a `PENDING` verification submission.
Only registered staff (members of `public.staff_admins`) may decide. The
reviewer identity derives **exclusively** from the caller's Supabase Auth
bearer token — client-supplied `reviewer_id`, `auth_user_id`, `user_id`,
`reviewed_at`, or `storage_path` values carry no weight and are never
persisted. The submission UUID in the URL is the only client-supplied
identifier. Decisions are unrelated to Storage: `storage_path`/private
document access is never affected by this request.

Path parameters:

| Param | Type | Notes |
| --- | --- | --- |
| `verification_id` | UUID | The only client-supplied identifier. |

Request body — exactly two decisions are valid:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `VERIFIED` \| `REJECTED` | Yes | Any other value is rejected (422). |
| `rejection_reason` | string | For `REJECTED` | Required for `REJECTED`: non-empty, trimmed, 1–500 chars (the database constraint). Ignored for `VERIFIED` and never persisted. |

Request `200` (PENDING → VERIFIED):

```json
{
  "status": "VERIFIED"
}
```

Request `200` (PENDING → REJECTED):

```json
{
  "status": "REJECTED",
  "rejection_reason": "Document unreadable"
}
```

Response `200` — the updated submission with reviewer-safe fields only
(`storage_path` and private document references are never returned):

```json
{
  "id": "0b8f7c2e-1d3a-4c5b-9e2f-a1b2c3d4e5f6",
  "profile_id": "5a4b3c2d-1e0f-4a5b-8c7d-6e5f4a3b2c1d",
  "status": "REJECTED",
  "submitted_at": "2026-08-28T10:00:00+00:00",
  "reviewed_at": "2026-08-28T14:00:00+00:00",
  "rejection_reason": "Document unreadable"
}
```

The decision timestamp (`reviewed_at`) is assigned server-side by the database
trigger; the decision is recorded automatically in the append-only
`verification_reviews` audit trail (reviewer, decision, timestamp, reason) —
the API does not and cannot write audit records itself.

State machine: only `PENDING → VERIFIED` and `PENDING → REJECTED` are legal.
Decided (`VERIFIED`/`REJECTED`) submissions are immutable — a second decision
on the same submission returns `409 invalid_state_transition`. The database
trigger remains the authoritative guard; the API surfaces invalid transitions
as a clean conflict error rather than a raw database error.

Errors: `unauthorized` (401, missing/invalid token), `permission_denied`
(403, authenticated non-staff), `validation_error` (422, malformed
`verification_id`, missing/invalid `status`, or a `REJECTED` decision without
a valid `rejection_reason`), `verification_not_found` (404, no such
submission), `invalid_state_transition` (409, submission is not `PENDING`),
`database_unavailable` (503), `database_update_failed` (503).

### Discovery

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Eligible candidate feed | `GET /discovery/feed` | Applies full exclusion list + preferences (age range ≥ 18+, gender preference); deterministic ranking; cursor pagination TBD |

### Dating actions

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Like / Pass | `POST /actions/{target_user_id}` body `{type: LIKE \| PASS}` (or split endpoints — TBD) | Rejects acting on already-decided candidates; creates match server-side on mutual like |

Super Like and Undo/Rewind have no endpoints in v1 (deferred).

### Matching

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| List my matches | `GET /matches` | Participant-visible only |
| Match detail | `GET /matches/{match_id}` | |
| Unmatch | `DELETE /matches/{match_id}` | Hides conversation/messages from both users immediately |

### Messaging

REST for history/sending; live transport is **Supabase Realtime**
(messages, read receipts, typing/presence — not REST):

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Conversations | `GET /conversations` | Derived from active matches; unread counts included |
| Messages history | `GET /conversations/{id}/messages` | Cursor-paginated; membership-checked |
| Send message | `POST /conversations/{id}/messages` | Text-first; participant-checked |
| Read marker | `POST /conversations/{id}/read` | Marks conversation read for caller |

Exact payload shapes, pagination, and Realtime channel/naming conventions TBD.

### Moderation / safety

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| Block / unblock | `POST /blocks`, `DELETE /blocks/{user_id}` | Blocks affect discovery + messaging server-side |
| Report | `POST /reports` | Targeted user + optional content reference + reason category/detail |
| My blocks list | `GET /blocks/me` | So users can manage their block list |

Admin report viewing lives with the future minimal moderation workflow (TBD);
report contents are never returned to regular users.

## Not yet designed

Every row marked TBD above, plus: JWT validation middleware details, reviewer
authorization mechanics, file-upload protocols, pagination/idempotency
standards, rate-limiting responses. Contracts get documented here (and in
OpenAPI) before each implementation phase — see [ROADMAP.md](ROADMAP.md).
