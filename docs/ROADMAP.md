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

## Phase 3 — Profiles & photos

- Profile create/edit (required + optional fields per PRD)
- Interests catalog & selection chips
- Photo upload/delete/reorder, primary photo ordering (min 1 / max 6)

## Phase 4 — Student ID verification + manual review

- Student ID upload to private bucket → `PENDING`
- Internal reviewer workflow: pending list, secure document viewing (signed
  URLs), approve → `VERIFIED`, reject with reason, audit trail recording
- Hard gate: discovery/likes/passes/matching/messaging require `VERIFIED`

## Phase 5 — Discovery

- Eligible-candidate feed enforcing the full exclusion list + preferences
- Deterministic, explainable ranking; cursor pagination

## Phase 6 — Like/pass/matching

- `LIKE` / `PASS` actions; already-decided rejection handling
- Mutual-like match creation with dedupe; matches list
- Unmatch behavior incl. conversation hiding

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
