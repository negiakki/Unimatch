# UniMatch — Product Requirements Document

> Status: **Authoritative product specification for v1.** Interaction-level
> detail is **TBD** where marked. UniMatch is an 18+ service.

## Product

UniMatch is a mobile-first dating web application exclusively for university
students. The core experience is intentionally familiar to Tinder/Bumble users:
card-based discovery, like/pass, mutual matching, and chat.

The differentiators are:

1. **University restriction** — every user must be a verified university
   student before accessing any dating feature.
2. **18+ only** — no minor can create or use a dating profile.

UniMatch is not a social network. No campus events, feeds, or unrelated
social features. No AI dating assistants, AI-generated profiles, or other
speculative functionality in v1.

## Core user journey

```
Sign up (age 18+ gate) → create profile → submit student ID → manual review
        → VERIFIED → discover profiles → like/pass → mutual match → chat
```

## Eligibility & age policy

- UniMatch is an **18+ only** service.
- Users must provide a date of birth at signup; the platform must verify
  server-side that the user is at least 18 years old **before** a dating
  profile can be created or used.
- Age must be computed from date of birth and kept current over time; it may
  never be self-declared as a free-text field for eligibility purposes.
- Users under 18 are hard-blocked from signup/onboarding. There is no
  junior/minor mode and no support for minors in v1.

## Verification (v1)

- Student ID verification is the **only** verification method.
  Explicitly excluded: university email verification, email OTP, SMS OTP,
  paid KYC services, third-party identity verification services.
- Flow: upload student ID → status `PENDING` → manual admin review →
  `VERIFIED` / `REJECTED`.
- Verification states are exactly: `PENDING`, `VERIFIED`, `REJECTED`.
  (`VERIFIED` — not "approved" — is the success state everywhere.)
- **Manual admin review is authoritative.** Automated checks (OCR, heuristics)
  may eventually *assist* the reviewer, but automation is never the final
  authority for verification. No automated decisioning exists in v1.
- A user cannot access **discovery, likes, passes, matching, or messaging**
  until their verification status is `VERIFIED`.
- Rejected users see their rejection reason and may resubmit.
- Uploaded student ID documents are private: they are stored in private
  storage, never publicly accessible, and viewable only by authorized
  reviewers.

## Manual verification review workflow

The system supports an internal verification review workflow (single trusted
admin/reviewer in v1, designed so additional moderators/admins can be added
later). A reviewer can:

- view pending verifications;
- securely view the submitted student ID;
- approve → status becomes `VERIFIED`;
- reject → status becomes `REJECTED`, with a required rejection reason;
- see relevant verification metadata (submission time, user, document);
- have every decision recorded in an audit trail (reviewer identity,
  timestamp, decision, reason).

Review tooling is internal/admin-facing only and is not exposed to regular
users.

## Functional requirements

### Profiles

Users create/edit a dating profile containing:

**Required:** first name · date of birth/age · university · course · academic
year · gender · gender/dating preferences · bio · interests · profile photos.

**Optional:** height · hometown · relationship intent · profile prompts ·
social links.

Constraints:

- Onboarding must stay short; collect only what is listed above.
- Date of birth is validated against the 18+ rule on every save.
- University must be one of the supported universities (catalog), matched
  against the submitted student ID during review.
- Profile visibility rules: full profile visible to eligible/verified viewers
  and to matches; submission content (student ID) is never part of the
  profile.

### Photos

- Multiple profile photos per user: **minimum 1, maximum 6** (final minimum
  for unlocking the feed is confirmed during implementation).
- One photo is the **primary photo** (first in ordering).
- Ordering is explicit and user-controlled; primary = lowest position.
- Users can upload, delete, and reorder photos; upload places new photos at
  the end of the order, delete promotes remaining photos, reorder swaps
  positions.
- Visibility: any signed-in viewer who is legitimately allowed to view that
  profile (per discovery/match rules). Not public internet access.
- Ownership: only the photo owner can mutate (upload/delete/reorder) their
  own photos.
- Storage: private bucket with authorized delivery; student IDs never mix
  with profile photo storage.

### Discovery

Verified users receive a feed of eligible candidate profiles. A candidate is
**never shown** if the candidate is:

- the current user;
- unverified;
- blocked by the current user, or blocking the current user;
- already passed, liked, matched, or unmatched by either side (i.e., anyone
  whose outcome was already decided under product rules);
- outside the current user's configured preferences.

Preferences supported in v1:

- age range (bounded below by 18+, defaults TBD);
- gender/dating preference, applied two-sided where feasible.

Notes:

- Candidates span all verified universities in v1; location/geolocation-based
  discovery is out of scope for v1.
- Ranking is **deterministic and explainable** (e.g., recent activity/profile
  completeness based). No complex AI recommendation system in v1.

### Actions

- Two actions: `LIKE` and `PASS`.
- Acting on an already-decided candidate is rejected by the API.
- **Super Like: deferred** — not in v1.
- **Undo/Rewind: deferred** — not in v1. Whether a pass can later be reversed
  is a product decision tracked in Open questions.
- No premium monetization, boosts, or paid features exist.

### Matching

- A match occurs when two eligible users mutually like each other.
- Match creation is deduplicated: a pair can have at most one active match.
- Matches are visible only to the two participants.
- **Unmatch:** either participant can unmatch. Unmatching hides the
  conversation and its messages from both participants immediately. Existing
  messages are retained server-side per data-retention/safety policy
  (retention window TBD) but become inaccessible to both users.
- In v1, unmatched pairs do **not** rematch through normal discovery.

### Messaging

- Only mutually matched, non-blocked users can message each other.
- Conversations are 1:1, implicitly created by a match.
- Messages: text-first (v1); timestamps server-assigned; ordering stable per
  conversation.
- Read state: conversations track read/unread per participant (unread counts
  for the UI).
- Typing state: ephemeral typing indicators delivered via Supabase Realtime;
  typing state is not durable application data.
- Message ownership & access control: senders can modify/hide only their own
  messages; participants can read only conversations they belong to. All
  enforced server-side.
- Realtime transport is Supabase Realtime (messages, read receipts,
  typing/presence); REST provides history and fallback sending.

### Safety

Minimum required behavior for v1 (no large moderation system):

- **Block** another user. Blocking affects discovery (neither user appears in
  the other's feed) and messaging (conversation inaccessible while blocked).
  Blocking is reversible via unblock.
- **Report** another user, optionally referencing specific content
  (profile/message/photo). Reports include reporter identity, target, reason
  category, and free-text detail; report contents are admin-only.
- **Unmatch** as described under Matching.
- Reports and blocks are reviewed by the same single-admin workflow as
  verification in v1.

## Visual direction

Mobile-first, clean, minimal, premium, photography-focused:

- Light/neutral backgrounds, dark typography, white cards
- Subtle gray borders, rounded cards, minimal shadows
- Restrained coral/red accent
- Large profile photography, compact interest chips
- Mobile-first layouts, bottom navigation where appropriate
- Smooth, polished interactions

The existing visual reference is inspiration for the visual language, **not**
to be copied pixel-for-pixel.

Explicitly avoided: purple gradients, AI-themed visuals, glowing effects,
generic SaaS dashboard aesthetics, excessive glassmorphism.

## Platform

- Frontend: Next.js App Router + TypeScript + Tailwind (Vercel)
- Backend: FastAPI/Python (Render) — shared by a future React Native app
- Data: Supabase Postgres, Storage, Realtime, Auth

See [ARCHITECTURE.md](ARCHITECTURE.md) for the responsibility boundary
between these components.

## Out of scope for v1

Email/SMS verification, third-party KYC, Super Like, undo/rewind, payments or
any monetization, AI features, campus events/social feeds, geolocation
discovery, group chats, moderation dashboards beyond the minimal review
workflow, push notifications (in-app notification records only).

## Open questions (product decisions)

1. Can a pass be reversed later, or is a pass final until account deletion?
   (v1 assumes final.)
2. Exact default age-range preference and whether candidates outside a user's
   range can ever be surfaced.
3. Minimum photo count required to unlock discovery (PRD assumes 1).
4. Cross-university discovery allowed by default? (PRD assumes yes.)
5. Retention window for conversation content after unmatch or account
   deletion.
6. Notification channels after in-app records (push/email) — post-v1.
