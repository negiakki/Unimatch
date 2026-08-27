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

## Verification privacy & auditability

- Student ID submissions (`PENDING` / `VERIFIED` / `REJECTED`) and their
  document references are visible only to the submitting user and authorized
  reviewers. Other users can see nothing more than a "verified" indicator on
  eligible profiles.
- Manual admin review is authoritative; no automated process can finalize a
  verification state.
- Every review decision is recorded in an append-only audit trail: reviewer
  identity, decision, rejection reason if any, timestamps. Audit records are
  not editable through normal application flows and survive later profile/
  account changes.
- Signed URLs for ID documents: short TTL, generated per-request for
  reviewers only, never persisted in logs or analytics.

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
- Student ID documents are deleted with the account; verification audit
  records may be retained in minimized form as required for safety/compliance
  (retention rule TBD).
- Deletion propagates to Realtime presence/channels so deleted accounts leave
  no active sessions.

## Current foundation

- CORS restricted to an explicit origin allow-list (`CORS_ORIGINS`).
- Uniform error envelope that never leaks stack traces; unexpected exceptions
  log server-side and return a generic message.
- No PII is stored yet — the health endpoint is the only surface.

## To be designed with future features

- Admin/moderator authorization model details and role escalation beyond the
  single v1 admin.
- Rate limiting / abuse controls for uploads, swipes, and messaging.
- Session refresh middleware pattern for Next.js + Supabase Auth.
- JWT validation middleware specifics on FastAPI protected routes.
- Data-retention implementation for unmatched conversations and deleted
  accounts.
