# UniMatch — Architecture

> Status: foundation established; detailed module design **TBD** as features land.

## Overview

Three independent concerns, deployed separately:

```
Browser / (future) React Native
        │  HTTPS + Supabase JS (auth session)
        ▼
Next.js web app (Vercel)          FastAPI backend (Render)
  UI, routing                       domain logic, business rules
  Supabase browser/server clients   │
                                    ▼
                              Supabase (managed)
                              Postgres · Storage · Realtime · Auth
```

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

Future feature modules (e.g. `api/routes/profiles.py`) plug into `router.py`;
cross-cutting needs go through `deps.py`. No ORM by design — Supabase client
libraries handle data access once integrated.

## Supabase

Postgres (schema TBD), Storage buckets with private ACLs for ID documents,
Realtime for chat later. Credentials come from environment variables only;
the anon key reaches the browser, the service-role key must stay server-side.

## Environments & deployment

| Component | Local               | Production |
| --------- | ------------------- | ---------- |
| Frontend  | `localhost:3000`    | Vercel     |
| Backend   | `localhost:8000`    | Render     |
| Supabase  | shared dev project  | dedicated project |

CI runs lint/typecheck/build (frontend) and pytest (backend) on every push/PR.
