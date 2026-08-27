# Scaling Word Study to a School — Architect Plan

_Written by: Opus 5, acting as architect (per user's explicit instruction to plan
first, delegate implementation, review after). Not yet implemented as of
writing. Implementing agent: mark each checkbox `[x]` immediately after you
verify that item works, not just after writing the code for it — verification
means served locally and exercised in a browser, the same standard the rest
of this codebase's history was held to (see `docs/HANDOFF.md`)._

_Last updated: 2026-08-26_

## The ask

The user's wife is the principal of a small K-12 school (~60 students total,
grades 2-12, heaviest concentration in grades 3-8) and wants to offer Word
Study to the school. Requirements as stated: easy enrollment, automatic word
delivery per grade, intuitive to access, easy to recover if a kid loses their
code, gamified, fun. Unlikely all 60 use it, unlikely even those who do use it
simultaneously — so this is about *capacity to scale gracefully*, not
provisioning for 60 concurrent users on day one.

## The one decision everything else follows from

**A "class" is a `households/{code}` document, unchanged.** No new
collection, no new auth model, no per-student passwords. This needs
justifying because it's the load-bearing choice in this whole plan:

The existing trust model is "whoever holds a code has full access to
everything under it" — true today for one family's household and one shared
catalog, and stated as a deliberate, accepted tradeoff throughout
`docs/HANDOFF.md`. At school scale that tradeoff's *blast radius* is the
thing that has to be chosen deliberately, because now the people sharing a
code are no longer all one family:

- **One household for the whole school (60 kids under one code)** — rejected.
  Every kid and every parent who has "the school code" would see every other
  kid's name, grade, avatar, and star count on the shared profile picker,
  before any PIN is even involved (student profiles have no PIN; only
  `role: "parent"` profiles do). That's real information about other
  families' children, exposed to any family with the code. Also renders 60
  tiny cards on one screen, which is a bad picker regardless of privacy.
- **One household per student (60 separate codes)** — rejected. Matches the
  strongest privacy (nobody but that family ever sees that child's data) but
  directly fights the "easy to enroll, easy to recover" requirement: 60
  codes to generate, distribute, and for small children to individually keep
  track of, with no recovery path except "ask whoever set it up" — 60 times
  over instead of once.
- **One household per classroom/section (the school's own existing grouping)
  — adopted.** A class of ~15-25 kids who already sit in the same room,
  already know each other, already have a teacher who can post a "class
  code" on the wall the exact same way a wifi password gets posted. This
  bounds the privacy blast radius to "classmates," which is a normal,
  low-stakes visibility level (they already know who's in their class), turns
  "60 codes to lose" into "however many classes the school actually has to
  lose" (single digits for a 60-student school), and turns code recovery into
  "ask the teacher" instead of "hope a 7-year-old kept a slip of paper."

This is a recommendation to convey to the school, not a technical
requirement the app enforces — nothing stops someone from making one
household per family instead if that fits the school's structure better
(e.g. a multi-grade one-room setup). State the reasoning above when handing
this off; don't just hand over a code-generation button with no guidance.

**Word delivery**: the existing `catalogs/{code}` mechanism already does
everything "automatically provide their words" requires, unmodified.
`computeAutoWeek(weeks, grade)` in `js/app.js` already filters a connected
catalog's weeks by each profile's own `grade` field and picks whichever
week's start date is the most recent one not in the future — a catalog can
already hold every grade 2-12's weekly lists side by side, and
`parseCatalogText()` already accepts multiple `GRADE ... (starts ...)` blocks
in one paste. **The plan is: one shared catalog code for the whole school**
(the existing "soft ownership" model already lets any connected household
add to it — a teacher doesn't need special permission to paste their own
grade's weeks in), every class-household connects to it once, and whoever
owns curriculum (the principal, a lead teacher, each grade's teacher) pastes
their grade's weeks into that one shared catalog. Every enrolled kid in every
class automatically sees their own grade's current week with zero
per-student configuration. This needs a small copy/example update (Phase 2
below), not new logic.

## Capacity check (so nobody worries about a surprise bill)

Firestore Spark (free) plan: 50k reads/day, 20k writes/day project-wide.
Per HANDOFF's own prior estimate, a single catalog-weeks fetch for a 9-week
catalog costs ~9 reads; a practice session's progress/activity autosave is a
handful of writes, batched every 10 answers
(`flushActivity()`/`activity.answers % 10 === 0` in `js/app.js`). Even a
generous estimate — all 60 kids practicing twice a day, ~30 Firestore
operations per session — is ~3,600 ops/day, comfortably inside both daily
caps with wide headroom. **No paid plan is needed for this school's actual
scale.** State this in any user-facing summary; it's a legitimate concern for
a principal and the math is genuinely reassuring.

## Before this goes live with real students — user action items, not code

These need the user/principal's own judgment, not a coding agent's. List
them, don't silently resolve them:

1. **Apply `docs/firestore.rules`** (already written, not yet applied — needs
   Firebase console access) and **enable Firebase App Check** (free on
   Spark). Both were "worth doing" at family scale; at school scale, with
   multiple unrelated families' children's data now in the same project,
   they go from nice-to-have to should-do-before-enrolling-real-kids.
2. **Privacy/consent**: the current Privacy Policy (`#screen-legal` in
   `index.html`) was written for "one family's own kids." A school enrolling
   *other* families' children is a different situation — most schools already
   have a process for approving ed-tech tools (a student data privacy
   agreement, a state-approved software list, etc.). Flag this to the
   principal explicitly; don't draft school-specific legal language
   unprompted, the same judgment call already made once for the contact
   email in this app's Privacy Policy.

Implementing agent: do not attempt either of these — they require Firebase
console access and a human policy decision, respectively. Just leave this
section in the plan so the user sees it.

## Explicit non-goals (carried forward / newly decided — do not build these)

- **No cross-student or cross-class leaderboards/rankings.** `docs/HANDOFF.md`
  already lists leaderboards as an explicit non-goal for the family design;
  at school scale the reason gets stronger, not weaker — showing 25
  classmates each other's relative scores is a real social-pressure and
  fairness concern for other people's children, not this family's own call to
  make unilaterally. Keep gamification *private* (stars, streaks, medals,
  avatars — all already shipped and already fun) rather than comparative.
- **No real per-student accounts, passwords, or email/SMS-based recovery.**
  Would require a paid backend tier and collecting real contact info, which
  directly contradicts the Privacy Policy just written (explicitly no email
  collection) and the app's whole "no backend beyond Firebase, zero PII
  beyond what's typed in" design. The class-code model (above) is the
  answer to "easy to recover," not individual logins.
- **No server-side role enforcement (real teacher vs. student permissions).**
  Documented in the 2026-08-26 security review: everyone under one household
  shares a single anonymous auth session, so Firestore rules structurally
  cannot distinguish "teacher" from "student" — that would need per-person
  auth (Blaze-plan Cloud Functions). Not in scope; the PIN gate stays what it
  already honestly says it is, a child-deterrent, not real security.
- **No new external CDN dependency, no build step.** If a feature below
  (QR codes) needs a small library, vendor one small local file; don't add a
  `<script src="https://...">` tag pointed at a new third party.

---

## Phase 1 — Class setup & findability (MUST HAVE)

This is the phase that directly answers "easy to enroll" and "easy to find
their account if they lose the code." Do this phase first and completely
before touching Phase 2 or 3.

### 1.1 — Bulk class roster import

Today, `js/app.js:775` (`btn-add-profile` handler) adds one student at a
time and immediately calls `selectProfile(p.id)` — fine for a parent adding
one kid, wrong for a teacher adding 20 (it would try to "enter" the app as
each of 20 different kids in sequence). Refactor before extending:

- [x] Extract a `createStudentProfile(name, grade)` helper from the body of
      the `btn-add-profile` handler that does exactly: build the profile
      object (reusing the existing `AVATARS[studentCount % AVATARS.length]`
      rotation logic — recompute `studentCount` fresh each call so a bulk
      loop assigns a nicely varied rotation across all new students, not the
      same avatar 20 times), push it into `getProfiles()`, `saveProfiles()`,
      and `Sync.pushProfile(p)` if `firestoreReady()`. Return the created
      profile. The existing single-add click handler becomes: call the
      helper, clear the inputs, `renderProfiles()`, then `selectProfile(p.id)`
      exactly as before — verify manually that adding one student still
      works identically to today (auto-enters as them).
- [x] Add a new "👥 Add a Class Roster" ghost button on `#screen-profiles`
      near the existing `.new-profile-form` (`index.html` around line 66-70),
      opening a new small screen or inline panel (your call on screen vs.
      inline — a full screen matches the app's existing pattern of one
      concern per screen, e.g. mirror `#screen-catalog-editor`'s
      paste → preview → save shape for UX consistency with a workflow users
      of this app have already learned).
- [x] Paste format: one student per line, `Name` or `Name, Grade`. Support a
      single "default grade" selector (a text input, same styling as
      `#new-profile-grade`) applied to any line that omits a grade — this
      covers the common case of a single-grade classroom roster in one paste.
      Blank lines skipped. Trim whitespace per line.
- [x] Defensive caps, matching the pattern already established in
      `parseCatalogText()` for exactly this reason (2026-08-26 security
      review): cap each name at 60 chars, cap the whole paste at 200 students
      (60-student school, generous headroom, not a real limit in practice).
- [x] Preview step before committing: show "Will add N students" with the
      parsed name/grade list, and an explicit confirm button — do not create
      profiles directly from the textarea without a preview step, matching
      the catalog editor's existing safety pattern (a hostile or malformed
      paste should be visible before it's committed, not just accepted blind).
- [x] On confirm: loop calling `createStudentProfile()` per line (NOT the
      full click-handler — see the refactor above), then a single
      `renderProfiles()` and a toast ("Added 22 students!"). Do NOT call
      `selectProfile()` in this path — stay on the roster/profile screen so
      the teacher can see the class was created, then hand devices to kids.
- [x] Verify: paste a 20-line roster (mix of `Name` and `Name, Grade` lines,
      include one deliberately-too-long name and one blank line), confirm
      preview shows the right count, confirm all profiles appear in the
      grid afterward with correct grades, confirm the long name was
      truncated rather than breaking anything.

### 1.2 — Class Info screen (the code, a QR code, and the invite link, always reachable)

- [x] New screen (or a well-labeled section) showing, big and clear: the
      current household code (reuse the display logic already in
      `js/app.js` around line 701-714, which currently lives inline in
      whatever renders `#household-info` — pull it out into a real screen
      titled something like "🏫 Class Info" rather than the current small
      inline strip, since a teacher needs to *print this and put it on the
      wall*, not glance at a one-line hint).
- [x] Add a QR code encoding `inviteURL("household", code)` (the function
      already exists, `js/app.js:336` — reuse it unchanged). Vendor a small,
      well-known, permissively-licensed pure-JS QR encoder as a single local
      file (e.g. `js/vendor/qrcode.js`) — do NOT fetch one from a CDN. If you
      cannot confidently vendor a correct QR encoder (this needs real
      Reed-Solomon error-correction math, not something to hand-roll
      casually), it is better to skip the QR code entirely and ship a large,
      easy-to-read code + a prominent "Copy Invite Link" button (both already
      trivial with existing helpers) than to ship a QR code that might not
      actually scan correctly. State clearly in your final report which path
      you took and why.
- [x] Keep the existing "Copy" and "🔗 Copy invite link" buttons
      (`js/app.js:707-708`) on this new screen.
- [x] Make this screen reachable from TWO places: (a) immediately after
      `btn-create-household` succeeds (`js/app.js:2809-2825`) — a teacher
      creating a class needs this info at the exact moment they most need it,
      not buried behind navigation; (b) a persistent, ungated entry point on
      `#screen-profiles` (anyone already viewing that screen already has the
      code's full access by definition, so gating this view specifically
      would add friction with no real security benefit).
- [x] Verify: create a fresh household, confirm the Class Info screen shows
      immediately with a correct code and (if built) a QR that actually
      scans to the right URL with a real phone camera or a QR-reading tool —
      don't just assert it renders, actually decode it and confirm the URL
      is right.

### 1.3 — Findable profile grid at class scale

`renderProfiles()` (`js/app.js:670-684`) renders every non-parent profile as
a card with no search and no ordering guarantee beyond creation order. Fine
at family scale (2-4 kids), not at class scale (15-25).

- [x] When the student count exceeds a threshold (suggest 8 — tune if it
      feels off during testing, but don't make it configurable, that's
      needless complexity for a threshold nobody will ever need to change),
      render a live search/filter text input above the grid that filters
      visible cards by case-insensitive name substring, and sort the grid
      alphabetically by name in this case. Below the threshold, render
      exactly as today — zero visual change for the primary existing family
      use case. Verify explicitly that a 3-profile household still looks
      identical to before this change.
- [x] Add a lightweight non-blocking "is this you?" confirmation: when a
      tapped profile is NOT the one already cached as this device's
      `ws_active_profile` (check via the existing `getActiveProfileId()`),
      show a brief interstitial — big avatar, name, "Yes, this is me" /
      "Back" — before actually calling `selectProfile()`. This is explicitly
      a mis-tap guard for a shared cart of classroom devices, not a security
      boundary (there is no secret to protect here, only an accident to
      prevent) — do not add a PIN or any real gate to student profiles, that
      would contradict the whole "kids just tap their name" design and this
      task doesn't ask for it. On a 1:1 device, this never shows at all,
      because after the first login `ws_active_profile` already matches and
      `enterApp()`'s existing auto-resume logic bypasses the picker screen
      entirely before this code would even run — verify that specific
      interaction (first login shows the confirm once, then reloading the
      device goes straight in with no picker, no confirm, exactly as today).
- [x] Verify: a household with 12 students shows the search box and
      alphabetical order; typing a partial name filters correctly; tapping an
      unfamiliar profile shows the confirm step; confirming enters normally;
      "Back" returns to the grid without side effects.

### 1.4 — HANDOFF.md update

- [x] Add a section to `docs/HANDOFF.md` documenting: the class-as-household
      decision and why, the bulk-roster feature, the Class Info screen, and
      the profile-grid scaling behavior — matching this file's existing
      style (concrete, reasons-not-just-facts, cites real line numbers where
      it helps a future reader).

---

## Phase 2 — School-wide word delivery workflow (MUST HAVE, small effort)

Almost entirely already-working infrastructure; this phase is about making
the existing capability obvious and well-documented, not building new logic.

- [x] Update the placeholder/example text in `#screen-catalog-editor`
      (`index.html`, the `#catalog-paste-input` textarea's placeholder and
      the explanatory `<p class="hint">` above it) to show a realistic
      *multi-grade* example — two or three `GRADE N (starts ...)` blocks in
      one paste — so it's visually obvious this already supports "the whole
      school's curriculum in one paste," not just one grade at a time. This
      is a copy-only change; `parseCatalogText()` already handles it.
- [x] Add a short paragraph to `docs/HANDOFF.md` (or a new small doc if that
      reads better — your call) spelling out the recommended school workflow
      in plain language for a principal, not a developer: pick one memorable
      catalog code for the whole school, every class connects to it once
      during setup (via "Manage Word Catalog" → connect with that code),
      whoever manages curriculum updates it centrally and it fans out
      automatically, and if two teachers ever edit the exact same grade's
      exact same week at the exact same time, the more recent save wins
      (existing, already-accepted `mergeWeeks()` behavior — not new, just
      worth stating plainly for a non-developer reader).
- [x] Verify: paste a 3-grade example (grades 3, 5, 7, one week each) into a
      test catalog, confirm all three weeks save and each shows up correctly
      filtered when viewed from a student profile of the matching grade.

---

## Phase 3 — School Overview dashboard (SHOULD HAVE — build after Phase 1+2 are done and verified)

The Parent Dashboard today only ever shows one household's students. A
principal wants a bird's-eye view across every class without visiting each
household's dashboard separately. Design this as **read-only, aggregate-only,
and privacy-preserving by construction** — it must not become a second way to
see individual students across classes, which would reopen exactly the
privacy problem Phase 1's class-per-household decision exists to avoid.

- [x] Store a small local "watchlist" of class codes + friendly labels in
      `localStorage` under a new key (e.g. `ws_school_watchlist`, an array of
      `{code, label}`) — this lives only on whichever device the principal
      uses for this view, no new Firestore collection needed. Add a small
      management UI to add/remove/rename watched codes (paste-a-list-once is
      fine here too, doesn't need to be fancier than a few text rows).
- [x] Add one or two small read-only `Sync` functions (e.g.
      `Sync.fetchHouseholdSummary(code)`) that, given a code, read that
      household's `profiles` subcollection (count, per-profile
      `lastActiveDate`/`currentStreak` already stored on each profile doc —
      no new writes anywhere) and return an aggregate: student count, how
      many practiced in the last 7 days (reuse the same "activity" reads
      pattern `loadStudentDashboardData()` already uses per-student, just
      summed instead of rendered per-student).
- [x] Render one row per watched class: label, student count, "X of Y
      practiced this week." **Do not show individual student names, avatars,
      or scores on this screen** — that's the whole point of keeping this
      aggregate-only. If you find yourself needing a per-student value to
      compute an aggregate, compute it and discard the identity, don't carry
      it into the render.
- [x] Verify: set up two test households with a few students each, add both
      codes to the watchlist, confirm the overview shows correct aggregate
      counts for both, and confirm no student name/avatar/individual score
      appears anywhere on this specific screen.

---

## Phase 4 — Optional school-wide fun (NICE TO HAVE — only if time remains after 1-3 are done and verified; skip without guilt otherwise)

- [ ] A single, non-comparative, whole-school fun number — e.g. a "the whole
      school has practiced N words together!" counter surfaced somewhere
      low-key (not a competing-schools/classes ranking, not tied to any one
      student) — sourced from the same School Overview aggregate reads in
      Phase 3, summed across all watched classes. This adds a collective,
      no-downside gamification touch without reopening the leaderboard
      non-goal above. If Phase 3 wasn't built, skip this entirely rather than
      inventing a new data path just for a nice-to-have.

---

## Implementation notes (fill in as you go)

_Implementing agent: use this section to record any deviation from the plan,
anything you decided differently and why, and anything you deliberately left
undone with a reason. Don't leave this section empty — a plan that was
followed exactly with zero judgment calls along the way would be unusual for
a build this size._

**Phases 1-3: fully implemented and verified in a real browser against the
live Firestore project** (`python -m http.server` from the repo root, Chrome
via automation, real household/catalog codes created and cleaned up
afterward per the existing throwaway-testing convention in HANDOFF.md — those
orphaned test households/catalogs can't be deleted, same accepted cost
already documented there). Phase 4 was deliberately skipped — see below.

**QR code: vendored, not skipped, and independently verified to decode
correctly.** Rather than hand-roll Reed-Solomon or skip the feature, fetched
the well-known kazuhikoarase QR encoder (MIT-licensed, the same reference
implementation bundled as `qrcodejs` in thousands of production projects) as
a single local file, `js/vendor/qrcode.js` — no CDN `<script>` tag, fetched
once via `curl` from its GitHub source and committed as a local vendored
file, exactly the "vendor a local file" path the plan allows. Verified
correctness independently rather than trusting it blind: pulled the exact
boolean module matrix out of a live `QRCode` instance's internal
`QRCodeModel` (`isDark(r,c)`/`getModuleCount()`), rendered it to a PNG with
`pngjs`, and decoded it with `jsQR` — a completely unrelated decoder
implementation — which read back the exact invite URL
(`http://localhost:.../index.html?household=U2NB99`) with zero errors. This
is a stronger check than eyeballing a rendered canvas: it confirms the
actual Reed-Solomon-encoded data, not just that a QR-shaped image appeared.

**Class Info navigation judgment call**: the plan asks for the screen to
appear "immediately after `btn-create-household` succeeds," but that handler
also drops the new code into the join-field password-manager flow (fills
`#join-household-code`, waits for one more "Join" tap so the browser's
save-password heuristic fires on a real form submit — see HANDOFF's
Login/recovery UX section). Navigating straight to a new screen would have
abandoned that field before the save-password prompt could fire. Resolved by
having `openClassInfo()` remember whether it was opened from
`screen-household` and sending "Back" there instead of to the profile
picker in that case — so both flows work: the teacher sees the code/QR
immediately, and the existing password-save tap-through still works
afterward. Verified both paths explicitly (Class Info → Back → household
screen with code still filled in; Class Info → Back from the profiles-screen
entry point → profiles grid).

**School Overview: used `lastActiveDate` instead of per-profile activity
reads.** The plan's own wording said either was acceptable ("count,
per-profile `lastActiveDate`/`currentStreak` already stored on each profile
doc" vs. "reuse the same activity reads pattern... just summed"). Chose
`lastActiveDate` (already on every profile doc) over pulling each student's
7 daily activity docs: it answers "practiced in the last 7 days" exactly as
well, and costs one Firestore read per watched *class* regardless of
roster size instead of one read per *student* — a meaningfully cheaper
default given this whole plan's own emphasis on Spark-plan read budgets at
school scale. Added only one new `Sync` function
(`fetchHouseholdProfiles(code)`), matching the plan's "one or two."

**Phase 3 entry point**: the plan didn't specify where "School Overview"
should be reachable from. Added it to the Parent Dashboard's action bar
(next to Manage Avatars) since it's the app's only existing PIN-gated admin
surface — a principal using this view has already passed that gate. Also
widened `.parent-dash-actions` to `flex-wrap: wrap` since it now holds four
buttons instead of three.

**Phase 4: skipped, with reasoning (not just "ran out of time").** An
accurate whole-school "N words practiced together" counter needs a real
words-answered total, which isn't stored anywhere Phase 3's aggregate read
already touches — profile docs carry `lifetimeStars`, `currentStreak`, etc.,
none of which map 1:1 to "words practiced" (stars come from bonuses, not
literal per-word counts). Computing a real word-attempt total would mean
reading every student's progress subcollection across every watched class —
exactly the more-expensive-than-necessary data path the plan's own words for
this phase say to avoid ("skip entirely rather than inventing a new data
path"). Since Phase 3 *was* built but doesn't expose the data Phase 4 wants
to summarize, skipping was the more honest choice over shipping a number
that looks precise but is actually a proxy (spendable stars, which are
adjustable by design via Manage Avatars pricing, are a particularly bad
stand-in for "words practiced").

**Other minor judgment calls**: (1) the roster/catalog "default grade"
input and the School Overview watchlist textarea reuse existing global
`input[type=text]`/`textarea` styling rather than `.new-profile-form`'s flex
layout, which is tuned for two-field rows and would have squeezed a
single wide field too narrow. (2) `createStudentProfile()` defaults `grade`
to `""` (matching the shape every other profile-creation path already
produces) rather than leaving it `undefined`, consistent with the
`undefined`-field Firestore-write gotcha documented in HANDOFF's known bug
patterns. (3) Reused `.parent-pin-entry`'s existing CSS for the new "is this
you?" confirm box instead of writing new layout CSS, since the visual shape
(centered card, two-button row) is identical.

**Bugs found in the existing codebase, not fixed (out of scope for this
plan)**: none found. The multi-agent security review already logged in
HANDOFF.md appears to have caught what was there; nothing new turned up
while reading `js/app.js`/`js/sync.js` closely enough to extract and reuse
`createStudentProfile`, `computeAutoWeek`, `inviteURL`, `escapeAttr`, and
the catalog editor's paste/preview/save pattern for this work.
