# UniMatch — API Reference

Base URL (local): `http://localhost:8000`
Interactive docs: `/docs` (Swagger UI) and `/redoc`

All endpoints are versioned under `/api/v1`.

> Status: the surface below is the **shipped** API. UniMatch is
> opportunity-first: a user picks an opportunity, joins it, and only then
> discovers the people taking part in that same opportunity. The endpoints
> marked **Implemented** are live and covered by backend tests. Anything marked
> **Planned** has no endpoint yet.

## Conventions

- All errors share one envelope:
  `{ "error": { "code": "...", "message": "..." } }`
- Error codes by source:

  | Code | HTTP | Raised by |
  | --- | --- | --- |
  | `bad_request` | 400 | generic malformed request |
  | `invalid_file_type` | 400 | upload: empty/unknown/mismatched bytes |
  | `invalid_photo_order` | 400 | reorder body is not a permutation |
  | `invalid_state` | 400 | admin query/state filter value unknown |
  | `invalid_rejection_reason` | 400 | verification rejection reason invalid |
  | `invalid_suspension_window` | 400 | suspension window already in the past |
  | `photo_required` | 400 | verification needs ≥1 profile photo first |
  | `unauthorized` | 401 | missing/invalid bearer token |
  | `permission_denied` | 403 | authenticated, but not allowed (incl. not `VERIFIED`) |
  | `account_suspended` | 403 | caller has an active suspension |
  | `not_applied` | 403 | opportunity discovery requires joining first |
  | `method_not_allowed` | 405 | wrong HTTP method |
  | `not_found` | 404 | unknown/withheld resource (never an existence leak) |
  | `profile_not_found` | 404 | caller has no profile yet |
  | `photo_not_found` | 404 | unknown/foreign photo id |
  | `verification_not_found` | 404 | unknown submission |
  | `conflict` | 409 | generic state conflict |
  | `already_decided` | 409 | the caller already acted on this person here |
  | `already_applied` | 409 | the caller already joined this opportunity |
  | `invalid_state_transition` | 409 | illegal state change (e.g. withdraw a withdrawn application) |
  | `photo_limit_reached` | 409 | 6 photos already |
  | `photo_upload_conflict` | 409 | concurrent mutation — retry |
  | `invalid_category` | 409 | category/activity does not exist |
  | `category_in_use` | 409 | category still referenced by an opportunity |
  | `duplicate_catalog_entry` | 409 | catalog name or slug already exists |
  | `already_verified` | 409 | caller is already `VERIFIED` |
  | `pending_submission_exists` | 409 | a `PENDING` submission is already open |
  | `file_too_large` | 413 | upload exceeds the 10 MB cap |
  | `validation_error` | 422 | Pydantic/FastAPI request validation |
  | `internal_error` | 500 | unexpected server failure |
  | `database_unavailable` | 503 | read failed |
  | `database_insert_failed` | 503 | insert failed |
  | `database_update_failed` | 503 | update failed |
  | `database_delete_failed` | 503 | delete failed |
  | `database_write_failed` | 503 | admin write failed |
  | `storage_upload_failed` | 503 | Storage upload failed |
  | `storage_signing_failed` | 503 | Storage could not sign a URL |

- CORS origins are configured via the backend's `CORS_ORIGINS` setting.
- Authentication: every endpoint except Health, the opportunity/category catalog
  reads, and the opportunity browse/detail reads requires a valid Supabase Auth
  JWT. Verification-gated endpoints additionally require status `VERIFIED`.
- Authorization always derives **exclusively** from the bearer token. Any
  client-supplied `user_id`, `profile_id`, `auth_user_id`, `reviewer_id`,
  `status`, or timestamp carries no weight.
- Sensitive operations (verification review, report viewing, user directory,
  account restriction, catalog and opportunity management) require reviewer
  authorization evaluated server-side in FastAPI: the caller's Supabase Auth
  bearer token is resolved to an auth user, and that user must have a row in
  `public.staff_admins` (checked with the backend-only service-role client).
- Account suspension: an active row in `public.suspensions` makes the account
  read-only. Every state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) is
  refused with **403 `account_suspended`**, as are the two discovery feeds
  (`GET /discovery/feed` and `GET /opportunities/{id}/discovery`) because they
  are the entry point to every other interaction. Ordinary reads of the
  caller's own data stay available. Lapsed timed suspensions are ignored, so
  access returns automatically. There is no staff exemption: a suspended
  moderator is subject to the same rule.

## Health

### `GET /api/v1/health`

Liveness probe. No authentication.

```json
{ "status": "ok", "service": "UniMatch API", "version": "0.1.0" }
```

## Authentication / session

Authentication is **Supabase Auth**, called directly from the browser — these
are not backend routes. The backend only consumes the resulting JWT.

| Flow | Mechanism |
| --- | --- |
| Signup | `supabase.auth.signUp({ email, password })` — email confirmation is enabled, so a successful signup usually returns a user with no session; the UI shows a "check your inbox" state. No profile is created here. |
| Sign in | `supabase.auth.signInWithPassword({ email, password })` |
| Google sign in | `supabase.auth.signInWithOAuth({ provider: "google" })` → `/auth/callback` |
| Sign out | `supabase.auth.signOut()` |

Onboarding collects date of birth; the backend rejects users under 18
(server-side check on every profile save — the client prompt is UX only).

## Opportunity catalog (public reference data)

The category/activity system is **data-driven**: administrators create, rename,
reorder, enable/disable, and move activities between categories without schema
or frontend changes. Users never write to it.

Both endpoints are public (the database grants `anon` + `authenticated` SELECT)
and return **ACTIVE rows only**. The service role bypasses RLS, so the
`is_active` filter is re-applied server-side.

### `GET /api/v1/categories`

Categories in `sort_order`, then name, each with its nested active activities.

```json
[
  {
    "id": "0b8f7c2e-…",
    "name": "Sports",
    "slug": "sports",
    "icon": "🏸",
    "sort_order": 1,
    "is_active": true,
    "activities": [
      {
        "id": "13a9d4f0-…",
        "category_id": "0b8f7c2e-…",
        "name": "Badminton",
        "slug": "badminton",
        "sort_order": 1,
        "is_active": true
      }
    ]
  }
]
```

Errors: `database_unavailable` (503).

### `GET /api/v1/activities`

The flat active activity catalog, same ordering and per-activity shape as
nested above.

Errors: `database_unavailable` (503).

## Opportunities (public)

Admin-created opportunities are the primary source of partner-finding
activities. **Only `PUBLISHED` opportunities are public.** Users cannot create
opportunities or arbitrary partner-finding listings.

### `GET /api/v1/opportunities`

Browse published opportunities, newest first, capped at the 100 newest.

Query parameters:

| Param | Type | Notes |
| --- | --- | --- |
| `category_id` | UUID | Filter by category. |
| `activity_id` | UUID | Filter by activity. |

Response `200` — a list of public opportunity projections (see below).

Errors: `validation_error` (422, malformed filter), `database_unavailable` (503).

### `GET /api/v1/opportunities/{opportunity_id}`

One published opportunity's detail. A `DRAFT`/`PAUSED`/`CANCELLED`/`EXPIRED`
opportunity and an unknown id return the **same 404**, so nothing that is not
public leaks its existence.

Public opportunity shape (identical for the browse list, the detail endpoint,
and the opportunity embedded in "my activity"):

```json
{
  "id": "0b8f7c2e-…",
  "title": "Dandiya Night",
  "category": { "id": "…", "name": "Events", "slug": "events", "icon": "🎉" },
  "activity": { "id": "…", "name": "Dandiya", "slug": "dandiya" },
  "description": "Find your Dandiya partner.",
  "opportunity_date": "2026-10-18",
  "start_time": "19:00:00",
  "end_time": "22:00:00",
  "location": "Doon University",
  "cover_image_url": "https://…",
  "capacity": 60,
  "partner_requirement": "Pairs",
  "status": "PUBLISHED",
  "created_at": "2026-10-01T09:00:00+00:00"
}
```

`category` / `activity` are `null` when unset. `status` is always `PUBLISHED`
on this surface. `expiry` and `created_by` are admin-only fields and are never
returned here.

Errors: `not_found` (404, unknown or not published), `validation_error` (422,
malformed id), `database_unavailable` (503).

## Applications — joining an opportunity

A user has **one** UniMatch profile and applies with it; there is no
per-opportunity profile and no new form. Applications are the participation
record.

| Area | Endpoint | Notes |
| --- | --- | --- |
| Join an opportunity | `POST /opportunities/{id}/applications` | **Implemented** — contract below |
| My activity | `GET /applications` | **Implemented** — contract below |
| Leave an opportunity | `POST /applications/{id}/withdraw` | **Implemented** — contract below |

Application states are exactly `APPLIED` and `WITHDRAWN`.

### `POST /api/v1/opportunities/{opportunity_id}/applications`

Joins a published opportunity with the caller's existing profile. The profile
is resolved server-side from the bearer token; a client-supplied `profile_id`
carries no weight. No request body.

Gate: the caller must be `VERIFIED` (403 `permission_denied` otherwise). A
non-published or unknown opportunity is **404** (same shape as an unknown id).
Joining twice is **409 `already_applied`**.

Response `201`:

```json
{ "id": "9e2c…", "opportunity_id": "0b8f7c2e-…", "status": "APPLIED", "created_at": "2026-10-05T10:00:00+00:00" }
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED` / no profile), `not_found` (404, unknown or not
published), `already_applied` (409), `validation_error` (422, malformed id),
`database_insert_failed` / `database_unavailable` (503).

### `GET /api/v1/applications`

The caller's applications ("my activity"), newest first, each with the public
opportunity projection.

```json
{
  "applications": [
    {
      "id": "9e2c…",
      "status": "APPLIED",
      "created_at": "2026-10-05T10:00:00+00:00",
      "opportunity": { "…public opportunity shape…": "…" }
    }
  ]
}
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED` / no profile), `database_unavailable` (503).

### `POST /api/v1/applications/{application_id}/withdraw`

`APPLIED → WITHDRAWN` (a status transition, never a row deletion). The
application must belong to the caller — a foreign or unknown id is **404** —
and must be in `APPLIED` state, otherwise **409 `invalid_state_transition`**.

```json
{ "id": "9e2c…", "status": "WITHDRAWN", "created_at": "2026-10-05T10:00:00+00:00" }
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED`), `not_found` (404), `invalid_state_transition` (409),
`validation_error` (422), `database_update_failed` / `database_unavailable` (503).

## Opportunity discovery — contextual people

The opportunity is the context. The candidate pool is **exactly the people who
joined that same opportunity**, so a match or an action in one opportunity can
never surface in another. Users must have joined the opportunity to reach this
surface.

| Area | Endpoint | Notes |
| --- | --- | --- |
| People feed for an opportunity | `GET /opportunities/{id}/discovery` | **Implemented** — contract below |
| I'm interested | `POST /opportunities/{id}/discovery/{profile_id}/interest` | **Implemented** — mutual interest matches |
| Pass | `POST /opportunities/{id}/discovery/{profile_id}/pass` | **Implemented** |

### `GET /api/v1/opportunities/{opportunity_id}/discovery`

Query parameters:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | int | `20` | Page size, `1..50` (422 outside this range). |
| `cursor` | opaque string | omitted | The previous page's `next_cursor`. |

Gate order matters: an unknown/unpublished opportunity is **404 before** the
verification check, so the response never reveals whether the caller is
verified. Then the caller must be `VERIFIED` (403 `permission_denied`) **and**
have an `APPLIED` application for this opportunity (403 `not_applied`).

Eligibility (the opportunity slice of the global feed):

- the candidate joined **this same** opportunity with status `APPLIED`;
- the candidate is not the current user;
- the candidate is `VERIFIED` (latest submission);
- the candidate's gender satisfies the viewer's `seeking_gender` **and** the
  viewer's gender satisfies the candidate's `seeking_gender` (two-sided);
  `everyone` imposes no restriction on that side;
- no active block in either direction;
- the viewer has **not** already acted on the candidate *within this
  opportunity*. Acting on someone through a different opportunity does **not**
  exclude them here, and a match formed elsewhere is not a decision here.

Ordering is **deterministic and explainable**: newest profiles first
(`created_at` descending), `id` ascending as a stable tiebreaker, with opaque
cursor pagination.

```json
{
  "candidates": [
    {
      "id": "0b8f7c2e-…",
      "first_name": "Jamie",
      "age": 23,
      "university": { "id": "…", "name": "State University", "city": "College Town", "state": "CA", "country": "USA" },
      "custom_university_name": null,
      "university_label": "State University",
      "course": "Computer Science",
      "academic_year": 3,
      "gender": "woman",
      "bio": "Usually play doubles.",
      "relationship_intent": null,
      "height_cm": 170,
      "hometown": "Springfield",
      "motivations": ["making_friends"],
      "interests": [
        { "id": "13a9d4f0-…", "name": "Badminton", "source": "catalog" },
        { "id": "9c2a6b7d-…", "name": "Indie Game Design", "source": "custom" }
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

Contract / security notes (this is the single client-safe person projection,
shared by the feed, matches, and conversations):

- `age` is **derived** from `date_of_birth` server-side; the raw
  `date_of_birth` is **never** returned.
- `university_label` is the display string: the typed
  `custom_university_name` when the student is at an unlisted institution,
  otherwise the catalog `university.name`, otherwise
  `"University not listed"`. Both underlying fields are still returned.
- `photos[].url` is a **short-lived signed URL** generated server-side with
  the service-role client against the private `profile-photos` bucket;
  `storage_path` is read server-side and **never** returned.
- **Never exposed**: `auth_user_id`, `seeking_gender`, verification status
  strings / submissions / documents, `storage_path`, `created_at`, `updated_at`.
- `next_cursor` is `null` when no further candidates exist; otherwise it is an
  opaque token passed back as `cursor`.

Errors: `unauthorized` (401), `account_suspended` (403), `not_found` (404,
unknown or not published), `permission_denied` (403, not `VERIFIED` / no
profile), `not_applied` (403, hasn't joined this opportunity),
`validation_error` (422, `limit` outside 1..50 or a malformed id/cursor),
`database_unavailable` / `storage_signing_failed` (503).

### `POST /api/v1/opportunities/{opportunity_id}/discovery/{profile_id}/interest`

Records the viewer's interest in a person **through this opportunity**. Both
ids come from the URL path; there is no body and no client-supplied actor. The
target must have joined this same opportunity, be `VERIFIED`, and not be
blocked from the viewer — self, blocked, unknown, non-participant, and
unverified targets all return the same **404 `not_found`**.

Interest is immutable and scoped to the opportunity: a second interest (or a
pass) on the same person *in the same opportunity* is **409
`already_decided`**; an action taken through a different opportunity does not
block this one.

Response — recorded, no match yet:

```json
{ "outcome": "interest_recorded" }
```

Response — the other person had already expressed interest **in this same
opportunity**, so a match is created (exactly once; concurrent mutual
interests cannot produce duplicates):

```json
{
  "outcome": "matched",
  "match": {
    "id": "0b8f7c2e-…",
    "opportunity": {
      "id": "0b8f7c2e-…",
      "title": "Dandiya Night",
      "category": { "id": "…", "name": "Events", "slug": "events", "icon": "🎉" },
      "activity": { "id": "…", "name": "Dandiya", "slug": "dandiya" }
    },
    "created_at": "2026-10-08T10:00:00+00:00",
    "profile": { "…same client-safe person shape as the feed above…": "…" }
  }
}
```

The `opportunity` object is the reason the two people matched. The same pair
may match independently through a different opportunity.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, viewer not `VERIFIED` / no profile), `not_found` (404, unknown or not
published opportunity; or self / blocked / non-participant / unverified
target), `already_decided` (409), `validation_error` (422, malformed id),
`database_insert_failed` / `database_unavailable` / `storage_signing_failed` (503).

### `POST /api/v1/opportunities/{opportunity_id}/discovery/{profile_id}/pass`

Identical gate, target, 404, 409, and immutability rules as the interest
endpoint. A pass can never create a match.

```json
{ "outcome": "pass_recorded" }
```

Errors: same as the interest endpoint (minus `storage_signing_failed`).

## Matches

A match is always contextual — it remembers the opportunity it came from.

| Area | Endpoint | Notes |
| --- | --- | --- |
| List my active matches | `GET /matches` | **Implemented** — contract below |
| Unmatch | `DELETE /matches/{match_id}` | **Implemented** — contract below |

Match detail (`GET /matches/{match_id}`) is not exposed.

### `GET /api/v1/matches`

The caller's ACTIVE matches, newest first. Only the two participants ever see
a match; other users receive an empty list. Matches involving an active block
in either direction are hidden from both participants while the block stands
(rows are retained, and everything returns when the block is removed).

```json
{
  "matches": [
    {
      "id": "0b8f7c2e-…",
      "opportunity": { "id": "…", "title": "Dandiya Night", "category": { "…": "…" }, "activity": { "…": "…" } },
      "created_at": "2026-10-08T10:00:00+00:00",
      "profile": { "…same client-safe person shape as the discovery feed…": "…" }
    }
  ]
}
```

`profile` is the **other** participant as a client-safe projection. `opportunity`
is the same minimal context object returned by the interest endpoint; it is
`null`/absent for a match created before opportunity scoping existed.
Unmatched matches are never returned; the row is retained server-side so an
unmatched pair cannot rematch through normal discovery. "Who is interested in
you" does not exist — incoming interest is never readable.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED` / no profile), `database_unavailable` /
`storage_signing_failed` (503).

### `DELETE /api/v1/matches/{match_id}`

Soft-unmatches an active match. Only the two participants may unmatch: an
unknown match, a nonparticipant's match, a match blocked in either direction,
and an already-unmatched match all return **404 `not_found`**. `unmatched_at`
is set server-side (the row is never deleted); both participants stop seeing
the match immediately, and its conversation becomes inaccessible immediately.

```json
{ "id": "0b8f7c2e-…", "unmatched_at": "2026-10-08T12:00:00+00:00" }
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED`), `not_found` (404), `validation_error` (422, malformed
`match_id`), `database_update_failed` / `database_unavailable` (503).

## Messaging

Chats are **temporary and contextual**: a conversation IS an active match (the
match id doubles as the conversation id), and it carries the opportunity the
two people matched through. A conversation is **active for 24 hours** — no
message within the window lapses it; the match stays, the conversation becomes
inaccessible (every endpoint then returns 404). Unmatching makes the
conversation inaccessible immediately, with rows retained.

REST for history/sending/read markers. Live transport is **deferred**: v1
polls the open conversation (~every 5s) — no Realtime, typing indicators,
read receipts, attachments, or push notifications. Messages are immutable text
rows; no edit/delete path exists.

| Area | Endpoint | Notes |
| --- | --- | --- |
| Conversations | `GET /conversations` | **Implemented** — contract below |
| Messages history | `GET /conversations/{id}/messages` | **Implemented** — contract below |
| Send message | `POST /conversations/{id}/messages` | **Implemented** |
| Read marker | `POST /conversations/{id}/read` | **Implemented** |

Every messaging endpoint requires the CALLER to be `VERIFIED` (403
`permission_denied` otherwise). The matched partner is not re-checked per
request — matches only ever form between verified participants. Unknown match
ids, nonparticipants, unmatched matches, blocked pairs, and lapsed (24h)
conversations all return the same **404 `not_found`**. Sender identity always
derives from the bearer token.

### `GET /api/v1/conversations`

The caller's **active** conversations, newest first — each with the other
person, the opportunity they matched through, and the caller's unread count
(messages the other side sent since the caller last marked the conversation
read).

```json
{
  "conversations": [
    {
      "id": "0b8f7c2e-…",
      "opportunity": { "id": "…", "title": "Dandiya Night", "category": { "…": "…" }, "activity": { "…": "…" } },
      "created_at": "2026-10-08T10:00:00+00:00",
      "unread_count": 2,
      "profile": { "…same client-safe person shape as the discovery feed…": "…" }
    }
  ]
}
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED`), `database_unavailable` / `storage_signing_failed` (503).

### `GET /api/v1/conversations/{conversation_id}/messages`

One page of history, **newest first**, keyset-paginated on `(created_at, id)`:

- `limit` — page size, default 30, max 100 (422 outside 1..100).
- `cursor` — opaque cursor from the previous page's `next_cursor`; the next
  page is strictly **older**, so paging is stable while new messages arrive.
  Clients poll page 1 (no cursor) for updates.

```json
{
  "messages": [
    {
      "id": "9e2c…",
      "sender_profile_id": "33333333-…",
      "is_own": true,
      "body": "Hey! Want to grab coffee after?",
      "created_at": "2026-10-08T12:00:00.123456+00:00"
    }
  ],
  "next_cursor": "eyJjIjoiMjAyNi0xMC0wOFQxMjowMC…"
}
```

A full page always emits `next_cursor`; the follow-up fetch (possibly empty)
ends the walk. `is_own` is computed server-side from the token.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED`), `not_found` (404, unknown / nonparticipant / unmatched /
blocked / lapsed conversation), `validation_error` (422, malformed id, bad
cursor, bad limit), `database_unavailable` (503).

### `POST /api/v1/conversations/{conversation_id}/messages`

Sends one text message (`201`). The body is trimmed server-side and must be
1–2000 characters after trimming (422 otherwise); messages are immutable. One
atomic backend operation inserts the message AND increments the recipient's
unread counter.

```json
// request
{ "body": "Hey! Want to grab coffee after?" }

// 201 response
{
  "id": "9e2c…",
  "sender_profile_id": "33333333-…",
  "is_own": true,
  "body": "Hey! Want to grab coffee after?",
  "created_at": "2026-10-08T12:00:00.123456+00:00"
}
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED`), `not_found` (404, unknown / nonparticipant / unmatched /
blocked / lapsed conversation), `validation_error` (422,
missing/empty-after-trim/over-2000-characters body), `database_insert_failed` /
`database_unavailable` (503).

### `POST /api/v1/conversations/{conversation_id}/read`

Marks the conversation read for the CALLER (zeroes their per-participant
unread counter; idempotent). The other participant's counter is untouched.

```json
{ "conversation_id": "0b8f7c2e-…", "unread_count": 0 }
```

Errors: same as the history endpoint (`database_update_failed` instead of
`database_unavailable` on write failure, 503).

## Profiles

| Area | Endpoint | Notes |
| --- | --- | --- |
| Get/update my profile | `GET/POST/PUT /profiles/me` | **Implemented** — POST creates (one per account) |
| University catalog | `GET /universities` | **Implemented** — read-only catalog |
| Interests catalog | `GET /interests` | **Implemented** — read-only catalog |
| Interest + motivation selection | managed within profile ops | **Implemented** — rules below |
| Photos | `GET/POST /profiles/me/photos`, `DELETE /profiles/me/photos/{id}`, `PUT /profiles/me/photos/order` | **Implemented** — private bucket, backend-proxied upload, signed URLs |
| View others' profile | `GET /profiles/{id}` | **Planned** — no endpoint yet; people are discovered through opportunity feeds |

### `GET /api/v1/universities`

The supported-university catalog (name order), used by the profile/onboarding
forms. Read-only by design — students can never create or modify catalog
entries. A profile may claim one catalog university **or** a free-text
`custom_university_name` for an unlisted institution.

Errors: `unauthorized` (401), `database_unavailable` (503).

### `GET /api/v1/interests`

The shared interest catalog (read-only reference data) in deterministic name
order. Authentication required; students can never create or modify catalog
entries. User-created interests live separately in `custom_interests` and never
modify this catalog.

```json
[
  { "id": "0b8f7c2e-…", "name": "Hiking" },
  { "id": "13a9d4f0-…", "name": "Photography" }
]
```

Errors: `unauthorized` (401), `database_unavailable` (503).

### Interest and motivation selection on `POST` / `PUT /api/v1/profiles/me`

The request body accepts an optional `interest_ids` array of catalog UUIDs and
an optional `custom_interest_names` array of user-created interest names; the
profile response always includes the resulting selection as `interests` —
client-safe entries resolved server-side, ordered by name, each with a `source`
discriminator (`"catalog"` or `"custom"`):

```json
{
  "…profile fields…": "…",
  "motivations": ["dating", "making_friends"],
  "interests": [
    { "id": "13a9d4f0-…", "name": "Hiking", "source": "catalog" },
    { "id": "9c2a6b7d-…", "name": "Indie Game Design", "source": "custom" }
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
- At most **8** interests **in total** (`interest_ids` +
  `custom_interest_names` combined); an empty or omitted array is valid and
  means no interests.
- Custom interest names: trimmed, 1–40 characters, no case-insensitive
  duplicates within one request, and **no case-insensitive match against a
  catalog entry** ("already in the catalog — select it instead"). Custom
  interests are stored per user and never modify the shared catalog.
- `motivations` is an optional array of controlled values (`dating`,
  `making_friends`, `confidence_and_communication`), 1–3 items, no duplicates;
  it defaults to `[]` when omitted. The database CHECK
  (`profiles_motivations_valid`) remains the authority on the value set; `dating`
  remains a valid value.
- Selections always apply to the profile resolved from the bearer token —
  client-supplied `auth_user_id`/`profile_id` values carry no weight.
- `PUT` uses **replace-set semantics**: the caller's existing selections and
  custom interests are deleted and exactly the submitted sets are written
  (an empty array clears that source; removed custom-interest rows are
  deleted, new names are created). Unrelated profile fields are untouched by
  that step.
- Date of birth is re-validated against the 18+ rule on every save.

Errors: `unauthorized` (401), `account_suspended` (403), `profile_not_found`
(404, PUT without a profile), `profile_already_exists` (409, POST when one
exists), `validation_error` (422 — unknown interest id, duplicate ids, more
than 8 combined interests, invalid custom interest name, catalog collision,
invalid motivation value, under-18 date of birth, or any other profile field
violation), `database_unavailable` / `database_insert_failed` /
`database_update_failed` (503).

### `POST /api/v1/profiles/me/photos`

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

Errors: `unauthorized` (401), `account_suspended` (403), `profile_not_found`
(404), `invalid_file_type` (400, empty/unknown/mismatched bytes),
`file_too_large` (413), `photo_limit_reached` (409, 6 photos already),
`photo_upload_conflict` (409, concurrent mutation — retry),
`storage_upload_failed` (503), `database_unavailable` /
`database_insert_failed` (503). A database failure after the Storage upload
removes the just-uploaded object (no orphans).

### `GET /api/v1/profiles/me/photos`

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

### `DELETE /api/v1/profiles/me/photos/{photo_id}`

Deletes the caller's photo row and its private Storage object (service
role), then renumbers the remaining photos to 1..N preserving their relative
order; the photo at position 1 is the primary photo. A foreign or unknown
photo id is `photo_not_found` (404) — no existence leak. Returns the updated
collection in the same shape as the list endpoint.

Errors: `unauthorized` (401), `account_suspended` (403), `profile_not_found`
(404), `photo_not_found` (404), `database_unavailable` /
`database_delete_failed` / `storage_signing_failed` (503).

### `PUT /api/v1/profiles/me/photos/order`

Applies a full ordering to the caller's photos. The body must be a
permutation of ALL of the profile's photo ids — each id exactly once, no
unknown ids; the photo placed first becomes the primary photo. Position
values, `is_primary`, and storage paths are server-derived and never
accepted from the client.

```json
{ "photo_ids": ["c…", "a…", "b…"] }
```

Response `200` — the updated collection (same shape as the list endpoint).
Errors: `unauthorized` (401), `account_suspended` (403), `profile_not_found`
(404), `photo_not_found` (404, ids belonging to other users or unknown
photos), `invalid_photo_order` (400, not a permutation of the caller's
photos), `photo_upload_conflict` (409, concurrent mutation — retry),
`validation_error` (422, more than 6 ids), `database_unavailable` /
`database_update_failed` (503).

## Verification

User-facing:

| Area | Endpoint | Notes |
| --- | --- | --- |
| Submit student ID | `POST /verification/submit` | **Implemented** — multipart upload + create `PENDING` |
| My verification status | `GET /verification/status` | **Implemented** — includes rejection reason if `REJECTED` |

`POST /verification/submit` takes a multipart `file` (JPEG, PNG, WebP, or PDF,
max 10 MB) and requires an existing profile with **at least one** profile photo
(`photo_required`, 400) — the onboarding gate is client-side, so the minimum is
re-checked server-side before anything is stored. Re-submitting while
`VERIFIED` is `already_verified` (409); re-submitting while a `PENDING`
submission is open is `pending_submission_exists` (409). Response `201`:

```json
{ "id": "0b8f7c2e-…", "status": "PENDING", "submitted_at": "2026-10-01T10:00:00+00:00", "reviewed_at": null, "rejection_reason": null }
```

`GET /verification/status` returns the caller's own state and nothing else:

```json
{ "verification_status": "REJECTED", "submission": { "…submission shape above…", "rejection_reason": "Document unreadable" } }
```

Both are `{"verification_status": null, "submission": null}` before the first
submission. The private document path is never returned.

Errors: `unauthorized` (401), `account_suspended` (403), `profile_not_found`
(404), `invalid_file_type` (400), `photo_required` (400), `file_too_large`
(413), `already_verified` (409), `pending_submission_exists` (409),
`validation_error` (422), `storage_upload_failed` / `database_insert_failed` /
`database_unavailable` (503).

Reviewer-facing endpoints live under [Admin](#admin-staff-only).

## Safety (user-facing)

| Area | Endpoint | Notes |
| --- | --- | --- |
| Block another user | `POST /blocks` | **Implemented** — idempotent, reversible |
| My blocks | `GET /blocks/me` | **Implemented** — so users can manage their list |
| Unblock | `DELETE /blocks/{profile_id}` | **Implemented** |
| Report another user | `POST /reports` | **Implemented** — reason category + optional detail + optional content reference |

A block is a **pure visibility filter**: it never deletes matches, messages, or
actions. The pair disappears from discovery, interest/pass, matches, and
messaging in **both** directions while the block stands, and everything is
restored on unblock. Blocking stays silent for the blocked user (no read path
on their side).

### `POST /api/v1/blocks`

Body — the target is the only client input; the blocker is server-derived:

```json
{ "target_profile_id": "33333333-…" }
```

Idempotent: re-blocking returns the existing row. Self, unknown, and
unverified targets return **404 `not_found`**.

```json
{
  "id": "9e2c…",
  "blocker_profile_id": "44444444-…",
  "blocked_profile_id": "33333333-…",
  "created_at": "2026-10-08T12:00:00+00:00"
}
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, caller not `VERIFIED`), `not_found` (404), `validation_error` (422),
`database_insert_failed` / `database_unavailable` (503).

### `GET /api/v1/blocks/me`

The caller's outgoing blocks, newest first:

```json
{
  "blocks": [
    { "id": "9e2c…", "profile_id": "33333333-…", "first_name": "Rahul", "created_at": "2026-10-08T12:00:00+00:00" }
  ]
}
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, caller not `VERIFIED`), `database_unavailable` (503).

### `DELETE /api/v1/blocks/{profile_id}`

```json
{ "profile_id": "33333333-…", "unblocked": true }
```

Errors: `unauthorized` (401), `account_suspended` (403), `not_found` (404, no
such outgoing block), `validation_error` (422), `database_delete_failed` /
`database_unavailable` (503).

### `POST /api/v1/reports`

```json
{
  "reported_profile_id": "33333333-…",
  "reason": "harassment",
  "detail": "Optional free text, trimmed, max 1000 characters.",
  "content_type": "message",
  "content_id": "9e2c…"
}
```

`reason` is one of `harassment`, `inappropriate_content`, `fake_profile`,
`underage`, `spam`, `other`. `content_type` is one of `profile`, `message`,
`photo`; `content_type` and `content_id` must be supplied **together** or not
at all (there is no FK — a deleted message/photo must not destroy the
reference). Reporting writes exactly one row and changes nothing else: no
automatic block, unmatch, or matching effect. Reports are admin-only — the
reporter cannot read reports back, so the `201` response is just the
receipt:

```json
{ "id": "9e2c…", "status": "OPEN", "created_at": "2026-10-08T12:00:00+00:00" }
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, caller not `VERIFIED`), `not_found` (404, self or unknown target),
`validation_error` (422, unknown reason / bad content pair / over-long
detail), `database_insert_failed` / `database_unavailable` (503).

## Admin (staff-only)

Every route below requires a valid Supabase Auth JWT whose auth user has a row
in `public.staff_admins`; the membership check happens server-side in FastAPI
via the service-role client. Frontend route protection is **not** security:
unauthenticated → 401, authenticated non-staff → 403, staff → allowed.
Authorization derives exclusively from the token identity. The service-role
key never reaches any client, and the admin console is a single application
under `/admin` (Overview, People & Verification, People, Safety & Moderation,
Opportunities, Catalog, Account).

| Area | Endpoint |
| --- | --- |
| Dashboard metrics | `GET /admin/dashboard` |
| Verification queue | `GET /admin/verifications?status=PENDING` |
| Securely view submitted ID | `GET /admin/verifications/{id}/document-url` |
| Decide verification | `POST /admin/verifications/{id}/decision` |
| Reports | `GET /admin/reports`, `POST /admin/reports/{id}/decision` |
| People directory | `GET /admin/users`, `GET /admin/users/{profile_id}` |
| Account restriction | `POST/DELETE /admin/users/{profile_id}/block`, `POST/DELETE /admin/users/{profile_id}/suspend`, `GET /admin/suspensions` |
| Block moderation | `GET /admin/blocks`, `DELETE /admin/blocks/{block_id}` |
| Categories | `GET/POST /admin/categories`, `PUT/DELETE /admin/categories/{id}` |
| Activities | `GET/POST /admin/activities`, `PUT/DELETE /admin/activities/{id}` |
| Opportunities | `GET/POST /admin/opportunities`, `GET/PUT/DELETE /admin/opportunities/{id}` |
| Opportunity states | `POST /admin/opportunities/{id}/publish\|pause\|cancel\|expire` |
| Opportunity applicants | `GET /admin/opportunities/{id}/applications` |

### `GET /api/v1/admin/dashboard`

Real counts only — nothing is fabricated.

```json
{
  "users": { "total": 120, "verified": 83 },
  "verification": { "pending": 4 },
  "opportunities": { "total": 9, "published": 6 },
  "matches": { "active": 21 },
  "reports": { "total": 3, "open": 1 },
  "applications": { "total": 48, "applied": 44 },
  "suspensions": { "active": 1 }
}
```

Errors: `unauthorized` (401), `permission_denied` (403), `database_unavailable` (503).

### `GET /api/v1/admin/verifications`

Reviewer queue metadata, oldest submissions first, capped at the 100 oldest.
Query parameter `status` is `PENDING` (default) | `VERIFIED` | `REJECTED`.

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
      "university": { "name": "State University", "city": "College Town", "state": "CA", "country": "USA" },
      "custom_university_name": null,
      "university_label": "State University"
    }
  }
]
```

A profile claims exactly one university, so exactly one of
`university.name` / `custom_university_name` is populated;
`university_label` is the field a reviewer UI can always render.

Deliberately **not** included: `storage_path` (the private document
reference), the document itself, any signed URL, reviewer fields, or profile
fields unnecessary for ID review (bio, social links, auth identity).

Errors: `unauthorized` (401), `permission_denied` (403), `validation_error`
(422, unknown `status`), `database_unavailable` (503).

### `GET /api/v1/admin/verifications/{verification_id}/document-url`

Returns a **short-lived signed URL** for a submission's private ID document so
a staff reviewer can view it. The submission's document reference
(`storage_path`) is resolved **server-side from the database**; the client can
neither supply nor override it. The URL is generated by the backend-only
service-role client against the **private** `verification-documents` bucket.
The bucket is never made public and no public URL or Storage policy is
created. The document path is never returned to the client — only the URL.

```json
{
  "url": "https://<project>.supabase.co/storage/v1/object/sign/verification-documents/<auth-user>/<file-id>.png?token=...",
  "expires_in": 300
}
```

The signed URL expires after `expires_in` seconds (default **300** / 5
minutes, configurable via `VERIFICATION_SIGNED_URL_TTL_SECONDS`). Once it
expires the reviewer must request a fresh URL.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `validation_error` (422, malformed `verification_id`),
`verification_not_found` (404), `document_unavailable` (503, submission has no
stored document reference), `database_unavailable` (503),
`storage_signing_failed` (503).

### `POST /api/v1/admin/verifications/{verification_id}/decision`

Records a staff reviewer's decision on a `PENDING` submission. Client-supplied
`reviewer_id`, `auth_user_id`, `user_id`, `reviewed_at`, or `storage_path`
values are never accepted or persisted.

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `VERIFIED` \| `REJECTED` | Yes | Any other value is rejected (422). |
| `rejection_reason` | string | For `REJECTED` | Required for `REJECTED`: non-empty, trimmed, 1–500 chars (the database constraint). Ignored for `VERIFIED` and never persisted. |

Response `200` — the updated submission with reviewer-safe fields only:

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

`reviewed_at` is assigned server-side by the database trigger; every decision
is appended to the append-only `verification_reviews` audit trail (reviewer,
decision, timestamp, reason) by that trigger — the API does not and cannot
write audit records itself.

State machine: only `PENDING → VERIFIED` and `PENDING → REJECTED` are legal.
Decided submissions are immutable — a second decision returns **409
`invalid_state_transition`**. The database trigger remains the authoritative
guard; the API surfaces invalid transitions as a clean conflict error.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `validation_error` (422, malformed `verification_id`, missing/invalid
`status`, or a `REJECTED` decision without a valid `rejection_reason`),
`invalid_rejection_reason` (400, the decision could not satisfy the rejection
reason constraint), `verification_not_found` (404),
`invalid_state_transition` (409), `database_unavailable` (503),
`database_update_failed` (503).

### `GET /api/v1/admin/reports`

Reviewer-safe report metadata, newest first, capped. Each entry carries the
report reason, detail, optional content reference, timestamp, and minimal
context for both the reporter and the reported person (profile id, first name,
course, academic year, university). The stored `content_type` set is
`profile` / `message` / `photo` / `opportunity`; when the content is an
opportunity, its projection is attached under `opportunity`. (Users cannot
submit `opportunity` as a content reference through `POST /reports`.)

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `database_unavailable` (503).

### `POST /api/v1/admin/reports/{report_id}/decision`

```json
{ "status": "REVIEWED" }
```

`status` must be one of `OPEN`, `REVIEWED`, `DISMISSED`. The schema keeps no
reviewer column, so the reviewer is not stored on the row; the caller was
already authorized by the route. Re-deciding is allowed (a dismissed report
can be reopened); there is no destructive operation.

```json
{ "id": "9e2c…", "status": "REVIEWED", "created_at": "2026-10-08T12:00:00+00:00" }
```

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `not_found` (404), `validation_error` (422, unknown status),
`database_update_failed` / `database_unavailable` (503).

### `GET /api/v1/admin/users`

Admin-safe user records, newest first. Query parameters: `q` (case-insensitive
first-name search), `limit` (1–50, default 50).

```json
[
  {
    "profile_id": "5a4b3c2d-…",
    "first_name": "Jamie",
    "course": "Computer Science",
    "academic_year": 3,
    "gender": "woman",
    "created_at": "2026-08-20T09:00:00+00:00",
    "university": { "id": "…", "name": "State University" },
    "custom_university_name": null,
    "university_label": "State University",
    "verification": { "status": "VERIFIED", "submitted_at": "2026-08-28T10:00:00+00:00" },
    "account": { "suspended": false, "suspension_reason": null, "suspended_until": null }
  }
]
```

The directory exposes only first name, course, academic year, gender,
university, creation time, verification status, and account status — never auth
ids, emails, `date_of_birth`, verification documents, or storage paths. No
invasive surveillance surface exists.

Errors: `unauthorized` (401), `permission_denied` (403), `validation_error`
(422), `database_unavailable` (503).

### `GET /api/v1/admin/users/{profile_id}`

One user in the same shape, or `not_found` (404). Errors as above.

### Account restriction

Account-level restriction is one model (`public.suspensions`), reused by the
admin console and enforced globally in the API.

| Endpoint | Effect |
| --- | --- |
| `POST /admin/users/{profile_id}/suspend` | Timed suspension. Body `{ "reason": "…", "suspended_until": "…" }` — `reason` is required and trimmed (1–500 chars); `suspended_until` may be `null` for an indefinite suspension. `201` returns the suspension record. |
| `POST /admin/users/{profile_id}/block` | Indefinite block; same body, `suspended_until` is ignored (a block has no expiry). `201`, same record shape. |
| `DELETE /admin/users/{profile_id}/suspension` | Lift all active suspensions on a user: `{ "profile_id": "…", "suspended": false, "lifted": 2 }`. |
| `DELETE /admin/users/{profile_id}/block` | Lift the indefinite block. |
| `GET /admin/suspensions` | Active suspensions, newest first. |

```json
{
  "id": "9e2c…",
  "profile_id": "5a4b3c2d-…",
  "reason": "Repeated reports",
  "suspended_until": "2026-11-01T00:00:00+00:00",
  "created_at": "2026-10-08T12:00:00+00:00"
}
```

The staff identity is server-derived from the token and recorded as
`created_by`; it is never client input. A suspension window already in the past
is `invalid_suspension_window` (400).

Errors: `unauthorized` (401), `permission_denied` (403), `not_found` (404),
`validation_error` (422), `database_write_failed` / `database_update_failed` /
`database_unavailable` (503).

### Block moderation

| Endpoint | Effect |
| --- | --- |
| `GET /admin/blocks` | List user-to-user blocks for moderation. |
| `DELETE /admin/blocks/{block_id}` | Lift a specific block. Response `{ "id": "…", "removed": true }`. |

Errors: `unauthorized` (401), `permission_denied` (403), `not_found` (404),
`database_delete_failed` / `database_unavailable` (503).

### Categories and activities

Full CRUD for the data-driven catalog. Staff-only. Every write takes the
complete field set (an update is a full replace, never a silent partial
clear).

`CategoryWrite`: `{ name, slug, icon, sort_order, is_active }`
`ActivityWrite`: `{ category_id, name, slug, sort_order, is_active }`

An activity moves between categories by updating its `category_id` — no
frontend or schema change.

- `GET /admin/categories`, `GET /admin/activities` return the **full** catalog
  including inactive rows (the public endpoints return active only).
- `POST` → `201` with the created row.
- `PUT /admin/categories/{id}`, `PUT /admin/activities/{id}` → `200`.
- `DELETE` → removed. A category still referenced by an opportunity is `409
  category_in_use`; an activity still referenced by an opportunity is detached
  (`activity_id` becomes `null`) rather than blocked. A duplicate slug is `409
  duplicate_catalog_entry`.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `not_found` (404), `validation_error` (422), `duplicate_catalog_entry`
(409), `category_in_use` (409), `database_write_failed` /
`database_delete_failed` / `database_unavailable` (503).

### Opportunities

Admin-created opportunities are the primary source of partner-finding
activities. **Normal users hold no opportunity write path at all** — this is
the only place opportunities are managed.

`OpportunityWrite`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | Yes | Trimmed, non-blank, 1–120 chars. |
| `category_id` | UUID | Yes | Must exist. |
| `activity_id` | UUID | No | Must exist when present. |
| `description` | string | No | Trimmed, ≤2000 chars, defaults to `""`. |
| `opportunity_date` | date | No | |
| `start_time` | time | No | |
| `end_time` | time | No | Must be **after** `start_time` when both are given. |
| `location` | string | No | Trimmed, ≤200 chars; `""` clears it. |
| `cover_image_url` | string | No | Trimmed, ≤1024 chars; `""` clears it. |
| `capacity` | int | No | Must be > 0 when present. |
| `partner_requirement` | string | No | Trimmed, ≤200 chars; `""` clears it. |
| `expiry` | datetime | No | Admin-only; never returned on the public surface. |

`status` is **not** accepted in the body: an opportunity is born `DRAFT` and
only moves between states through the dedicated transition endpoints, so the
state machine stays explicit and auditable.

| Endpoint | Effect |
| --- | --- |
| `GET /admin/opportunities` | All opportunities in any state, newest first, capped at 200. Optional `status` filter; an unknown value is `400 invalid_state`. |
| `POST /admin/opportunities` | Create a `DRAFT`. `201`. |
| `GET /admin/opportunities/{id}` | One opportunity in any state. |
| `PUT /admin/opportunities/{id}` | Edit — `DRAFT` only, otherwise `409`. |
| `DELETE /admin/opportunities/{id}` | Remove. Applications, actions, and matches in that opportunity cascade away. |
| `POST /admin/opportunities/{id}/publish` | → `PUBLISHED` from any non-terminal state (`DRAFT`, `PAUSED`, `EXPIRED`); becomes publicly visible. A `CANCELLED` opportunity is terminal and can never be published again (`409`). |
| `POST /admin/opportunities/{id}/pause` | `PUBLISHED` → `PAUSED` (hidden from the public surface). |
| `POST /admin/opportunities/{id}/cancel` | `PUBLISHED` → `CANCELLED` (terminal). |
| `POST /admin/opportunities/{id}/expire` | `PUBLISHED` → `EXPIRED`. |

`pause`, `cancel`, and `expire` only apply to a currently `PUBLISHED`
opportunity; anything else is `409 invalid_state_transition`.
| `GET /admin/opportunities/{id}/applications` | Who applied, any status, newest first. |

States are exactly `DRAFT`, `PUBLISHED`, `PAUSED`, `CANCELLED`, `EXPIRED`. The
state machine is enforced in the service layer and re-checked by the database
status CHECK. Responses use the admin opportunity shape — the public fields
plus `expiry`, `created_by`, `updated_at`.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403), `not_found` (404), `invalid_state` (400), `invalid_category` (409),
`invalid_state_transition` (409), `validation_error` (422),
`database_write_failed` / `database_delete_failed` / `database_update_failed` /
`database_unavailable` (503).

## Legacy person-only discovery (still shipped, no longer used by the web app)

The original dating-era surface is retained (and still served by the backend)
but the shipped web client does not use it: people are now discovered through
an opportunity. It exists so existing matches/actions/messages keep resolving.

| Area | Endpoint | Notes |
| --- | --- | --- |
| Global candidate feed | `GET /discovery/feed` | **Implemented** — verified-only, deterministic ordering, cursor pagination |
| Global like | `POST /discovery/{profile_id}/like` | **Implemented** — creates a match on mutual like |
| Global pass | `POST /discovery/{profile_id}/pass` | **Implemented** |

`GET /discovery/feed` eligibility: not the current user, has a profile,
`VERIFIED`, two-sided gender compatibility (`everyone` imposes no restriction),
no active block, and the **viewer** has not already acted on the candidate.
Candidates who acted on the viewer stay discoverable so the mutual like can
form. Ordering is newest profiles first (`created_at` descending) with `id`
ascending as a tiebreaker — no random ordering. Response `200`:

```json
{
  "candidates": [ { "…same client-safe person shape as the opportunity feed…": "…" } ],
  "next_cursor": "…"
}
```

`POST /discovery/{profile_id}/like` takes no body; the actor is resolved from
the bearer token, so actor spoofing is structurally impossible. The target must
exist, be `VERIFIED`, and not be the viewer — self, unknown, and unverified
targets all return **404 `not_found`**. A second action on the same target is
**409 `already_decided`** (actions are immutable). Responses are
`{"outcome": "like_recorded"}` or, on a mutual like,
`{"outcome": "matched", "match": { "id": "…", "created_at": "…", "profile": { "…": "…" } }}`
(no `opportunity` key — a match created through this route predates opportunity
scoping).

`POST /discovery/{profile_id}/pass` → `{"outcome": "pass_recorded"}`.

Errors: `unauthorized` (401), `account_suspended` (403), `permission_denied`
(403, not `VERIFIED` / no profile), `not_found` (404), `already_decided` (409),
`validation_error` (422), `database_unavailable` / `database_insert_failed` /
`storage_signing_failed` (503).

Super Like and Undo/Rewind have no endpoints (deferred); users cannot update
or delete their own actions in v1.

## Planned (no endpoint yet)

- `GET /profiles/{profile_id}` — full profile view for an eligible viewer.
- Group proposals from users with admin approval (curated user-created groups).
  Nothing in the schema or API exists for this yet; the only opportunity write
  path is the admin one.
- Per-opportunity editing of the joined participant list (capacity is
  currently informational only).
- Rate limiting and abuse controls; JWT validation middleware details beyond
  the current per-route dependency.

Items above are scope statements, not contracts; each gets documented here (and
in OpenAPI) before implementation — see [ROADMAP.md](ROADMAP.md).
