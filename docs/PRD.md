# UniMatch — Product Requirements Document

> Status: v1 requirements are known; interaction-level detail is **TBD** where marked.

## Product

UniMatch is a mobile-first dating web application exclusively for university
students. The product experience should be comparable to Tinder/Bumble for core
dating functionality, but every user must be a verified university student
before accessing any dating feature.

## Core user journey

```
Sign up → create profile → submit student ID → verification
        → discover profiles → like/pass → mutual match → chat
```

## Verification (v1)

- Student ID verification is the **only** verification method.
- No university email verification, SMS OTP, paid identity APIs, or third-party KYC.
- Flow: upload student ID → status `PENDING` → admin reviews → `APPROVED` / `REJECTED`.
- Manual admin review is authoritative.
- Users cannot access discovery, likes, matching, or messaging unless their
  verification status is `VERIFIED`.
- Uploaded ID documents must never be publicly accessible.

## Visual direction

Clean, modern, premium dating-app interface:

- Light/neutral backgrounds, dark typography, white cards
- Subtle gray borders, rounded cards, minimal shadows
- Restrained coral/red accent
- Large profile photography, compact interest chips
- Mobile-first layouts, bottom navigation where appropriate
- Smooth, polished interactions

Explicitly avoided: purple gradients, AI-themed visuals, glowing effects,
generic SaaS dashboard aesthetics, excessive glassmorphism.

## Platform

- Frontend: Next.js App Router + TypeScript + Tailwind (Vercel)
- Backend: FastAPI/Python (Render) — shared by a future React Native app
- Data: Supabase Postgres, Storage, Realtime, Auth

## Out of scope for this task

User profiles, photos, student ID upload, verification workflow, admin
dashboard, discovery, swipes, likes/passes, matches, messaging, notifications,
recommendations, AI features, payments. See [ROADMAP.md](ROADMAP.md).
