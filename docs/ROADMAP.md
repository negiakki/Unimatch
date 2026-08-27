# UniMatch — Roadmap

Deliberately phase-based without dates. Each phase keeps lint/typecheck/tests
green before it ships.

## Phase 0 — Foundation ✅ (this task)

- Monorepo layout, docs skeleton, CI workflow
- Next.js app: design tokens, landing page, env handling, Supabase clients
- FastAPI app: settings, versioned router, health endpoint, error envelope
- Backend tests passing locally and in CI

## Phase 1 — Accounts & profiles

- Supabase Auth integration in the web app + session patterns
- Profile creation flow (photos, interests) behind auth

## Phase 2 — Verification

- Student ID upload to a private bucket, `PENDING` status UI
- Minimal admin review tooling → `VERIFIED` / `REJECTED` decisions
- Hard gate: discovery/likes/matching/messaging require verified status

## Phase 3 — Discovery & matching

- Card-stack browsing, like/pass, mutual match events

## Phase 4 — Messaging

- Realtime chat on Supabase Realtime between matched users

## Phase 5 — Hardening & launch prep

- Moderation/report/block flows, rate limits, analytics, performance
- groundwork so a React Native client can reuse the same API

Items above are scope statements, not detailed specs; each gets its own design
pass before implementation.
