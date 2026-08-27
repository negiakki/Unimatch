# UniMatch — Architecture

> Status: foundation established; detailed module design **TBD** as features land.

## Overview

Three independent concerns, deployed separately:

```
Browser / (future) React Native
        │  HTTPS + Supabase JS (auth session)
        ▼
Next.js web app (Vercel)          FastAPI backend (Render)
  UI, routing, session handling     business logic, authorization
                                    server-side privileged ops
                                        │ service-role key (never client-side)
                                        ▼
                                  Supabase (managed)
                                  Postgres · Storage · Realtime · Auth
```

## Responsibility boundary

The boundary between Next.js, FastAPI, and Supabase is authoritative:

| Concern | Next.js | FastAPI | Supabase |
| --- | --- | --- | --- |
| UI, routing, presentation, client interaction | ✅ | — | — |
| Auth session management (cookies, token refresh UX) | ✅ | validates JWTs | issues sessions |
| Business logic (dating rules, eligibility, ranking) | ❌ | ✅ | ❌ |
| Authorization-sensitive operations | ❌ | ✅ | RLS defense-in-depth |
| Dating actions (like/pass) | ❌ | ✅ | persists |
| Discovery rules & preferences | ❌ | ✅ | queried via service role |
| Matching + dedupe | ❌ | ✅ | constraints |
| Verification workflow (submit/review/audit) | renders UI only | ✅ | stores |
| Moderation (block/report) decisions surface | ❌ | ✅ | stores |
| Privileged Supabase functionality (service-role reads/writes, signed URLs for private media) | ❌ | ✅ | executes |
| PostgreSQL, Auth, private file storage, Realtime infrastructure | consumes | consumes | ✅ |

Non-negotiables:

- **Sensitive business operations must not rely solely on client-side
  checks.** Hiding UI is a convenience; every gate (18+ eligibility,
  `VERIFIED`-only access, match membership, photo ownership, reviewer
  authorization) is re-enforced server-side in FastAPI and again at the
  database layer via Row Level Security where practical.
- Next.js code performs **no privileged data access**: the browser uses the
  anon key only. The `service_role` key exists solely inside FastAPI's
  environment.
- Verification review endpoints (viewing student IDs, deciding outcomes) are
  reached through FastAPI, which checks reviewer authorization before any
  privileged call.

## Frontend (`frontend/`)

- Next.js App Router, TypeScript, `@/*` → `src/*` path alias.
- Tailwind CSS v4 with design tokens declared in `src/app/globals.css`
  (`bg-background`, `text-ink`, `bg-accent`, …).
- Supabase access only through `src/lib/supabase`:
  - `client.ts` — browser client (`createBrowserClient`), per call.
  - `server.ts` — server/RSC client wired to `next/headers` cookies.
- Environment variables via `src/lib/env.ts` (lazy validation so builds never
  require credentials).
- Business logic stays out of components; page files compose presentational UI.
- Feature work will add: auth screens + onboarding (18+ check surfaces),
  verification submission/status UI, profile editors, discovery card stack,
  matches list, chat, safety actions — all presenting FastAPI results.

## Backend (`backend/app/`)

Layered, module-ready structure:

| Path                     | Responsibility                                |
| ------------------------ | --------------------------------------------- |
| `main.py`                | `create_app()` factory, CORS, error handlers  |
| `core/config.py`         | pydantic-settings, cached `get_settings()`    |
| `core/exceptions.py`     | `AppError` hierarchy + error codes            |
| `api/deps.py`            | shared dependencies (annotated DI aliases)    |
| `api/routes/router.py`   | aggregates versioned route modules            |
| `api/routes/health.py`   | `GET /api/v1/health`                          |

All client-facing errors use one JSON envelope:

```json
{ "error": { "code": "not_found", "message": "…" } }
```

Planned feature modules plug into `router.py`; cross-cutting needs go through
`deps.py`. No ORM by design — the Supabase Python client handles data access,
using the service role only for privileged operations (verification review,
private-media signing, moderation, anything the anon key must not do directly).

Auth model: clients authenticate with Supabase Auth; FastAPI verifies the
Supabase JWT on protected routes and resolves the caller's user identity and
verification status per request. Reviewer/admin capability comes from a
design that starts with one trusted admin account and extends to additional
moderators without redesign (mechanism TBD).

No ORM by design — Supabase client libraries handle data access once integrated.

## Supabase

- **PostgreSQL** — all persistent entities ([DATABASE.md](DATABASE.md));
  Row Level Security deny-by-default on user-readable tables.
- **Auth** — identity provider; age/date-of-birth ownership lives in our own
  tables, not Auth metadata of record.
- **Storage** — separate private buckets for student ID documents vs profile
  photos; ID documents served only through short-lived signed URLs generated
  server-side for authorized reviewers.
- **Realtime** — chat message streaming, read receipts, typing/presence, all
  channel access governed by database policies/authorization.

Credentials come from environment variables only; the anon key reaches the
browser, the service-role key must stay server-side.

## Environments & deployment

| Component | Local               | Production |
| --------- | ------------------- | ---------- |
| Frontend  | `localhost:3000`    | Vercel     |
| Backend   | `localhost:8000`    | Render     |
| Supabase  | shared dev project  | dedicated project |

CI runs lint/typecheck/build (frontend) and pytest (backend) on every push/PR.
