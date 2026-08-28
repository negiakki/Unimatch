# UniMatch — Security

> Status: security requirements for v1. Mechanisms marked **TBD** are designed
> alongside their feature phase.

## Non-negotiables

- **Student ID documents are the most sensitive asset.** They live in a
  private Storage bucket, are never served by public URL, and are viewable
  only by authorized reviewers via short-lived signed URLs generated
  server-side (FastAPI) after checking reviewer authorization.
- **18+ only.** Date of birth is collected at signup and validated
  server-side; users under 18 can never create or use a dating profile.
  Client-side checks are UX affordances only.
- **Verification gate.** Discovery, likes, passes, matching, and messaging
  require verification status `VERIFIED`, enforced in FastAPI and again via
  Row Level Security — never trusted from the client.
- **Server-side authorization.** All authorization-sensitive operations
  (dating actions, discovery rules, matching, verification workflow,
  moderation) are performed/authorized by FastAPI. Hiding UI elements client-
  side is never the security control. Reviewer/admin capability is checked
  server-side before any privileged Supabase call; v1 has one trusted admin,
  designed to extend to multiple moderators (mechanism TBD).
- Database access is deny-by-default via **Row Level Security**; policies are
  part of every migration.
- The Supabase `service_role` key is **server-side only** (FastAPI
  environment); it must never reach the browser or mobile client. The anon
  key is the maximum exposure for any client.
- Secrets never enter git: `.env*` files are ignored; only `.env.example`
  templates are committed.

## Verification privacy & auditability (implemented at the database layer)

- Student ID submissions (`PENDING` / `VERIFIED` / `REJECTED`) and their
  document references are visible only to the submitting user and registered
  staff reviewers. Other users can see nothing more than a "verified"
  indicator on eligible profiles.
- **Ownership is never client-supplied.** Every policy resolves ownership
  from `auth.uid()` through the existing `profiles.auth_user_id`
  relationship (`profile_id` in a submission is matched against the
  caller's own profile row); a client-supplied profile/user id carries zero
  authorization weight.
- **What a normal user can do:** insert a submission for their own profile
  (born `PENDING`, server-timestamped) and read their own submissions —
  including their rejection reason. Nothing else.
- **What a normal user can never do:** change verification status
  (self-`VERIFIED` is impossible), touch reviewer fields, insert/update/
  delete audit records, or read another user's submission or document
  reference. There are **no UPDATE/DELETE grants** on submissions and **no
  write grants at all** on the audit table, so these fail with `permission
  denied` before RLS is even evaluated; RLS additionally hides all rows from
  non-owners. Verified explicitly by the test suite.
- **Reviewer authorization:** only rows in `staff_admins` (registered Supabase
  Auth identities) can be recorded as reviewers — foreign keys make an
  invalid reviewer impossible. The service role (FastAPI, after checking
  reviewer authorization server-side) performs decisions; the database
  structurally enforces decision shape, the backend enforces who may decide.
  In FastAPI this is enforced by a dedicated staff dependency: the caller's
  Supabase Auth bearer token is resolved to an auth user id, and reviewer
  membership is checked server-side against `staff_admins` with the
  service-role client (401 for unauthenticated callers, 403 for
  authenticated non-staff).
- **Reviewer queue discloses metadata only:** `GET /api/v1/admin/verifications`
  (staff-only, above) returns submission id, profile id, status, submitted_at,
  and minimal profile/university fields needed for ID review. It deliberately
  never returns `storage_path`, the document itself, or any signed URL;
  client-supplied `user_id`/`reviewer_id` values carry no authorization
  weight, and student verification endpoints and RLS behavior are unchanged.
- **Document signed URLs are short-lived and server-generated:**
  `GET /api/v1/admin/verifications/{id}/document-url` (staff-only) resolves
  the private object path from the database server-side (never from the
  client), generates a signed URL through the backend-only service-role
  client, and returns it. The bucket remains private; no public URL or Storage
  policy is created; `storage_path` is never returned to any caller. The
  signed URL has a default lifetime of 300 seconds (5 minutes, configurable
  via `VERIFICATION_SIGNED_URL_TTL_SECONDS`). When it expires the reviewer
  must request a fresh URL. Unauthorized users (missing/invalid token, or
  non-staff) receive 401/403 with no Storage interaction. Nonexistent
  submissions receive 404, and Storage failures produce 503.
- **Decisions are staff-only and server-identified:**
  `POST /api/v1/admin/verifications/{id}/decision` records a `VERIFIED` or
  `REJECTED` decision. Only registered staff may decide; the reviewer identity
  derives exclusively from the authenticated Supabase Auth bearer token
  (resolved to an auth user and checked against `staff_admins` server-side) —
  client-supplied `reviewer_id`/`auth_user_id`/`user_id` values carry no
  authorization weight and are never persisted. The submission UUID in the URL
  is the only client-supplied identifier. `storage_path` and private document
  access are unrelated to and unaffected by a decision request. Decisions are
  constrained to the legal transitions `PENDING → VERIFIED` / `PENDING →
  REJECTED` (decided rows are immutable); invalid transitions return a clean
  409 conflict, never a raw database error. A `REJECTED` decision requires a
  non-empty, trimmed, ≤500-char rejection reason (enforced by API validation
  and again by the database); `VERIFIED` never persists a rejection reason.
  The decision timestamp is server-assigned and each decision is automatically
  written to the append-only `verification_reviews` audit trail by the existing
  trigger — the backend never inserts audit records itself, so duplicate or
  skipped audit rows are impossible.
- **Decisions are constrained and audited by construction:** a decision must
  be a legal transition (`PENDING → VERIFIED` / `PENDING → REJECTED`, the
  only status changes allowed; decided rows are immutable), requires a
  registered reviewer, is server-timestamped, must carry a valid rejection
  reason when rejected, and **automatically** writes an append-only
  `verification_reviews` record (reviewer, decision, timestamp, reason) — a
  status change without an audit row is structurally impossible. UPDATE and
  TRUNCATE on audit records raise even for the service role; normal users
  hold no write path at all.
- **Document references only:** PostgreSQL stores a private Storage object
  path (unique, immutable, trimmed, ≤1024 chars) — never the document, never
  a URL. The path of another user is not readable by clients.
- **Derived verification status, self-only disclosure:** no denormalized
  "verified" flag exists that a user could manipulate, and there is
  deliberately **no** user-callable status helper — the earlier draft
  `current_verification_status(profile_id)` helper (which would have let any
  authenticated user query arbitrary profiles' PENDING/REJECTED/VERIFIED
  state) was removed by design. Users can obtain verification status only
  for their **own** profile, derived from `auth.uid()` → `profiles.id` via
  the owner-only RLS read; other profiles' statuses are unobtainable by
  clients.
- Signed URLs for ID documents: short TTL, generated per-request for
  reviewers only, never persisted in logs or analytics. This is now
  implemented for reviewers (`GET /api/v1/admin/verifications/{id}/document-url`),
  generated server-side against the private bucket.

## Block / report privacy

- A block is never revealed to the blocked user: they experience silence
  (no discovery visibility, no message delivery) rather than an explicit
  notice.
- Report contents (reporter identity, free-text detail, content references)
  are accessible only to admins. Reported users are not notified of reporter
  identity.
- Blocking must also make prior conversation content inaccessible between the
  pair while the block stands.

## Account & data deletion considerations

- Users can delete their account; deletion must remove or irreversibly
  anonymize PII: profile data, photos (storage objects), date of birth, likes/
  passes, conversation participation. Retention windows for residual data
  (e.g., messages needed for safety investigations) are **TBD** product
  decisions tracked in [PRD.md](PRD.md).
- Student ID documents are deleted with the account (submission rows cascade
  from the profile; the Storage objects themselves are cleaned up by the app
  layer). Verification audit records currently cascade away with the account
  too; retaining them in minimized form for safety/compliance is a **TBD**
  rule — see [DATABASE.md](DATABASE.md) limitations.
- Reviewer records are protected by RESTRICT foreign keys: a staff account
  with recorded decisions cannot be deleted (disable it instead) so the audit
  trail always answers "who decided".
- Deletion propagates to Realtime presence/channels so deleted accounts leave
  no active sessions.

## Current foundation

- CORS restricted to an explicit origin allow-list (`CORS_ORIGINS`).
- Uniform error envelope that never leaks stack traces; unexpected exceptions
  log server-side and return a generic message.
- No PII is stored yet — the health endpoint is the only surface.

## To be designed with future features

- Admin/moderator authorization model details and role escalation beyond the
  single v1 admin. The database side exists (`staff_admins` registry + FK
  enforcement); the FastAPI-side membership check and any reviewer-facing
  tooling come with the review workflow implementation.
- Rate limiting / abuse controls for uploads, swipes, and messaging.
- Session refresh middleware pattern for Next.js + Supabase Auth.
- JWT validation middleware specifics on FastAPI protected routes.
- Data-retention implementation for unmatched conversations, deleted
  accounts, and minimized verification audit records.
