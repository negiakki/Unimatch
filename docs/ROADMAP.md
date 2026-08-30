# UniMatch — Roadmap

Deliberately phase-based without dates. Each phase keeps lint/typecheck/tests
green before it ships. Scope statements below defer to [PRD.md](PRD.md) as the
authoritative specification.

## Phase 0 — Foundation ✅ (complete)

- Monorepo layout, docs skeleton, CI workflow
- Next.js app: design tokens, landing page, env handling, Supabase clients
- FastAPI app: settings, versioned router, health endpoint, error envelope
- Backend tests passing locally and in CI

## Phase 1 — Database design + Supabase

- Dedicated database design pass → finalized schema document
- Migrations: entities per [DATABASE.md](DATABASE.md), RLS policies from day one
- Private Storage buckets (profile photos vs student IDs) with policies
- Design decisions recorded before any table creation

## Phase 2 — Authentication & onboarding

- Supabase Auth integration in the web app + session patterns
- Signup collects date of birth; hard 18+ eligibility check server-side
- Onboarding entry points wired to verification gating UX

## Phase 3 — Profiles & photos ✅ (complete)

- Profile create/edit (required + optional fields per PRD) — **implemented**
- Photo upload/delete/reorder, primary photo ordering (min 1 / max 6) —
  **implemented** (private `profile-photos` bucket, signed-URL delivery)
- Interests catalog & selection chips — **implemented** (read-only
  `GET /interests` catalog; up to 8 selections per profile, validated
  server-side, replace-set updates on edit)

## Phase 4 — Student ID verification + manual review

- Student ID upload to private bucket → `PENDING`
- Internal reviewer workflow: pending list, secure document viewing (signed
  URLs), approve → `VERIFIED`, reject with reason, audit trail recording
- Hard gate: discovery/likes/passes/matching/messaging require `VERIFIED`

## Phase 5 — Discovery

- Database: `is_profile_verified` / `is_current_user_verified` boolean helpers +
  cross-user SELECT RLS policies (profiles, photos, interests) — **implemented**
- Backend: `GET /api/v1/discovery/feed` — verified-only, two-sided gender
  compatibility, deterministic ordering (newest first + id tiebreaker), cursor
  pagination, signed photo URLs, client-safe response — **implemented**
- Supabase SQL tests + focused backend tests — **implemented**
- Deferred to later phases: blocks, age-range preferences, likes/passes,
  matches, location filtering, AI recommendations

## Phase 6 — Like/pass/matching ✅ (complete)

- ONE `dating_actions` table for `LIKE`/`PASS` — exactly one immutable action
  per (viewer, candidate) pair; self-actions, duplicates, and direction
  flips (LIKE after PASS) rejected; actor identity resolved from the token,
  never client input — **implemented**
- Mutual-like match creation with dedupe: canonical pair ordering +
  unique pair constraint as the concurrency arbiter; matches stored
  explicitly; participant-only visibility — **implemented**
- `POST /discovery/{profile_id}/like`, `POST /discovery/{profile_id}/pass`,
  `GET /matches`, `DELETE /matches/{match_id}` (participant-only soft
  unmatch) — **implemented**
- Discovery feed excludes candidates already acted on by either side
  (batched, no N+1); VERIFIED gate + gender preference + deterministic
  ordering + cursor pagination preserved — **implemented**
- Frontend: Pass/Like buttons (non-gesture fallback), swipe left/right,
  submitting states + double-submit prevention, match celebration modal
  ("Keep discovering" / "View matches"), `/matches` list page with unmatch —
  **implemented**
- Deferred to later phases: messaging (conversations + "Send message" on the
  match modal), blocks/reports, age-range/location preferences,
  Super Like/Undo, "who liked you"

## Phase 7 — Messaging

- Conversations + text messages REST surface (history/send/read markers)
- Supabase Realtime streaming: messages, read receipts, typing/presence
- Participant-only access control end-to-end

## Phase 8 — Safety & moderation

- Block/unblock affecting discovery + messaging
- Reporting flow + minimal admin report viewing
- Unmatch completeness across all surfaces

## Phase 9 — UI polish, testing & launch

- Mobile-first polish against the PRD visual direction
- End-to-end test passes, rate limiting/abuse controls, performance pass
- Launch readiness review; groundwork so a future React Native client can
  reuse the same API

Items above are scope statements, not detailed specs; each gets its own design
pass before implementation.
