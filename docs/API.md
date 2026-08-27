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
  FastAPI. Exact authorization model TBD.

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

Reviewer-facing (admin authorization required; model TBD):

| Area | Endpoint sketch | Notes |
| --- | --- | --- |
| List pending verifications | `GET /admin/verifications?status=PENDING` | Metadata view |
| Securely view submitted ID | `GET /admin/verifications/{id}/document-url` | Returns short-lived signed URL; generated server-side only |
| Decide | `POST /admin/verifications/{id}/decision` | `VERIFIED` / `REJECTED` (+ required reason on reject); every decision appended to audit trail |

No automated decisioning exists in v1; automation may only assist reviewers later.

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
