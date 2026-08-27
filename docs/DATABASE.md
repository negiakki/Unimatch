# UniMatch — Database

> Status: **Requirements-level only — NOT YET DESIGNED.**
> Do not create tables, migrations, columns, indexes, or RLS policies until the
> dedicated database design task is complete. This document identifies the
> major entities and the requirements they must satisfy.

## Design constraints

- PostgreSQL via Supabase; migrations will live in `supabase/migrations/`
  and be applied with the Supabase CLI.
- Auth identities come from Supabase Auth (`auth.users`) and will be linked
  one-to-one to an application user record.
- Verification states are exactly `PENDING`, `VERIFIED`, `REJECTED`; the
  manual admin decision is authoritative (automation never finalizes status).
- Every gate is enforced at both API and database policy layers:
  - 18+ eligibility derived from date of birth;
  - discovery/likes/passes/matching/messaging require verification status
    `VERIFIED`;
  - unmatch/block must make conversation content inaccessible immediately.
- Student ID documents live in a private Storage bucket; the database stores
  references only, never the documents themselves.
- Row Level Security on all user-readable tables; deny-by-default.
- Verification decisions are recorded in an append-only audit trail
  (reviewer identity, timestamp, decision, reason).
- Blocked/report relationships must not leak identity to the targeted user.

## Major entities

### Identity & profile

1. **Users** — application-level user record linked 1:1 to a Supabase Auth
   identity. Carries account lifecycle state (active/deleted) and rolls up
   verification status. Supporting account/data deletion requires either soft
   delete or anonymization hooks here (final mechanism TBD).
2. **Universities** — catalog of supported universities; referenced by
   profiles and cross-checked against submitted student IDs during review.
3. **Profiles** — the dating profile: first name, date of birth (source of
   age for 18+ enforcement), university reference, course, academic year,
   gender, dating/gender preferences, bio, plus optional fields (height,
   hometown, relationship intent, prompts, social links). One per user.
4. **Interests** + **profile–interest associations** — shared interest
   catalog selected by users; rendered as chips.
5. **Profile photos** — ordered photo records referencing private Storage
   objects; explicit position ordering with lowest = primary; owner-only
   mutation; separate bucket/namespace from student ID documents.

### Verification

6. **Verifications** — one record per student-ID submission: document storage
   reference (never URL exposure), submission timestamp, current state
   (`PENDING` / `VERIFIED` / `REJECTED`), reviewer metadata upon decision,
   rejection reason when rejected. Resubmission after rejection creates new
   submissions while history remains auditable.
7. **Verification audit trail** — append-only record of every review
   decision: reviewer identity, decision, reason, timestamps. Must not be
   editable or deletable by normal flows. Needs a reviewer/admin notion from
   day one (v1: single trusted admin; extensible to more moderators).

### Dating core

8. **Likes** — actor → target action records used both for discovery
   exclusion and mutual-match detection. A pair cannot accumulate conflicting/
   duplicate active likes (uniqueness requirement implied by matching rules;
   exact constraint TBD in design task).
9. **Passes** — actor → target "decline" records excluding targets from the
   feed. v1 treats passes as final (open question in PRD).
10. **Matches** — created when two eligible users mutually like each other;
    unordered participant pair with at-most-one-active-match dedupe;
    visibility limited to participants; tracks unmatched state. Message read
    state may ultimately live on match/conversation participation modeling
    rather than messages themselves (TBD).
11. **Conversations** — message containers for matches (likely 1:1 with an
    active match; final modeling TBD).
12. **Messages** — text messages within conversations: sender (participant),
    server-assigned timestamp/conversation ordering; participants-only
    readability enforced by policy; inaccessible after unmatch/block while
    retained per safety/retention rules. Typing indicators are **not**
    persisted here (ephemeral via Realtime).

### Safety

13. **Blocks** — blocker → blocked pairs; drives discovery exclusion and
    messaging lockout in both directions of effect; reversible on unblock.
14. **Reports** — reporter, reported user, optional content reference
    (message/profile/photo), reason category, free-text detail, processing
    status for the admin workflow. Contents visible only to admins.

### Future-phase

15. **Notifications** — in-app notification records (e.g., match made, new
    message) with per-user read state; delivery channels are post-v1. Stored
    model introduced with the messaging phase; identified now so schema
    evolution stays predictable.

## Cross-cutting requirements

- All eligibility gates (18+, `VERIFIED`) resolvable by both FastAPI and RLS
  policies without N+1 fan-out — denormalization or helper views/functions
  likely needed (design task decides).
- Deletion propagation: removing an account cascades/anonymizes across
  profiles, photos, verifications, likes, passes, matches, conversations,
  messages consistent with retention rules (TBD).
- Storage object references remain valid or clean up atomically with rows.

Concrete tables, columns, indexes, enums-as-checks, RLS policies, and
migration tooling decisions will be documented in the dedicated database
design task before any implementation.
