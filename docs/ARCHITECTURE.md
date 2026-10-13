# UniMatch — Architecture

> Status: implemented. This document describes the architecture as shipped.
> Product rules live in [PRD.md](PRD.md), endpoint contracts in
> [API.md](API.md), the schema in [DATABASE.md](DATABASE.md), and the security
> model in [SECURITY.md](SECURITY.md).

## Overview

UniMatch is **opportunity-first**: people are discovered inside an opportunity
they have joined, never as a generic profile stream. Three independent
concerns, deployed separately:

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
                                   Postgres · Storage · Auth
```

## Opportunity-first request flow

The shape of the product shows up in where each rule is enforced:

```
Landing page            GET /opportunities, /categories      public (anon SELECT,
  (anon)                                                  PUBLISHED rows only)
Explore                 GET /opportunities, /applications   list published;
                                                          own "my activity"
Opportunity detail      GET /opportunities/{id}             public; 404 for drafts
  → Join                POST …/applications                 VERIFIED + PUBLISHED;
                                                          no duplicate; profile
                                                          resolved from the token
Opportunity people      GET …/discovery                     404 (unpublished)
                                                          → 403 (not VERIFIED)
                                                          → 403 not_applied
                                                          → applicant pool only,
                                                            two-sided preferences,
                                                            opportunity-scoped
                                                          exclusions, cursor page
  → Interested / Pass   POST …/discovery/{id}/{interest|pass}
                                                          immutable, scoped to the
                                                          opportunity; mutual interest
                                                          creates ONE contextual
                                                          match
Matches                 GET /matches, DELETE /matches/{id}  participant-only;
                                                          carries the opportunity
Chat                    /conversations/*                    conversation IS the
                                                          match; lapses after 24h
                                                          of inactivity
Admin console           /admin/*                            staff only, verified
                                                          server-side against
                                                          staff_admins
```

Two consequences worth stating explicitly:

- **The opportunity is the authorization scope.** The candidate pool for an
  opportunity is exactly that opportunity's `APPLIED` applicants, and actions
  and matches are keyed by `(pair, opportunity)`. Nothing leaks across
  opportunity contexts — not in the feed, not in a match, not in a chat.
- **Context travels with the connection.** Every match, conversation, and
  match-celebration payload carries the opportunity it came from, so the UI can
  answer "why are we talking?" without a second lookup.

## Responsibility boundary

The boundary between Next.js, FastAPI, and Supabase is authoritative:

| Concern | Next.js | FastAPI | Supabase |
| --- | --- | --- | --- |
| UI, routing, presentation, client interaction | ✅ | — | — |
| Auth session management (cookies, token refresh UX) | ✅ | validates JWTs | issues sessions |
| Opportunity discovery, ordering, pagination | ❌ | ✅ | queried via service role |
| Join / withdraw application lifecycle | ❌ | ✅ | constraints |
| Interest & pass actions (immutable, opportunity-scoped) | ❌ | ✅ | partial unique index |
| Match creation & dedupe | ❌ | ✅ | unique index |
| Conversations, messages, 24h lapse | ❌ | ✅ | persists, RLS defense-in-depth |
| Profile & photo management rules | ❌ | ✅ | stores |
| Verification workflow (submit/review/audit) | renders UI only | ✅ | stores, trigger-enforced |
| Catalog, opportunity, and admin management | ❌ | ✅ | stores |
| Moderation (block/report/suspension) | renders UI only | ✅ | stores |
| Privileged Supabase functionality (service-role reads/writes, signed URLs for private media) | ❌ | ✅ | executes |
| Row Level Security | consumes | relies on | ✅ |
| PostgreSQL, Auth, private file storage | consumes | consumes | ✅ |

Non-negotiables:

- **Sensitive business operations must not rely solely on client-side checks.**
  Hiding UI is a convenience; every gate (18+ eligibility, `VERIFIED`-only
  access, opportunity participation, match membership, photo ownership,
  suspension state, reviewer authorization) is re-enforced server-side in
  FastAPI and again at the database layer via Row Level Security where
  practical.
- Next.js code performs **no privileged data access**: the browser uses the anon
  key only. The `service_role` key exists solely inside FastAPI's environment.
- Verification review, report viewing, the user directory, account
  restriction, catalog management, and opportunity management are reached
  through FastAPI, which checks staff authorization before any privileged call.
- Services that bypass RLS re-apply the filter in code (`PUBLISHED` for
  opportunities, `is_active` for the catalog). RLS is defense-in-depth, not the
  only guard.

## Frontend (`frontend/`)

- Next.js App Router, TypeScript, `@/*` → `src/*` path alias.
- Tailwind CSS v4 with design tokens declared in `src/app/globals.css`
  (`bg-paper`, `text-ink`, `bg-accent`, `text-muted`, `border-line`, …).
- Supabase access only through `src/lib/supabase`:
  - `client.ts` — browser client (`createBrowserClient`), per call.
  - `server.ts` — server/RSC client wired to `next/headers` cookies.
- Environment variables via `src/lib/env.ts` (lazy validation so builds never
  require credentials).
- All backend traffic goes through one shared HTTP client
  (`src/lib/api/http.ts`), which attaches the Supabase session token and
  normalizes the `{ "error": { code, message } }` envelope.
- Business logic stays out of components; page files compose presentational UI.
- Routes:

  | Route | Purpose |
  | --- | --- |
  | `/` | Public landing page — categories + upcoming opportunities, reads work signed out |
  | `/signup`, `/login`, `/auth/callback` | Supabase Auth (email/password + Google) |
  | `/onboarding`, `/profile/edit` | The one universal profile |
  | `/verify` | Student ID submission and status |
  | `/explore` | Browse published opportunities; joined ones with withdraw |
  | `/opportunities/[id]` | Opportunity detail and join |
  | `/opportunities/[id]/people` | Contextual people feed (swipe + buttons) |
  | `/matches` | Matches with opportunity context; unmatch |
  | `/messages`, `/messages/[id]` | Conversations and chat (polling) |
  | `/profile` | Own profile |
  | `/admin/*` | Single admin console |

- Navigation is one component with two presentations: a top bar on desktop, a
  bottom tab bar on mobile (Discover · Matches · Chats · Profile). The admin
  console uses the same pattern with a desktop rail.

## Backend (`backend/app/`)

Layered, module-per-feature structure:

| Path | Responsibility |
| --- | --- |
| `main.py` | `create_app()` factory, CORS, error handlers |
| `core/config.py` | pydantic-settings, cached `get_settings()` |
| `core/exceptions.py` | `AppError` hierarchy + error codes |
| `api/deps.py` | shared dependencies — the single authorization choke point |
| `api/routes/router.py` | aggregates versioned route modules |
| `services/*.py` | one module per feature; routes stay thin |

Route modules: `health`, `profiles`, `photos`, `universities`, `interests`,
`verification`, `admin` (reviewer), `discovery`, `matches`, `conversations`,
`blocks`, `reports`, `catalog`, `opportunities`, `applications`,
`opportunity_discovery`, `admin_catalog`, `admin_opportunities`, `admin_users`.

All client-facing errors use one JSON envelope:

```json
{ "error": { "code": "not_found", "message": "…" } }
```

### The authorization choke point

`api/deps.py` resolves every caller's identity from the Supabase bearer token —
no route reads an identity from a payload. Two dependencies do all the work:

- `CurrentAuthUserDep` — a valid Supabase Auth session. It also enforces the
  **account-suspension gate**: a state-changing request (or a request to either
  discovery feed) from a suspended account is refused with `403
  account_suspended` before any handler runs. Ordinary reads of one's own data
  stay available, and lapsed suspensions expire automatically. There is no
  staff exemption.
- `CurrentStaffUserDep` — additionally requires a row in `public.staff_admins`,
  checked with the service-role client. Frontend route protection is explicitly
  *not* treated as security.

Cross-cutting business rules (VERIFIED-only access, two-sided partner
preferences, opportunity participation, 24-hour lapse, photo ownership) are
enforced in the service layer per feature and mirrored by RLS policies in the
database.

Auth model: clients authenticate with Supabase Auth; FastAPI verifies the JWT on
protected routes and resolves the caller's profile and verification status per
request. Staff capability starts from the `staff_admins` registry, so more
moderators are added by inserting rows rather than by redesigning the auth
path.

No ORM by design — the Supabase Python client handles data access, using the
service role only for privileged operations (verification review, private-media
signing, catalog/opportunity administration, moderation, anything the anon key
must not do directly).

## Supabase

- **PostgreSQL** — all persistent entities ([DATABASE.md](DATABASE.md)); Row
  Level Security deny-by-default on every user-reachable table, with the
  opportunity-first tables (`categories`, `activities`, `opportunities`,
  `applications`) readable by `anon` only where the product intends it
  (`PUBLISHED` opportunities, active catalog rows).
- **Auth** — identity provider; age/date-of-birth ownership lives in our own
  tables, not Auth metadata of record.
- **Storage** — separate private buckets for student ID documents
  (`verification-documents`) vs profile photos (`profile-photos`), with
  different MIME policies. ID documents are served only through short-lived
  signed URLs generated server-side for authorized reviewers; the same applies
  to profile photos, which are never public.
- **Realtime** — infrastructure is available but **not used**: v1 polls the open
  conversation (~5 s). Realtime channels for live messages, read receipts, and
  typing/presence remain a deferred slice.

Credentials come from environment variables only; the anon key reaches the
browser, the service-role key must stay server-side.

## Environments & deployment

| Component | Local               | Production |
| --------- | ------------------- | ---------- |
| Frontend  | `localhost:3000`    | Vercel     |
| Backend   | `localhost:8000`    | Render     |
| Supabase  | shared dev project  | dedicated project |

CI runs lint/typecheck/build (frontend) and pytest (backend) on every push/PR.
Schema behavior is covered separately by the embedded-Postgres tests in
`supabase/tests/` (`npm test`), which apply every migration in filename order —
no live database required.
