# UniMatch — Database

> Status: **NOT YET DESIGNED.** This document intentionally contains no schema.
> Do not create tables until the data model is designed and reviewed.

Known constraints that will shape the design:

- PostgreSQL via Supabase; migrations will live in `supabase/migrations/`
  and be applied with the Supabase CLI.
- Auth identities come from Supabase Auth and will be linked to student
  profiles one-to-one.
- A verification record per student submission with statuses such as
  `PENDING`, `VERIFIED`, `REJECTED`; manual admin decision is authoritative.
- Dating features (profiles, media, likes/passes, matches, messages) must be
  gated on verified status at both API and database policy layers.
- Student ID documents live in a private Storage bucket; the database stores
  references only.
- Row Level Security is expected on all user-readable tables.

Concrete tables, columns, indexes, RLS policies and migration tooling decisions
will be documented here before implementation.
