# Long-Term Identity & Scale Architecture

_Design thinking only — nothing in this document is implemented. Written in
response to the user asking Opus to think through what this app's
architecture should look like if it eventually serves thousands of users or
becomes an acquirable product, as distinct from `docs/school-scale-plan.md`
(a ~60-student school, already built)._

_2026-08-27_

## The question, answered directly

Yes — **individual, durable accounts that join classrooms** is exactly the
right shape, not something else. Sharpened into a concrete model below. And
it's worth naming plainly: this is the *same* architectural fix as "how do a
kid's rewards follow them to next year's class," just asked at a bigger
scale. Solve it once, generally, rather than patching the small case and
hitting the same wall again at 1,000 users.

## The actual flaw, named precisely

Today, a "profile" — a student's stars, avatars, streak, test history —
**has no existence independent of the household it was created in.** A
household was always meant to be a permanent container (a family doesn't
change households), so this was never a problem until "household" started
also meaning "this year's class" — a container that's *supposed* to be
temporary. Three unrelated concepts are currently fused into one Firestore
document tree:

1. **A person** — should be permanent, spans classes/grades/schools/years.
2. **A membership** — this person is enrolled in this class, this term.
   Should be temporary and freely re-creatable.
3. **An organization** — a school or district that owns classes and has real
   administrators. Doesn't exist as a concept at all today.

Every symptom raised so far — reward portability across school years,
"thousands of users," "acquirable," and "see my scores over my whole life" —
is downstream of these three being one thing instead of three.

## Target data model

```
organizations/{orgId}                      — a school or district (doesn't exist today)
  members/{uid}: { role: "admin"|"teacher" }
  classes/{classId}                        — roughly today's "household," minus student data
    enrollments/{studentId}: { grade, joinedDate, active }

students/{studentId}                       — NEW top-level collection: the durable person
  { name, avatar prefs, stars, lifetimeStars, unlocks[], currentStreak,
    bestStreak, equippedAvatar, equippedTheme }
  progress/{weekId}                        — moved here from under household/profile
  activity/{date}                          — moved here from under household/profile
  recentTests[]

guardians/{uid}                            — a real parent account (NEW)
  linkedStudents: [studentId, ...]         — can span multiple schools, e.g. siblings
```

`studentId` is generated once, at that student's very first profile creation,
and never regenerated — it is the one thing in this whole model that must
never be tied to a class, a code, or a school year. Everything else (which
class you're in, which organization you belong to, which catalog feeds your
current week) is a pointer *at* a studentId, not a fork of it.

**A student moving to next year's class stops being a data-copy problem.**
It's just: create a new `enrollments/{studentId}` record under the new class,
pointing at the *same* studentId. No "Carry Forward" copy operation needed —
the fix from the previous conversation was the right instinct, taken to its
natural conclusion instead of stopping at a manual yearly ritual.

## "See my scores over my whole life," "legacy avatars" — closer than it looks

`progress/{weekId}` and `activity/{date}` are *already* the right shape for
lifetime history — they're per-student, dated, and additive. The only thing
wrong today is which node they're nested under (a class, which is meant to
be thrown away every year) instead of `students/{studentId}` (which isn't).
Move the parent, and "show me every week I've ever practiced, going back to
first grade" is a query the data already supports, not a new feature to
design.

"Legacy avatars" is two things worth separating:
- **Keeping avatars you already unlocked, forever** — already true today
  (`unlocks` is permanent, the catalog is additive, nothing gets deleted)
  and stays true under this model with zero extra work.
- **Showing *when* you earned something** ("one of the first 100 kids to get
  the Angel Knight," a founding-cohort flex) — not built today, and genuinely
  cheap to add once profiles are durable: stamp each unlock with a date/season
  when it's earned instead of just an id in an array.

## Login at scale — the actual answer to "simple to log in, easy to recover"

Don't design a cleverer code. At real scale, the industry-standard answer to
"how does a kid log into a school app with zero friction and no forgettable
password" is **SSO through the school's own Google Workspace for Education or
Microsoft 365 Education account** — the account already signed into the
Chromebook or iPad in front of them on a 1:1 device. One click, nothing typed,
nothing to lose. "Recovery" stops being this app's problem at all — it
becomes the school's own IT account-reset process, which already exists and
already isn't ours to build. Firebase Auth supports both providers directly;
this is a real, well-trodden integration, not a research project.

This doesn't obsolete the code-based system just built — it becomes the
**small-school/family tier**, still fully supported, sitting alongside SSO as
just another way an Enrollment gets created. Nothing here has to be thrown
away when this gets built.

**One mechanism, two different "who authenticates" roles — this matters, not
just a technicality.** Firebase Auth's Google Sign-In doesn't distinguish a
personal Gmail account from a school Workspace for Education account; both
are just "signed in with Google," same provider, same integration code. So a
single implementation genuinely covers a family setting up their own account
today and a school with its own Google (or Microsoft 365) domain later — but
*who* is the thing signing in should differ by context, deliberately:

- **School context**: the *student* signs in directly with their own
  school-issued account — the whole point of school SSO, and it's allowed
  for young kids specifically because the *school* has consent coverage for
  handing out those accounts (the standard K-12 exception schools already
  rely on), not because Google generally permits kids to hold accounts.
- **Family/one-off context**: a young kid generally shouldn't have a
  standalone Google account outside that school umbrella — a normal account
  requires being 13+, with a supervised "Family Link" account as the only
  under-13 path. The right design here is the **Guardian** signs in with
  their own Google account (no age issue), and kids keep using the
  lightweight in-app profile picker underneath that one authenticated
  parent — same shape as today's household model, just with a real account
  as the front door instead of a shared code, rather than trying to give a
  7-year-old their own login.

The Student/Guardian split already sketched above handles both without
contradiction: a Guardian account links to one or more Student records (the
family case); a school-SSO'd Student authenticates as themself directly (the
school case). Also worth being precise that "Google" doesn't cover Microsoft
365 Education (common in US K-12 too) — same idea, a separate Firebase Auth
provider to wire up, not automatically included by building Google first.

For schools without managed student accounts (common in younger grades or
smaller private schools), a picture/click-grid login (tap your 3 avatars in
order, no typing) is the usual fallback in products aimed at pre-readers —
worth keeping in mind, not designing yet.

## Phased path — so nothing here demands a rewrite tomorrow

The user's framing was right: the database doesn't need upgrading today, the
*shape* does. Firestore itself scales to millions of documents; what doesn't
scale is "anyone holding a shared code has full access to everything under
it." That's a data-model and trust-model problem, not a capacity problem —
which is good news, because it means this can be fixed in place, on the
current free tier, before there's any real infrastructure spend to justify.

- **Phase A — split Student from Class (recommend doing this one now).**
  Introduce `students/{studentId}`, move stars/unlocks/streak/progress/
  activity/recentTests there, and turn today's `households/{code}/profiles/{id}`
  into a thin enrollment pointer. Still Firestore, still no backend server,
  still free-tier. This is a real migration — every read/write path
  currently keyed on "profile lives inside this household" needs updating —
  but it's scoped, mechanical, and it directly is the fix the reward-
  portability question already needs. The honest reason to do this sooner
  rather than later: Micah, Robert, and Roman already have real history under
  the old shape, and that gets harder to migrate the longer it accumulates,
  not easier.
- **Phase B — real auth (SSO), when shared codes stop being acceptable.**
  Triggered by actual growth, not a date. Binds an authenticated `uid` to an
  existing `studentId` — if Phase A is done, this is an added binding, not a
  data migration.
- **Phase C — real organizations, roles, and Cloud Functions.** Needed once
  there's more than one school, and once "who can do what" has to be
  enforced by Firestore rules checking a real `request.auth.uid`'s role,
  not by who happens to know a secret. This is also where a bulk
  roster/CSV importer driven by a real backend function (rather than a
  client pasting text) starts to make sense at real volume.
- **Phase D — the "acquirable" checklist.** Worth naming, not designing:
  **Clever/ClassLink integration** (the actual thing most US K-12 districts
  require before buying anything — bigger sales lever than any UI polish),
  formal data processing agreements (beyond a Privacy Policy page — this is
  a business/legal deliverable, not code), audit logging, and admin billing.

## What this means for the work already shipped

None of it is wasted. `docs/school-scale-plan.md`'s "class = a shared-code
group" is this model's Class concept, informally — it just also currently
carries Student data that Phase A would relocate. The bulk roster importer,
the Class Info/QR screen, and the findable/searchable profile grid all still
apply unchanged under Phase A and later — they're about *how you build a
class roster*, which stays true regardless of what a Student record looks
like underneath it.

## Recommendation

Build Phase A now, specifically because it's the same fix the reward-
portability question already surfaced, and because the real data that exists
today only gets more expensive to migrate the longer it sits in the current
shape. Treat Phases B-D as real, but not yet — triggered by actual growth,
not built speculatively ahead of it. Say the word and I'll turn Phase A into
an implementation plan the same way the school-scale work was done — this
document is the "what and why," not yet the "how, file by file."
