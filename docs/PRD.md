# UniMatch — Product Requirements Document

> Status: **authoritative product specification.** Anything marked *Planned*
> has no implementation yet; everything else describes the shipped application.
> Interaction-level detail lives in [DESIGN.md](DESIGN.md); endpoint contracts
> live in [API.md](API.md).

## Product

UniMatch is a mobile-first **partner & group discovery platform** for verified
university students.

> **Find your people for whatever you're doing.**

The product is opportunity-first, not person-first. A student does not browse
a stream of strangers hoping for chemistry; they pick something they are
actually doing — a Dandiya night, a badminton tournament, a movie night, a
weekend trip — join it, and then meet the other people joining it.

```
Discover → Category → Opportunity → People → Interested / Apply
         → Match → Temporary chat
```

The opportunity supplies the context, the profile supplies the identity, the
match supplies the connection, the chat supplies a short-lived way to arrange
the thing.

The differentiators are:

1. **Opportunity-first** — every connection happens inside something you are
   both doing. The context is never optional.
2. **University verification** — every user must verify their student status
   before participating in anything.
3. **18+ only** — no minor can hold a profile or participate.

UniMatch is **not** a dating app and must not be presented as one: no romantic
copy, no relationship framing in the interface, no user-authored "looking for
a partner" listings.

## Core user journey

```
Sign up (18+ gate) → create ONE profile → submit student ID → manual review
        → VERIFIED → browse opportunities → join one → discover the people
        in it → interested / pass → mutual match → temporary chat → arrange it
```

## Eligibility & age policy

- UniMatch is an **18+ only** service.
- Users provide a date of birth at signup; the platform verifies server-side
  that the user is at least 18 **before** a profile can be used, and re-checks
  the rule on every profile save.
- Age is always computed from date of birth and kept current; it is never a
  self-declared free-text field for eligibility or display.
- Users under 18 are hard-blocked. There is no junior/minor mode and no
  support for minors.

## Verification

- Student ID verification is the **only** verification method.
  Explicitly excluded: university email verification, email OTP, SMS OTP,
  paid KYC services, third-party identity verification services.
- Flow: upload student ID → status `PENDING` → manual admin review →
  `VERIFIED` / `REJECTED`.
- Verification states are exactly: `PENDING`, `VERIFIED`, `REJECTED`.
  (`VERIFIED` — not "approved" — is the success state everywhere.)
- **Manual admin review is authoritative.** Automated checks (OCR, heuristics)
  may eventually *assist* a reviewer, but automation is never the final
  authority. No automated decisioning exists.
- **A user cannot join opportunities, discover people, express interest, match,
  or message until their verification status is `VERIFIED`.**
- Rejected users see their rejection reason and may resubmit. Only one
  `PENDING` submission exists at a time, and `VERIFIED` is terminal.
- Submitted documents are private: private storage, never publicly accessible,
  viewable only by authorized reviewers through short-lived signed URLs.
  Student ID documents and profile photos live in separate buckets.

## Manual verification review workflow

A single trusted admin/reviewer in v1, structured so more moderators can be
added later without redesign. A reviewer can:

- view pending verifications (metadata only — no document access by default);
- securely view the submitted student ID;
- approve → `VERIFIED`;
- reject → `REJECTED` with a required rejection reason;
- see the student's claimed university, including a free-text institution name
  when the university is not in the catalog;
- rely on every decision being recorded in an append-only audit trail
  (reviewer, decision, timestamp, reason).

Decided submissions are immutable. Review tooling is internal and is never
exposed to regular users.

## Profiles

Every user has **ONE** UniMatch profile. They do not create a profile per
activity, and applying to an opportunity never creates a new profile.

**Required:** first name · date of birth/age · university (catalog entry **or**
a free-text name for an unlisted institution) · course · academic year ·
gender · who you'd like to meet · bio · interests · at least one profile photo.

**Optional:** height · hometown · profile prompts · social links ·
`relationship_intent` (legacy field, see *Legacy dating fields*).

**Motivation ("Why I'm here"):** an optional, controlled selection of up to
three values from `dating`, `making_friends`, `confidence_and_communication`.
The value set is enforced by a database constraint and is unchanged from the
dating era — including `dating`, which stays a valid selection. Motivations
are user self-description; they never appear as dating framing in the
interface.

Constraints:

- Onboarding stays short and collects only what is listed above.
- Date of birth is validated against the 18+ rule on every save.
- University is either a catalog entry or a typed name; the reviewer compares
  the claim against the submitted document.
- Academic year is 1–6.
- Interests: at most 8 in total across the shared catalog and user-created
  custom interests. Custom names are 1–40 characters, unique per profile, and
  may not duplicate a catalog entry.
- Profile visibility: the client-safe person projection (photo, name, academic
  context, interests, bio) is visible to eligible viewers inside an
  opportunity and to matches. Submission content (student ID) is never part of
  a profile.

### Legacy dating fields

`relationship_intent` still exists in the schema and is still returned in the
client-safe person projection because removing it would be a destructive
migration of live data. The interface does not surface it, no new copy refers
to it, and its removal is a tracked follow-up. All *new* product surface is
built opportunity-first.

### Photos

- Multiple photos per profile: **minimum 1, maximum 6**.
- One photo is the **primary photo** (first in ordering).
- Ordering is explicit and user-controlled; primary = lowest position.
- Upload appends to the end of the order; delete promotes the remaining
  photos; reorder takes a full permutation.
- Server-side validation: magic-byte sniffing accepts JPEG/PNG/WebP, a
  declared type that contradicts the bytes is rejected, max 10 MB.
- Visibility: only to viewers legitimately allowed to see that profile (inside
  an opportunity, or as a match). Never public internet access.
- Ownership: only the owner can upload/delete/reorder.
- Storage: private bucket, server-signed URLs, backend-proxied uploads; a
  failed write never leaves an orphaned object behind.

## Opportunity catalog

Categories and activities are **data-driven reference data**, not hard-coded:

```
Categories      Sports · Events · Entertainment · Social · Travel
Activities      Badminton · Dandiya · Movies · Rishikesh · …
```

- Administrators create, rename, reorder, enable/disable categories and
  activities, and move an activity between categories — without schema or
  frontend changes.
- Categories are navigation and visual context; activities are what an
  opportunity is actually about.
- Users never write to the catalog. Only active categories and activities are
  public.

## Opportunities

**Admin-created opportunities are the only opportunities.** Users cannot
publish "I need someone to watch a movie" or "looking for a badminton partner".
An administrator creates *Movie Night*; users discover it and join. This keeps
the platform curated and safe instead of an uncontrolled feed of user requests.

An opportunity carries:

- title, category, (optional) activity, description
- date, start time, end time, location
- cover image, capacity, partner requirement, expiry
- state

States are exactly `DRAFT`, `PUBLISHED`, `PAUSED`, `CANCELLED`, `EXPIRED`,
transitions only through explicit admin actions. **Only `PUBLISHED`
opportunities are public**; pausing or cancelling one removes it from the
public surface immediately. Drafts are never shown to users and non-published
ids are indistinguishable from unknown ones.

Form fields adapt to the selected category rather than forcing one universal
form: sports surface a venue and a tournament frame, travel surfaces a
destination and a date range, and so on.

## Applications (participation)

Joining is the whole bridge between "an opportunity exists" and "I can meet
people through it".

- Apply with the caller's **existing** profile — no new profile, no
  repetitive form.
- Requires `VERIFIED`; the opportunity must be `PUBLISHED`.
- One application per person per opportunity; duplicates are rejected.
- Withdrawing is a status transition (`APPLIED → WITHDRAWN`), never a deletion.
- A student can join many opportunities at once and manages them from
  "my activity".
- Only `APPLIED` participants appear in each other's feeds.

## Contextual discovery

Inside a joined opportunity, a student browses the other people who joined it.

A candidate is **never shown** if they are:

- the current user;
- not `VERIFIED`;
- blocked by the current user, or blocking the current user;
- someone the current user already acted on **in this same opportunity**.

Acted-on-here is scoped to the opportunity on purpose: passing someone through
one event does not remove them from the next one, and two people can connect
independently through several opportunities.

Preferences in v1: **who you'd like to meet** (`men` / `women` / `everyone`),
applied two-sided — both sides' preferences are respected. Wording is neutral
partner discovery, never a dating preference.

Ranking is **deterministic and explainable** (newest profiles first, with a
stable tiebreaker). No AI recommendation system, no random ordering, no
location/geolocation discovery. Cross-university discovery is allowed.

## Actions

- Two actions inside an opportunity: **Interested** and **Pass**.
- Actions are immutable and scoped to the opportunity; acting twice in the
  same context is rejected by the API.
- **Super Like: deferred** — not in v1.
- **Undo/Rewind: deferred** — not in v1.
- "Who is interested in you" does not exist — incoming interest is never
  readable.
- No premium monetization, boosts, or paid features.

## Matching

- A match occurs when two eligible participants both express interest **in the
  same opportunity**.
- **Matches are contextual.** A match remembers why it happened and carries the
  opportunity; the same two people may match again through a different
  opportunity.
- Creation is deduplicated: a pair can have at most one match per opportunity,
  even under concurrent mutual interest.
- Matches are visible only to the two participants.
- **Unmatch:** either participant can unmatch. Unmatching hides the
  conversation and its messages from both participants immediately. Rows are
  retained server-side per the retention policy but become inaccessible to
  both users, so an unmatched pair cannot rematch through normal discovery.

## Messaging

Chats exist to arrange the thing, not to replace it. UniMatch is deliberately
**not** a permanent messaging platform.

- Only mutually matched, non-blocked participants can message each other.
- A conversation IS an active match (the match id doubles as the conversation
  id), and it carries the opportunity the two people matched through.
- Conversations are **temporary**: a conversation with no new message for 24
  hours lapses and becomes inaccessible. Unmatching ends it immediately.
- Messages are text-first, immutable in v1, with server-assigned timestamps and
  stable ordering per conversation.
- Read state: a simple per-participant unread counter for the UI (no per-message
  read receipts).
- Realtime transport, typing indicators, attachments, and push notifications
  are **deferred**; v1 polls the open conversation.
- All access is enforced server-side: participants only, own messages only.

## Safety

Minimum required behavior, no large moderation system:

- **Block** another user. A block is a pure visibility filter: the pair
  disappears from discovery, actions, matches, and messaging in **both**
  directions while it stands, and everything returns on unblock. Blocking is
  reversible and silent for the blocked user.
- **Report** another user, optionally referencing a specific profile, photo, or
  message. Reports carry reporter, target, reason category, and free-text
  detail; a report has no automatic consequence — admin review decides any
  action. Report contents are admin-only and never returned to the reporter.
- **Unmatch** as described under Matching.
- **Account suspension** (admin-only): an indefinite block or a timed
  suspension. While suspended, an account can still read its own data but
  cannot take any action or reach either discovery feed. Lapsed suspensions
  expire automatically.
- Reports and blocks are handled by the same single-admin workflow as
  verification.

## Admin console

A **single** admin application under `/admin` — no separate top-level URLs to
remember. It reuses the same student authentication and the same
`staff_admins` membership check; frontend route hiding is never treated as
security, and a normal user calling an admin API receives an authorization
error.

Areas:

- **Overview** — real platform counts (users, verified, pending verifications,
  opportunities, applications, matches, reports, active suspensions). Nothing
  is fabricated.
- **People & Verification** — the review queue, secure document viewing,
  approve/reject.
- **People** — searchable directory with verification and account status.
- **Safety & Moderation** — reports, user-to-user blocks, suspensions.
- **Opportunities** — create, edit, publish, pause, cancel, expire, delete,
  and see who applied.
- **Catalog** — categories and activities: create, rename, reorder,
  enable/disable, move between categories.
- **Account** — the signed-in staff member and sign-out.

The directory exposes only what moderation needs. No invasive surveillance: no
emails, no auth ids, no date of birth, no document access, no storage paths.

## Visual direction

Mobile-first, contextual, human, and deliberately *not* a generic SaaS
dashboard. The governing principle is **context first, people second**: the user
should always know what they are doing before they start browsing people.

Categories feel like different worlds within one identity, imagery carries the
experience, motion is purposeful and restrained, and reduced-motion
preferences are respected.

The full direction — including the opportunity card, swipe, match, navigation,
typography, color, and imagery guidance — is in [DESIGN.md](DESIGN.md).

## Platform

- Frontend: Next.js App Router + TypeScript + Tailwind (Vercel)
- Backend: FastAPI/Python (Render) — shared by a future React Native app
- Data: Supabase Postgres, Storage, Realtime, Auth

Non-negotiables: the browser never touches privileged data; the service-role
key lives only in the backend; every gate (18+, `VERIFIED`, match membership,
photo ownership, opportunity participation, admin authorization) is enforced
server-side and backed by Row Level Security where practical.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the responsibility boundary and
[SECURITY.md](SECURITY.md) for the security model.

## Out of scope for v1

- **User-created partner/group listings**, including group proposals with
  admin approval — *planned but not built; no schema or API exists.*
- Email/SMS verification, third-party KYC.
- Super Like, undo/rewind.
- Payments or any monetization.
- AI features, recommendation algorithms.
- Campus events/social feeds as a product surface.
- Geolocation discovery, age-range preferences.
- Group chats.
- Moderation beyond the review workflow described above.
- Push notifications, Realtime streaming, attachments.
- "Who is interested in you".

## Open questions (product decisions)

1. Can a pass be reversed later, or is a pass final until account deletion?
   (v1 assumes final.)
2. Exact default age-range preference, and whether candidates outside a user's
   range can ever be surfaced. (v1 has no age range at all.)
3. Should user-created **group** proposals (with vacancies) be added behind an
   admin approval queue, and if so how vacancies behave relative to the
   fixed-capacity opportunities that exist today?
4. Retention window for conversation content after a 24-hour lapse, after an
   unmatch, and after account deletion. (V1 decision: messages are deleted at
   the 24-hour lapse; rows held by an OPEN moderation report are retained as
   evidence but permanently hidden from participants. Unmatched conversations
   stay stored and inaccessible, matching the unmatch/restore behavior.)
5. Notification channels after in-app records (push/email) — post-v1.
6. Removal of the legacy `relationship_intent` field now that the interface
   never surfaces it.
7. Whether `motivations` should keep the `dating` value indefinitely or be
   re-worded — the enum is a data contract, so changing it is a migration.
