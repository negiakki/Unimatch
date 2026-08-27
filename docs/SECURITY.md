# UniMatch — Security

## Non-negotiables

- **Student ID documents are the most sensitive asset.** They must live in a
  private Storage bucket, never be served by public URL, and only be
  accessible to authorized reviewers (mechanism TBD).
- Database access is deny-by-default via Row Level Security; policies are part
  of every migration.
- The Supabase `service_role` key is server-side only (FastAPI environment);
  it must never reach the browser or mobile client.
- Secrets never enter git: `.env*` files are ignored; only `.env.example`
  templates are committed.

## Current foundation

- CORS restricted to an explicit origin allow-list (`CORS_ORIGINS`).
- Uniform error envelope that never leaks stack traces; unexpected exceptions
  log server-side and return a generic message.
- No PII is stored yet — the health endpoint is the only surface.

## To be designed with future features

- Admin authorization model and audit trail for verification decisions.
- Rate limiting / abuse controls for uploads, swipes, and messaging.
- Signed-URL TTL policy for any private media viewing.
- Account deletion and data-retention rules.
- Session refresh middleware pattern for Next.js + Supabase Auth.
