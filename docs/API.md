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
  `not_found` (404), `method_not_allowed` (405), `conflict` (409),
  `already_decided` (409), `database_unavailable` (503).
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
| Get/update my profile | `GET/POST/PUT /profiles/me` | **Implemented** — POST creates (one per account); contract below |
| Interests catalog | `GET /interests` | **Implemented** — read-only catalog; contract below |
| Interest selection | managed within profile ops | **Implemented** — `interest_ids` on profile writes; rules below |
| Photos | `GET/POST /profiles/me/photos`, `DELETE /profiles/me/photos/{id}`, `PUT /profiles/me/photos/order` | **Implemented** — private bucket, backend-proxied upload, short-lived signed URLs; contract below |
| View others' profile | `GET /profiles/{user_id}` | Authorized only when viewer may legitimately see that profile |

#### `GET /api/v1/interests`

Returns the shared interest catalog (read-only reference data) in
deterministic name order. Authentication required; students can never create
or modify catalog entries.

```json
[
  { "id": "0b8f7c2e-…", "name": "Hiking" },
  { "id": "13a9d4f0-…", "name": "Photography" }
]
```

Only client-safe fields (`id`, `name`) are returned. Errors: `unauthorized`
(401), `database_unavailable` (503).

#### Interest selection on `POST` / `PUT /api/v1/profiles/me`

The request body accepts an optional `interest_ids` array of interest
catalog UUIDs; the profile response always includes the resulting selection
as `interests` — client-safe catalog entries resolved server-side, ordered
by name:

```json
{
  "…profile fields…": "…",
  "interests": [
    { "id": "0b8f7c2e-…", "name": "Gaming" },
    { "id": "13a9d4f0-…", "name": "Hiking" }
  ],
  "profile_prompts": [],
  "social_links": {},
  "created_at": "…",
  "updated_at": "…"
}
```

Validation rules (violations are the standard 422 `validation_error`):

- Every supplied id must exist in the interests catalog (checked
  server-side before any write; the database FK remains the backstop).
- No duplicate ids in one request.
- At most **8** interests (`interest_ids` max length 8); an empty or omitted
  array is valid and means no interests.
- Selections always apply to the profile resolved from the bearer token —
  client-supplied `auth_user_id`/`profile_id` values carry no weight.
- `PUT` uses **replace-set semantics**: the caller's existing selections are
  deleted and exactly the submitted set is written (an empty array clears
  all interests). Unrelated profile fields are untouched by that step.

Errors: `unauthorized` (401), `profile_not_found` (404, PUT without a
profile), `profile_already_exists` (409, POST when one exists),
`validation_error` (422 — unknown interest id, duplicate ids, more than 8
ids, or any other profile field violation), `database_unavailable` /
`database_insert_failed` / `database_update_failed` (503).

#### Profile photos — `POST /api/v1/profiles/me/photos`

Uploads a profile photo for the authenticated user (multipart `file`).
Authorization derives exclusively from the bearer token; the profile is
resolved server-side and the Storage object path is generated server-side
(`<auth.uid()>/<random-file-id>.<ext>` in the **private** `profile-photos`
bucket) — never from client input. The upload is proxied by the backend
using the service-role client; the client never touches Storage directly.

Server-side validation (the browser MIME type is never trusted alone):
magic-byte sniffing accepts JPEG/PNG/WebP only; a declared type that
contradicts the bytes is rejected; max 10 MB; max **6 photos** per profile.

Uploads append to the end of the order; the first photo of an empty profile
becomes the primary photo. Response `201` (the `url` is a short-lived signed
URL; `storage_path` is never returned):

```json
{ "id": "0b8f7c2e-…", "position": 3, "is_primary": false, "url": "https://<project>.supabase.co/storage/v1/object/sign/profile-photos/…" }
```

Errors: `unauthorized` (401), `profile_not_found` (404), `invalid_file_type`
(400, empty/unknown/mismatched bytes), `file_too_large` (413),
`photo_limit_reached` (409, 6 photos already), `photo_upload_conflict` (409,
concurrent mutation — retry), `storage_upload_failed` (503),
`database_unavailable` / `database_insert_failed` (503). A database failure
after the Storage upload removes the just-uploaded object (no orphans).

#### `GET /api/v1/profiles/me/photos`

Returns the caller's photos ordered by position (position 1 = primary) with
short-lived signed URLs for the private bucket (default TTL 3600 s).
`storage_path` is never returned.

```json
{
  "photos": [
    { "id": "…", "position": 1, "is_primary": true, "url": "https://…" },
    { "id": "…", "position": 2, "is_primary": false, "url": "https://…" }
  ],
  "max_photos": 6
}
```

Errors: `unauthorized` (401), `profile_not_found` (404),
`database_unavailable` / `storage_signing_failed` (503).

#### `DELETE /api/v1/profiles/me/photos/{photo_id}`

Deletes the caller's photo row and its private Storage object (service
role), then renumbers the remaining photos to 1..N preserving their relative
order; the photo at position 1 is the primary photo. A foreign or unknown
photo id is `photo_not_found` (404) — no existence leak. Returns the updated
collection in the same shape as the list endpoint.

Errors: `unauthorized` (401), `profile_not_found` (404), `photo_not_found`
(404), `database_unavailable` / `database_delete_failed` / `storage_signing_failed` (503).

#### `PUT /api/v1/profiles/me/photos/order`

Applies a full ordering to the caller's photos. The body must be a
permutation of ALL of the profile's photo ids — each id exactly once, no
unknown ids; the photo placed first becomes the primary photo. Position
values, `is_primary`, and storage paths are server-derived and never
accepted from the client.

```json
{ "photo_ids": ["c…", "a…", "b…"] }
```

Response `200` — the updated collection (same shape as the list endpoint).
Errors: `unauthorized` (401), `profile_not_found` (404), `photo_not_found`
(404, ids belonging to other users or unknown photos),
`invalid_photo_order` (400, not a permutation of the caller's photos),
`photo_upload_conflict` (409, concurrent mutation — retry),
`validation_error` (422, more than 6 ids), `database_unavailable` /
`database_update_failed` (503).

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
| Eligible candidate feed | `GET /discovery/feed` | **Implemented** — verified-only feed; deterministic ordering; cursor pagination; contract below |
| Like a candidate | `POST /discovery/{profile_id}/like` | **Implemented** — creates the match on a mutual like; contract below |
| Pass a candidate | `POST /discovery/{profile_id}/pass` | **Implemented** — contract below |

Age-range preferences, blocks, location filtering, and AI
recommendation/ranking are **not** part of this phase.

#### `GET /api/v1/discovery/feed`

Returns an ordered, cursor-paginated feed of eligible candidate profiles for
the **authenticated, VERIFIED** viewer.

Authentication: required. The viewer is derived **exclusively** from the
Supabase Auth bearer token (the existing `CurrentAuthenticatedUser`
dependency) — the backend resolves the viewer's profile server-side.
Client-supplied `auth_user_id` or viewer `profile_id` values are never
accepted and carry no authorization weight.

Gate: the viewer must be VERIFIED (latest verification submission). An
unverified viewer (including one with no profile) receives **403
`permission_denied`** — no existence leak.

Query parameters:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | int | `20` | Page size, `1..50` (422 outside this range). |
| `cursor` | opaque string | omitted | The previous page's `next_cursor`; omitted for the first page. |

Candidate eligibility (this phase):

- candidate is not the current user;
- candidate has a profile;
- candidate is VERIFIED;
- candidate's gender is compatible with the viewer's `seeking_gender`;
- viewer's gender is compatible with the candidate's `seeking_gender`
  (two-sided);
- `seeking_gender = everyone` imposes no restriction on that side;
- neither side has both decided: candidates the VIEWER has already acted on
  (any `LIKE`/`PASS`) are removed from the feed — the exclusion is
  viewer-scoped. Candidates who acted on the viewer remain discoverable so
  the mutual like can form the match (Phase 6).

Ordering is **deterministic and explainable**: newest profiles first
(`created_at` descending), `id` ascending as a stable tiebreaker. No random
ordering. Response `200`:

```json
{
  "candidates": [
    {
      "id": "0b8f7c2e-…",
      "first_name": "Jamie",
      "age": 23,
      "university": {
        "id": "…",
        "name": "State University",
        "city": "College Town",
        "state": "CA",
        "country": "USA"
      },
      "course": "Computer Science",
      "academic_year": 3,
      "gender": "man",
      "bio": "CS student who loves hiking.",
      "relationship_intent": "serious",
      "height_cm": 180,
      "hometown": "Springfield",
      "interests": [
        { "id": "0b8f7c2e-…", "name": "Hiking" }
      ],
      "profile_prompts": [ { "prompt": "…", "answer": "…" } ],
      "photos": [
        { "id": "…", "url": "https://<project>.supabase.co/storage/v1/object/sign/profile-photos/…", "is_primary": true }
      ]
    }
  ],
  "next_cursor": "…"
}
```

Response contract / security:

- `age` is **derived** from `date_of_birth` server-side; the raw
  `date_of_birth` is **never** returned.
- `university` is `{ id, name, city, state, country }`.
- `photos[].url` is a **short-lived signed URL** generated server-side with
  the service-role client against the private `profile-photos` bucket; the
  `storage_path` is read server-side and **never** returned.
- **Never exposed**: `auth_user_id`, `seeking_gender`, verification status
  strings / submissions / documents, `storage_path`, `created_at`,
  `updated_at`.
- `next_cursor` is `null` when no further candidates exist; otherwise it is an
  opaque token passed back as `cursor` to fetch the next page.

Errors: `unauthorized` (401, missing/invalid token), `permission_denied` (403,
authenticated but not VERIFIED / no profile), `validation_error` (422, `limit`
outside 1..50 or a malformed `cursor`), `database_unavailable` /
`storage_signing_failed` (503).

#### `POST /api/v1/discovery/{profile_id}/like`

Records the authenticated viewer's `LIKE` on the candidate profile identified
by the URL path — the only client-supplied identifier. There is no body and
no client-supplied actor field: the actor is resolved server-side from the
bearer token, so actor spoofing is structurally impossible.

Gate: viewer must be VERIFIED (403 `permission_denied` otherwise, including a
viewer with no profile — no existence leak). The target must exist, be
VERIFIED, and not be the viewer themselves: self, unknown, and unverified
targets all return **404 `not_found`** — no existence leak.

Exactly one immutable action exists per viewer/candidate pair: a LIKE on an
already-liked OR already-passed candidate returns **409
`already_decided`** (a LIKE after PASS is the same rejection; actions cannot
be updated or deleted by users in v1).

On a mutual LIKE (the candidate had already liked the viewer) the canonical
match is created server-side exactly once — concurrent mutual likes cannot
produce duplicate matches (unique pair constraint + conflict-ignore insert).
The response is either:

```json
{ "outcome": "like_recorded" }
```

or, when the match was just created (or already exists under concurrency):

```json
{
  "outcome": "matched",
  "match": {
    "id": "0b8f7c2e-…",
    "created_at": "2026-08-30T10:00:00+00:00",
    "profile": { "…same client-safe candidate shape as the discovery feed…": "…" }
  }
}
```

The matched profile carries the same client-safe fields as a discovery
candidate (age derived from date_of_birth; signed photo URLs; never
`auth_user_id`, `date_of_birth`, verification status strings, or
`storage_path`).

Errors: `unauthorized` (401), `permission_denied` (403, unverified viewer /
no profile), `not_found` (404, self / unknown / unverified target),
`already_decided` (409, the viewer already acted on this target in either
direction), `validation_error` (422, malformed `profile_id`),
`database_unavailable` / `database_insert_failed` (503).

#### `POST /api/v1/discovery/{profile_id}/pass`

Records the authenticated viewer's `PASS`. Identical gate, target, 404, 409,
and immutability rules as the like endpoint; a PASS can never create a match.

```json
{ "outcome": "pass_recorded" }
```

Errors: same as the like endpoint.

### Matches

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| List my active matches | `GET /matches` | **Implemented** — participant-visible only; contract below |
| Unmatch | `DELETE /matches/{match_id}` | **Implemented** — participant-only soft unmatch; contract below |

Match detail (`GET /matches/{match_id}`) is not exposed in this phase.

#### `GET /api/v1/matches`

Returns the caller's ACTIVE matches, newest first. Only the two participants
can ever see a match; other users receive an empty list (no existence leak).

```json
{
  "matches": [
    {
      "id": "0b8f7c2e-…",
      "created_at": "2026-08-30T10:00:00+00:00",
      "profile": { "…same client-safe candidate shape as the discovery feed…": "…" }
    }
  ]
}
```

`profile` is the OTHER participant as a client-safe projection (identical
shape to a discovery candidate). Unmatched matches are never returned; the
match row is retained server-side so an unmatched pair cannot rematch through
normal discovery. "Who liked you" does not exist — incoming likes are never
readable.

Errors: `unauthorized` (401), `permission_denied` (403, unverified viewer / no
profile), `database_unavailable` / `storage_signing_failed` (503).

#### `DELETE /api/v1/matches/{match_id}`

Soft-unmatches an active match. Only the two participants may unmatch: an
unknown match, a nonparticipant's match, and an already-unmatched match all
return **404 `not_found`** — no existence leak. `unmatched_at` is set
server-side (the row is never deleted); both participants stop seeing the
match immediately, and messaging access will be unavailable from Phase 7.

```json
{ "id": "0b8f7c2e-…", "unmatched_at": "2026-08-30T12:00:00+00:00" }
```

Errors: `unauthorized` (401), `permission_denied` (403, unverified viewer),
`not_found` (404, unknown / nonparticipant / already-unmatched match),
`validation_error` (422, malformed `match_id`), `database_unavailable` /
`database_update_failed` (503).

### Dating actions (superseded)

The generic `POST /actions/{target_user_id}` sketch was replaced by the
split like/pass endpoints above — target identity comes from the URL path,
never from a request body. Super Like and Undo/Rewind have no endpoints in
v1 (deferred); users cannot update or delete their own actions in v1.

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
