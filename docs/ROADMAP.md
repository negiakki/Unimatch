# UniMatch — Roadmap

Deliberately phase-based without dates. Each phase keeps lint/typecheck/tests
green before it ships. Scope statements below defer to [PRD.md](PRD.md) as the
authoritative specification.

UniMatch is **opportunity-first**: people are discovered inside an opportunity
they have joined, never as a generic profile stream.

## Phase 0 — Foundation ✅ (complete)

- Monorepo layout, docs skeleton, CI workflow
- Next.js app: design tokens, landing page, env handling, Supabase clients
- FastAPI app: settings, versioned router, health endpoint, error envelope
- Backend tests passing locally and in CI

## Phase 1 — Database design + Supabase ✅ (complete)

- Dedicated database design pass → finalized schema document
- Migrations: entities per [DATABASE.md](DATABASE.md), RLS policies from day one
- Private Storage buckets (profile photos vs student IDs) with policies
- Design decisions recorded before any table creation

## Phase 2 — Authentication & onboarding ✅ (complete)

- Supabase Auth (email/password + Google) integrated in the web app + session
  patterns; `@supabase/ssr` cookie handling
- Signup collects date of birth; hard 18+ eligibility check server-side,
  re-checked on every profile save
- 7-step onboarding wizard wired to the verification gate

## Phase 3 — Profiles & photos ✅ (complete)

- Profile create/edit (required + optional fields per PRD) — **implemented**
- Photo upload/delete/reorder, primary photo ordering (min 1 / max 6) —
  **implemented** (private `profile-photos` bucket, signed-URL delivery,
  magic-byte sniffing, no orphaned Storage objects on failure)
- Interests catalog & selection chips — **implemented** (read-only
  `GET /interests` catalog; up to 8 selections per profile, validated
  server-side, replace-set updates on edit)
- University catalog (`GET /universities`) plus free-text
  `custom_university_name` for unlisted institutions, with a reviewer-visible
  `university_label` everywhere a catalog name used to be rendered — implemented

## Phase 9.3 — Profile preferences (custom interests, motivations, academic year) ✅ (complete)

- Custom interests: user-owned `custom_interests` table kept separate from
  the read-only catalog; per-profile case-insensitive uniqueness, 1–40 char
  names, catalog-collision rejection, shared combined budget of 8 with
  catalog selections, replace-set updates — **implemented**
- Motivations ("Why I'm here"): `profiles.motivations text[]` with a
  CHECK-controlled value set (`dating`, `making_friends`,
  `confidence_and_communication`); 1–3 selections via the API, optional/
  backward-compatible default `[]` — **implemented**
- Academic year tightened 1–8 → **1–6** across DB CHECK, Pydantic schemas,
  frontend options/validation, tests, and docs — **implemented**
- Discovery responses expose `motivations` and merged interests with a
  `source` discriminator (`catalog` vs `custom`) — **implemented**

## Phase 4 — Student ID verification + manual review ✅ (complete)

- Student ID upload to private `verification-documents` bucket → `PENDING`,
  with a server-side minimum-one-profile-photo gate — **implemented**
- `GET /verification/status` for the caller's own state incl. rejection reason
  — **implemented**
- Reviewer workflow: pending list, secure document viewing (short-lived signed
  URLs, default 5 min), approve → `VERIFIED`, reject with a required reason,
  append-only audit trail written by the database trigger — **implemented**
- Hard gate: joining opportunities, discovery, interest/pass, matching, and
  messaging all require `VERIFIED` — **implemented**

## Phase 5 — Discovery ✅ (complete)

- Database: `is_profile_verified` / `is_current_user_verified` boolean helpers
  + cross-user SELECT RLS policies (profiles, photos, interests) — implemented
- Backend: `GET /api/v1/discovery/feed` — verified-only, two-sided gender
  compatibility, deterministic ordering (newest first + id tiebreaker), cursor
  pagination, signed photo URLs, client-safe response — **implemented**
- Supabase SQL tests + focused backend tests — **implemented**
- Deferred to later phases: age-range preferences, location filtering, AI
  recommendations

## Phase 6 — Like/pass/matching ✅ (complete)

- ONE `dating_actions` table for `LIKE`/`PASS` — exactly one immutable action
  per (viewer, candidate, opportunity) triple, enforced by a partial unique
  index so the same pair can act in two different opportunities; self-actions,
  duplicates, and direction flips rejected; actor identity resolved from the
  token, never client input — **implemented**
- Mutual-interest match creation with dedupe: canonical pair ordering +
  unique pair constraint as the concurrency arbiter; matches stored
  explicitly; participant-only visibility — **implemented**
- `GET /matches`, `DELETE /matches/{match_id}` (participant-only soft
  unmatch) — **implemented**
- Frontend: Pass/Interested buttons (non-gesture fallback), swipe left/right,
  submitting states + double-submit prevention, match celebration carrying the
  opportunity, `/matches` list page with unmatch — **implemented**
- Deferred: Super Like/Undo, "who is interested in you"

## Phase 7 — Messaging ✅ (complete)

- Conversations + text messages REST surface: `GET /conversations`,
  `GET /conversations/{id}/messages`, `POST /conversations/{id}/messages`,
  `POST /conversations/{id}/read` — **implemented**
- A conversation IS an active match (match id doubles as the conversation id):
  participant-only access end-to-end, and an unmatch makes the conversation
  inaccessible immediately (rows retained) — **implemented**
- **Ephemeral by design**: a conversation lapses after 24 h without a new
  message, after which every messaging endpoint returns 404 — **implemented**
- Simple per-participant unread counters (no per-message read receipts):
  incremented atomically on send, zeroed on mark-read, surfaced in the
  conversation list — **implemented**
- Message bodies trimmed server-side, 1–2000 characters; messages immutable
  in v1 (no edit/delete) — **implemented**
- Message history keyset-paginated on (created_at, id), newest first; the
  open conversation polls ~every 5s — **implemented**
- Frontend: `/messages` conversation list (person shape + opportunity context +
  unread badges), `/messages/[id]` chat view (polling, load-earlier
  pagination, send) — **implemented**
- Deferred: Supabase Realtime streaming (messages/read receipts/typing/
  presence), attachments, push notifications

## Phase 8 — Safety & moderation ✅ (complete)

- Block/unblock affecting discovery, actions, matches, and messaging in both
  directions, reversible and silent for the blocked user — **implemented**
- Reporting flow (reason category, optional detail, optional content
  reference) with no automatic consequences; staff report list + decision
  (`OPEN`/`REVIEWED`/`DISMISSED`) — **implemented**
- Account suspensions (`public.suspensions`): indefinite block or timed
  suspension, enforced in one place in the API so writes and both discovery
  feeds are refused while reads of one's own data keep working; lapsed
  suspensions expire automatically — **implemented**
- Admin surfaces: dashboard metrics, people directory, account restriction,
  block moderation, reports — **implemented**
- Unmatch completeness across all surfaces — **implemented**

## Phase 10 — Opportunity-first pivot ✅ (complete)

The product moved from "a stream of profiles" to "people around something you
are doing". Additive schema work; the dating-era surfaces were kept working.

- Database: `categories` + `activities` (data-driven, reorderable, enable/disable),
  `opportunities` with an explicit `DRAFT → PUBLISHED → PAUSED/CANCELLED/EXPIRED`
  state machine, `applications`, and `opportunity_id` on actions and matches —
  **implemented**
- Mutual interest now forms a **contextual** match: the same two people can
  connect independently through different opportunities, and nothing leaks
  across opportunity contexts — **implemented**
- Backend: public `GET /categories`, `GET /activities`, `GET /opportunities`,
  `GET /opportunities/{id}`; authenticated join / my-activity / withdraw;
  opportunity-scoped feed, interest, and pass — **implemented**
- Admin: opportunity CRUD + state transitions + applicant list, full category
  and activity CRUD, dashboard metrics — **implemented**
- Frontend: landing page that leads with the opportunity-first promise,
  `/explore` browse + joined/withdraw, `/opportunities/[id]` detail with join,
  `/opportunities/[id]/people` contextual swipe with opportunity context, and a
  single `/admin` console (Overview, People & Verification, People, Safety &
  Moderation, Opportunities, Catalog, Account) — **implemented**
- Kept working for existing data: the person-only `GET /discovery/feed` and
  like/pass endpoints, and legacy matches/conversations without opportunity
  context — **implemented, no longer surfaced by the web client**

## Next

- User-created group proposals with admin approval (curated, never
  self-publishing). No schema or API exists yet; the only opportunity write
  path today is the admin one.
- Profile detail endpoint (`GET /profiles/{id}`) — people are currently only
  surfaced through opportunity feeds.
- Per-opportunity participant management (capacity is informational today).
- Supabase Realtime messaging, attachments, push notifications.
- Age-range preferences, location filtering, cross-university preference.
- Rate limiting / abuse controls, launch-readiness review, and groundwork so a
  future React Native client can reuse the same API.

Items above are scope statements, not detailed specs; each gets its own design
pass before implementation.
