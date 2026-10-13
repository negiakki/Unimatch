# UniMatch --- Design Inspiration & Visual Direction

## Purpose

This document defines the **visual and interaction direction** for
UniMatch V1.

It is a design-inspiration document, not a rigid implementation
specification.

Use it together with [PRD.md](PRD.md):

-   [PRD.md](PRD.md) defines what UniMatch must do.
-   [DESIGN.md](DESIGN.md) defines how UniMatch should feel and look.

The references and principles below are intended to guide design
decisions, not to be copied literally.

------------------------------------------------------------------------

# 1. Product Feeling

UniMatch should feel like a **premium consumer social product for
university students**.

The first impression should be:

> **"This feels like a real product."**

Not:

> "This looks like a student project."

And definitely not:

> "This is an AI-generated SaaS dashboard."

### Core visual keywords

-   youthful
-   energetic
-   social
-   immersive
-   polished
-   playful
-   premium
-   confident
-   modern
-   expressive
-   human
-   memorable

The design should have enough personality that someone can recognize
UniMatch without seeing the logo.

------------------------------------------------------------------------

# 2. Core Product Idea

The visual language should reinforce the product's central idea:

> **Find your people for whatever you're doing.**

UniMatch is opportunity-first rather than person-first.

The visual hierarchy should therefore generally be:

``` text
What are you doing?
        ↓
Opportunity / Event
        ↓
Who is going?
        ↓
Find your people
        ↓
Match
        ↓
Talk
```

Do not make the application feel like a generic stream of dating
profiles.

The opportunity/event should have a strong visual identity and provide
the context for the people being discovered.

------------------------------------------------------------------------

# 3. Overall Aesthetic

Think **consumer social product + event discovery + modern editorial
design**, rather than SaaS.

The interface can combine:

-   strong photography
-   expressive typography
-   large visual surfaces
-   interesting composition
-   controlled gradients
-   subtle texture
-   confident whitespace
-   motion
-   responsive interactions

The result should feel rich without becoming noisy.

### Premium does NOT mean:

-   everything has a huge border radius
-   everything is glass
-   everything has a gradient
-   everything floats
-   everything animates
-   every section is a card
-   every action has an emoji

Use restraint.

A premium interface should know when to be quiet.

------------------------------------------------------------------------

# 4. Inspiration Philosophy

When using references, ask:

> **What specific design decision am I taking inspiration from?**

Examples:

-   typography hierarchy
-   image treatment
-   navigation behavior
-   card composition
-   swipe physics
-   transition style
-   color relationships
-   spacing
-   interaction feedback
-   editorial composition
-   mobile gestures

Do not copy a reference application's branding, layout, illustrations,
or identity.

UniMatch should develop its own visual identity.

------------------------------------------------------------------------

# 5. Landing / Home

The landing experience should immediately communicate:

> **Find your people for whatever you're doing.**

Avoid a giant generic SaaS hero with:

-   oversized heading
-   three feature cards
-   meaningless gradient background
-   "AI-powered..." marketing copy

Instead, make the user feel like they are entering an active
social/event ecosystem.

Possible visual hierarchy:

``` text
Brand / navigation

Find your people
for whatever you're doing.

[visual category navigation]

Sports     Events     Entertainment
Travel     Social

Upcoming / popular opportunities

[large visual opportunity cards]

More opportunities
```

The exact layout can change based on the design exploration.

------------------------------------------------------------------------

# 6. Categories

Categories should feel like **worlds**, not database filters.

Initial categories:

-   Sports
-   Events
-   Entertainment
-   Social
-   Travel

Each category can have its own visual treatment while sharing the same
underlying design system.

For example:

### Sports

Energetic, kinetic, bold imagery.

### Events

Festive, expressive, atmospheric.

### Entertainment

Cinematic, editorial, media-oriented.

### Travel

Photography-led, spacious, destination-oriented.

### Social

Warm, relaxed, casual.

These should be variations of one UniMatch identity, not five completely
different applications.

------------------------------------------------------------------------

# 7. Opportunity / Event Cards

Opportunity cards are one of the most important components in V1.

They should feel more like **event discovery** than database records.

An opportunity card should be visually driven.

Possible information hierarchy:

``` text
[IMAGE]

Dandiya Night
Events · Dandiya

Friday · 8:00 PM
University Ground

Find your Dandiya partner →
```

Avoid stuffing every piece of metadata into the card.

Use visual hierarchy:

1.  image
2.  title
3.  activity/category
4.  useful contextual information
5.  action

Use imagery aggressively where it improves the experience.

------------------------------------------------------------------------

# 8. Opportunity Detail Page

The opportunity detail page should feel immersive.

Potential structure:

``` text
Large visual / cover

Dandiya Night
Dandiya · Events

Date
Time
Location

Description

Who's looking for a partner?

[ Find a partner ]
```

The primary CTA should be obvious.

The user should understand:

> "If I participate in this opportunity, I can discover people who are
> also looking for someone to do it with."

------------------------------------------------------------------------

# 9. People Discovery

This is the most important interaction in the product.

It should NOT visually resemble a generic CRUD table or directory.

The person should feel like the user is exploring potential partners
**for a specific activity**.

Always preserve context.

Example:

``` text
Dandiya Night
Find your partner

[ profile card ]

Name
Department · Year
Interests
Short bio

[Pass]        [Interested]
```

The opportunity context should remain visible without becoming
repetitive.

------------------------------------------------------------------------

# 10. Profile Cards

Profile cards should prioritize:

1.  photo
2.  name
3.  useful academic context
4.  interests
5.  short personal information
6.  opportunity relevance

Avoid overwhelming cards with every database field.

The card should feel human.

Use photography, typography, spacing and composition rather than
excessive badges.

------------------------------------------------------------------------

# 11. Swipe Interaction

Swipe interaction should feel physical.

Desired behavior:

-   card follows pointer/finger naturally
-   slight rotation while dragging
-   velocity affects movement
-   clear visual feedback for actions
-   card exits naturally
-   next card appears smoothly
-   touch behavior feels excellent on mobile

Avoid cartoonish physics.

The interaction should feel:

> responsive + tactile + controlled

not:

> gimmicky + chaotic

Buttons can still exist for accessibility and users who don't want to
swipe.

------------------------------------------------------------------------

# 12. Partner Preference

The partner preference UI should be neutral and simple.

Possible wording:

> **Who would you like to discover?**

Options:

-   Men
-   Women
-   Everyone

Do not visually or verbally frame this as romantic/dating preference.

It is simply part of partner discovery.

------------------------------------------------------------------------

# 13. Match Experience

A successful match deserves a small moment of delight.

The match interaction can include:

-   subtle scale/opacity transitions
-   profile images moving together
-   opportunity context
-   tasteful celebration
-   clear next action

Example:

``` text
You matched!

Dandiya Night

You and Rahul are both interested
in finding a partner for this event.

[Start chatting]
```

Avoid excessive confetti, giant emoji, or casino-like effects.

The goal is **delightful, not childish**.

------------------------------------------------------------------------

# 14. Messaging

Messaging is temporary and contextual.

The interface should clearly retain the reason for the conversation.

For example:

``` text
Dandiya Night
Matched for this opportunity
```

The conversation should feel lightweight.

The 24-hour nature of the chat can be communicated subtly rather than
constantly reminding the user.

------------------------------------------------------------------------

# 15. Navigation

Navigation should feel native to a modern consumer application.

Potential V1 structure:

-   Discover
-   Explore
-   Matches
-   Profile

Keep navigation simple.

On mobile, use a bottom navigation pattern if it produces the best
experience.

On desktop, a more spacious navigation/header can be used.

Do not force desktop SaaS sidebar navigation onto the public consumer
experience.

------------------------------------------------------------------------

# 16. Typography

Typography should have personality.

Priorities:

-   strong display typography for major headings
-   highly readable body text
-   clear information hierarchy
-   careful line lengths
-   strong numerical/date styling where useful

Avoid using too many fonts.

A strong primary typeface plus a complementary display treatment is
preferable to a collection of unrelated fonts.

Typography should carry some of the visual identity instead of relying
entirely on cards and colors.

------------------------------------------------------------------------

# 17. Color

Do not lock the application into one giant gradient.

Instead, create a controlled design-token system.

Possible structure:

``` text
Base:
- background
- foreground
- muted
- surface
- border

Brand:
- primary
- primary-foreground

Category:
- sports
- events
- entertainment
- social
- travel

Semantic:
- success
- warning
- error
- info
```

Category colors should be used intentionally.

They should help establish context without turning every page into a
rainbow.

------------------------------------------------------------------------

# 18. Imagery

Imagery is important to UniMatch.

Prefer:

-   authentic-feeling photography
-   strong crops
-   large images
-   destination/event photography
-   people actually participating in activities

Avoid:

-   generic corporate stock photography
-   obvious AI-generated people
-   random illustrations
-   meaningless decorative images

When real event imagery is unavailable, use visually coherent
placeholders rather than unrelated stock photos.

------------------------------------------------------------------------

# 19. Motion System

Motion should have a consistent language.

Define reusable:

-   durations
-   easing curves
-   entrance patterns
-   exit patterns
-   hover/tap behavior
-   page transitions
-   modal transitions
-   bottom-sheet transitions
-   card movement

Motion should generally communicate:

-   where something came from
-   where something is going
-   what changed
-   what the user interacted with

Do not animate elements merely because animation is possible.

------------------------------------------------------------------------

# 20. Motion Examples

### Page transition

Subtle fade + movement rather than hard replacement.

### Opportunity card entrance

Staggered, restrained entrance.

### Swipe

Physical drag with rotation and directional feedback.

### Match

Small but memorable celebration.

### Bottom sheet

Spring-like entrance with appropriate damping.

### Buttons

Subtle press/hover response.

### Navigation

Smooth active-state transition.

------------------------------------------------------------------------

# 21. Reduced Motion

Respect:

``` text
prefers-reduced-motion
```

When reduced motion is enabled:

-   remove large transforms
-   minimize transitions
-   disable decorative animation
-   preserve functional feedback
-   maintain usability

------------------------------------------------------------------------

# 22. Responsive Design

Design mobile-first.

UniMatch will likely be used primarily on phones.

Important:

-   touch targets should be comfortable
-   swipe gestures should feel natural
-   bottom sheets should work well
-   cards should use screen width intelligently
-   text should remain readable
-   images should maintain strong crops
-   navigation should remain easy to reach
-   avoid desktop layouts simply compressed onto mobile

Desktop should feel like a deliberate responsive layout, not an enlarged
mobile screen.

------------------------------------------------------------------------

# 23. Loading States

Loading states should feel intentional.

Use:

-   skeletons
-   progressive image loading
-   subtle transitions

Avoid blank screens and giant spinners wherever possible.

------------------------------------------------------------------------

# 24. Empty States

Empty states should explain what happened and what the user can do next.

Examples:

### No opportunities

> Nothing happening here yet.

### No people found

> We couldn't find a partner matching your preferences right now.

Possible CTA:

> Explore other opportunities

### No matches

> Your next match could be at the next event.

Keep empty states concise and human.

------------------------------------------------------------------------

# 25. Error States

Errors should be:

-   understandable
-   actionable
-   calm
-   non-technical

Do not expose raw API errors to users.

------------------------------------------------------------------------

# 26. Suspended Account

A suspended user should receive a clear but restrained account state.

Example:

> **Your account is temporarily unavailable**
>
> Your account has been suspended from participating in UniMatch.
>
> Available until: \[date\]
>
> \[Log out\]

If the suspension is indefinite, communicate that clearly.

Do not expose internal moderation details.

------------------------------------------------------------------------

# 27. What UniMatch Should NOT Look Like

Avoid these patterns unless there is a very strong reason:

### Generic SaaS dashboard

``` text
Sidebar
Stats cards
Table
Filter dropdown
Huge rounded container
```

This is appropriate for admin, not the public product.

### AI-generated UI

Avoid:

-   excessive purple/blue gradients
-   glass everywhere
-   floating blobs
-   generic AI illustrations
-   glowing borders
-   meaningless decorative particles
-   excessive pill components

### Dating clone

Avoid:

-   romantic copy
-   heart-everywhere UI
-   dating-specific onboarding
-   relationship intent
-   "find love" messaging
-   boyfriend/girlfriend language
-   dating profile presentation

### Over-animated UI

Avoid:

-   constant floating
-   excessive parallax
-   huge spring animations
-   animation on every scroll
-   distracting background effects

------------------------------------------------------------------------

# 28. Design Principle

The most important principle:

> **Context first, people second.**

The user should understand what they are doing before they start
browsing people.

The experience should feel like:

``` text
"I'm going to Dandiya."
        ↓
"I need a partner."
        ↓
"Who else is looking?"
        ↓
"That person seems compatible."
        ↓
"Let's connect."
```

Not:

``` text
"Here are 50 random profiles."
        ↓
"Maybe I'll find something to do."
```

------------------------------------------------------------------------

# 29. Working With This Document

This is a direction, not a build sheet. When a visual change is on the table:

1.  Inspect the existing component system first; extend it rather than
    adding a parallel one.
2.  Reuse primitives that are already good, and replace weak components
    instead of duplicating them.
3.  New colors, spacing, and motion values belong in the shared design
    tokens, not scattered into pages.
4.  Keep category theming **data-driven** — a new category should get its
    personality from configuration, not new components.
5.  Keep the public UI mobile-first.
6.  Avoid unnecessary new dependencies; prefer what the project already
    uses.
7.  Accessibility, keyboard interaction, touch interaction, and
    reduced-motion behavior must survive any visual change.

Do not create five separate designs for five categories.

Create **one UniMatch design system with contextual category
personalities**.

------------------------------------------------------------------------

# 30. Final Design Test

Before considering the frontend complete, ask:

### Product test

Can a new user understand within a few seconds:

> What is UniMatch?

### Context test

Can the user always tell:

> What opportunity am I finding people for?

### Human test

Do profile cards feel like people rather than database records?

### Interaction test

Does swiping feel satisfying and natural?

### Visual test

Does the product look like a real consumer product rather than a student
project?

### Differentiation test

If the dating terminology disappeared, would this still obviously feel
like something different from a dating app?

### Restraint test

Would removing an animation, gradient, shadow, or decorative element
make the interface better?

If yes, remove it.

------------------------------------------------------------------------

# 31. North Star

Everything should support this feeling:

> **"Whatever I'm doing, I can find someone to do it with."**

UniMatch should feel like the place where university activities become
social.

The product should be **visual, contextual, human, fast, and fun**.


---

# 32. Major Visual Reference — Design Bomb Festival

**Reference:** https://www.designbomb.it/

The Design Bomb Festival website is a **major visual reference for the UniMatch redesign**.

Do not copy the website, branding, assets, exact layouts, or artwork. Instead, borrow the underlying design principles that make it feel like a designed digital experience rather than a conventional website.

The live site currently uses a strong editorial/event identity, oversized typography, repeated/marquee-like content, image-led sections, interactive elements, motion, and a deliberately art-directed composition. It also uses animated/Lottie content and video in places.

## What I specifically like

### 1. Editorial rather than SaaS

The site feels like an **editorial/event experience**, not a collection of application screens.

UniMatch should borrow this principle.

Instead of:

```text
CARD
CARD
CARD
CARD
```

everywhere, allow layouts to breathe.

Use:

- large type
- strong visual hierarchy
- asymmetric composition where appropriate
- large image areas
- intentional whitespace
- sections that feel art-directed
- typography as a visual element

The UI should feel **composed**, not assembled from a component library.

---

### 2. Oversized typography

Large display type should be a major part of the UniMatch identity.

The main message:

> Find your people for whatever you're doing.

should be capable of becoming a visual object.

Possible treatment:

```text
FIND YOUR
PEOPLE
```

or

```text
Find your people
for whatever you're doing.
```

with unusually large typography, controlled line breaks, and responsive scaling.

Do not make the heading enormous just for spectacle.

The typography must remain readable and should work compositionally across desktop and mobile.

---

### 3. Repetition and marquee language

The Design Bomb site uses repeated content/marquee-like treatment extensively.

UniMatch can borrow this idea selectively.

Potential uses:

```text
SPORTS — EVENTS — TRAVEL — MOVIES — GAMING — SOCIAL — SPORTS — EVENTS...
```

or:

```text
FIND YOUR PEOPLE  ·  FIND YOUR PEOPLE  ·  FIND YOUR PEOPLE
```

or category/activity strips.

Use this as a **brand/motion device**, not as the primary navigation.

It should be subtle enough that it never interferes with usability.

---

### 4. Motion as part of the identity

The reference site makes motion part of the experience rather than treating animation as decoration. It contains animated/Lottie content and video elements.

UniMatch should similarly treat motion as a design language.

Important:

> Motion should communicate the character of UniMatch.

Possible UniMatch motion vocabulary:

- slow editorial entrances
- typography reveals
- horizontal marquee movement
- image clipping/revealing
- smooth section transitions
- subtle cursor/hover responses
- tactile card movement
- physical swipe interactions
- spring-based bottom sheets
- contextual match transitions

Do not add random floating animations just because the page feels empty.

---

### 5. Full-bleed visual moments

Not every section needs to live inside a centered max-width container.

Use occasional:

- full-width imagery
- edge-to-edge category sections
- large opportunity photography
- full-bleed color fields
- oversized typography extending toward the viewport edges

This can make the product feel more like a **digital experience**.

However, functional content such as forms, messaging and dense settings should remain highly usable.

---

### 6. Strong section transitions

Sections should feel like they have relationships.

Instead of:

```text
Hero
↓
white background
↓
cards
↓
white background
↓
footer
```

consider transitions such as:

```text
Editorial hero
      ↓
moving category strip
      ↓
large opportunity imagery
      ↓
people discovery
      ↓
match experience
```

The transition itself can communicate continuity.

---

### 7. Visual rhythm

One of the most useful lessons from this reference is **rhythm**.

Do not make every section visually identical.

Alternate between:

- large / small
- dense / spacious
- image / typography
- static / animated
- light / dark where appropriate
- horizontal / vertical composition

This prevents the application from feeling like an infinite feed of identical cards.

---

# 33. Applying the Design Bomb Direction to UniMatch

The Design Bomb reference should influence UniMatch primarily at the **brand and experience layer**.

It should NOT turn UniMatch into a festival website.

UniMatch still needs to be a usable product.

### The balance

```text
Design Bomb inspiration
        +
UniMatch product UX
        =
Art-directed consumer product
```

Not:

```text
Design Bomb clone
```

---

# 34. UniMatch Home — Art Direction

The home screen should have a stronger visual opening than a standard app dashboard.

Possible concept:

```text
┌──────────────────────────────────────┐
│ UniMatch                    Profile  │
│                                      │
│ FIND YOUR                            │
│ PEOPLE                               │
│                                      │
│ for whatever                         │
│ you're doing.                        │
│                                      │
│     SPORTS   EVENTS   TRAVEL →       │
│                                      │
│ ───────────────────────────────────  │
│                                      │
│ WHAT'S HAPPENING                     │
│                                      │
│ [large opportunity]                  │
│                                      │
└──────────────────────────────────────┘
```

The exact composition should be explored rather than copied literally.

The important principle is:

> **The home page should feel like entering UniMatch, not opening a dashboard.**

---

# 35. Category Transitions

Categories can have their own visual personalities.

When moving from:

```text
All
→ Sports
```

or:

```text
Events
→ Dandiya
```

the transition can change:

- accent color
- background treatment
- imagery
- typography treatment
- motion
- decorative elements

But the core UI remains recognizable as UniMatch.

Think:

> **same brand, different atmosphere.**

---

# 36. Opportunity Pages as Editorial Stories

An opportunity should not always be a plain detail form.

For important opportunities, the page can feel like a mini editorial/event page:

```text
[large image]

DANDIYA NIGHT

University Ground
Friday · 8 PM

[ Find your partner ]

────────────────

About the event

────────────────

People looking for partners
```

The event image and typography can establish the mood before the user reaches the matching interface.

This is especially useful for visually rich events.

---

# 37. People Discovery — Keep Product UX Strong

The editorial aesthetic should become more restrained once the user enters the actual matching interaction.

The people-discovery screen should prioritize:

1. profile image
2. opportunity context
3. person information
4. swipe interaction
5. clear actions

Do NOT sacrifice usability to maintain an experimental visual style.

The experience can still use:

- strong typography
- animated transitions
- large imagery
- interesting backgrounds
- contextual accent colors

but the card interaction must remain immediately understandable.

---

# 38. A "Living" UniMatch Interface

The website should feel slightly alive.

Possible subtle ambient behaviors:

- marquee category labels
- image movement on hover
- slow background texture movement
- typography reveal
- responsive image crops
- contextual transitions
- small cursor/touch interactions
- activity indicators
- animated status changes

These should be **low-frequency and intentional**.

The interface should never feel like a screensaver.

---

# 39. Cursor / Pointer Interactions

On desktop, subtle pointer interactions may be used where appropriate.

Examples:

- image follows cursor slightly
- opportunity image responds to hover
- cursor changes over draggable/swipeable areas
- text/image reveal interaction
- subtle magnetic button behavior

These should never interfere with normal clicking.

Do not build a custom cursor unless it genuinely improves the experience.

---

# 40. Texture and Graphic Language

The Design Bomb reference demonstrates that graphic design can carry as much personality as UI components.

UniMatch can experiment with:

- subtle grain/noise
- thin lines
- oversized numerals
- typographic labels
- editorial dividers
- cropped text
- small metadata labels
- repeated words
- directional arrows
- simple geometric motifs

Keep the graphic language restrained and consistent.

Do not turn every page into a poster.

---

# 41. Color Direction

The Design Bomb reference should **not** force UniMatch into its exact color palette.

Instead, take inspiration from its confidence in visual contrast and art direction.

UniMatch should explore a palette with:

- strong neutral foundation
- one recognizable brand accent
- contextual category accents
- occasional high-contrast sections

A strong monochrome foundation with controlled color moments may be more distinctive than a constant rainbow gradient.

Color should establish hierarchy and mood.

---

# 42. Typography + Motion Combination

A particularly important direction:

> **Typography itself can move.**

Examples:

- large heading reveals
- text clipping
- words sliding into position
- marquee text
- category names changing during transitions
- numbers/date information animating subtly

This can give UniMatch a premium identity without requiring heavy 3D graphics.

---

# 43. What NOT to Replicate from the Reference

Do not blindly reproduce:

- exact layout
- exact typography
- exact colors
- exact animations
- exact navigation
- exact artwork
- exact marquee implementation
- exact image compositions
- festival-specific visual motifs
- branding
- logos
- content

Also do not add complicated interactions merely because the reference has them.

Every interaction must pass the UniMatch usability test:

> Does this make finding people for an activity clearer, faster, or more enjoyable?

If not, don't build it.

---

# 44. UniMatch Design Target

The desired result is:

> **A product with the visual confidence of a contemporary creative studio website, but the usability of a polished consumer social application.**

The reference should push the team toward:

- stronger art direction
- better typography
- more expressive layouts
- richer imagery
- purposeful motion
- stronger transitions
- less generic component stacking

while UniMatch's actual product flows remain simple.
