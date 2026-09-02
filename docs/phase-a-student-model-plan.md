# Phase A Implementation Plan — Split Student from Class

_Written by Opus 5, acting as architect. Implements Phase A of
`docs/long-term-architecture.md`. This touches the shape of REAL, LIVE data
(household `REDACTED-HOUSEHOLD-CODE`: Micah, Robert, Roman, two Candice parent profiles) —
read the safety rules below before writing a single line, they are not
optional. Implementing agent: mark checkboxes `[x]` only after verifying in a
real browser, and fill in Implementation Notes at the bottom as you go, same
discipline as `docs/school-scale-plan.md`._

_2026-08-27_

> **STATUS: LIVE AND VERIFIED (2026-08-27).** The user applied
> `docs/firestore.rules` in the Firebase console. The architect re-tested
> the full feature against real production Firestore (throwaway households
> only, never `REDACTED-HOUSEHOLD-CODE`/`REDACTED-CATALOG-CODE`) after that: `students/{id}` is reachable,
> `list` is correctly denied on it, a legacy-shape profile migrates itself
> correctly on load (777 stars, streak, unlocks, equipped avatar all
> present, nothing blanked), a real purchase correctly persists to the new
> student doc, the original enrollment doc is still byte-for-byte untouched
> afterward, and — the scenario this whole plan exists for — a second,
> unrelated household seeded with nothing but a bare `{grade, role}` pointer
> correctly displayed that same student's full stars/avatar carried over
> from the shared record. Parent PIN flow and School Overview also verified
> unaffected. Zero console errors throughout. A real bug in the migration
> fallback logic was found during implementation and fixed by the architect
> before any of this — see "Architect follow-up" in Implementation Notes.

## The one rule that makes this safe: additive only, never mutate or delete

**Never call `.update()` or `.set()` (without `merge:true` producing a
superset) on an existing `households/{code}/profiles/{id}` document to
remove fields from it, and never delete anything.** The migration works
entirely by *adding* a new `students/{id}` document and changing what the
app reads/writes *going forward*. The old profile doc keeps its legacy
fields (`stars`, `unlocks`, etc.) sitting on it forever, unread, harmless —
exactly the same "orphaned data we can't clean up and don't need to"
tolerance already established in `docs/HANDOFF.md` for throwaway test
households. This is deliberate: a destructive migration step that goes wrong
against real data (Micah/Robert/Roman's actual stars) is a real harm; a
little stale duplicate data sitting unread in Firestore forever is not.

**Never connect this app to household `REDACTED-HOUSEHOLD-CODE` or catalog `REDACTED-CATALOG-CODE` while
building or testing this.** All testing uses fresh throwaway households,
per the existing established practice in this repo. The migration logic
only needs to be *correct*, not run by hand against real data — see "How
existing real data actually migrates" below.

## What changes, conceptually

Today, `households/{code}/profiles/{id}` is one document holding everything
about a student: name, avatar, grade, stars, streaks, unlocks, test history.
That's wrong for the same reason discussed at length in
`docs/long-term-architecture.md`: it means a student's *rewards* are owned by
whatever class they happen to be in right now, so they can't survive moving
to a new class next year without an explicit copy step.

The fix: split that one document into two, joined by sharing the same
document ID (no separate foreign-key field needed):

- **`students/{id}`** (NEW top-level collection) — the durable identity:
  `name, avatar, stars, lifetimeStars, currentStreak, bestStreak,
  lastActiveDate, recentTests, unlocks, equippedAvatar, equippedTheme`.
  Never recreated once it exists. This is what should move with a student to
  a new class next year.
- **`households/{code}/profiles/{id}`** (existing collection, now THIN for
  student-role entries) — just `{ grade, role: "" }`. Everything
  class/term-specific. Thrown away or superseded freely; the `id` is what
  ties it back to the durable student.

**Parent-role profiles are completely unchanged** — same shape, same
document, no split. They have no reward/history data to decouple; there is
nothing to fix for them, and touching them would be pure churn. Every place
below that says "student profile" or "role !== parent" is explicitly
excluding parent profiles from any of this.

**`progress/{weekId}` and `activity/{date}` subcollections are explicitly
OUT OF SCOPE for this pass** and stay exactly where they are today, nested
under the household profile. This is a deliberate scope decision, not an
oversight: the user's actual ask was reward portability (stars, avatars,
streak), which this plan fully solves; moving practice-history subcollections
is a separate, larger, lower-urgency migration (N reads + N writes per
student just to relocate data), and practice history is naturally
week/catalog-scoped rather than identity-scoped — there's no expectation that
"my grade 3 spelling accuracy" needs to visibly follow into a grade 4 class
studying entirely different words. If the user wants this moved too later,
that's a follow-up plan, not this one.

## The design choice that keeps this from touching 2,900 lines of app.js

`js/app.js` has dozens of call sites reading `state.profile.stars`,
`.unlocks`, `.equippedAvatar`, etc. **None of them should need to change.**
Keep the in-memory/local shape of a profile object exactly as it is today —
same fields, same flat object. Only `js/sync.js`'s functions that talk to
Firestore need to know the data now lives in two documents; they merge on
read and split on write, so everything upstream of them sees the same shape
it always has.

**Local storage (`ws_profiles` in `localStorage`) does not change at all.**
It stays one flat array with the full shape, exactly as today. The
household/student split only matters for the Firestore representation —
locally, on one device, there's no "this class ends and the data must
survive it" lifecycle problem to solve. Local-only mode (no household
connected) is entirely unaffected by anything in this plan; every function
below is guarded the same way existing sync functions already are
(`if (!db || !(await ready)) return`).

## `js/sync.js` — exact changes

- [x] Add `studentRef(studentId)`: `db.collection("students").doc(studentId)`
      (mirrors the existing `profileRef` pattern exactly).
- [x] Add a migration helper, something like:
  ```js
  const migratedStudentIds = new Set(); // per-session, avoid redundant writes
  async function migrateStudentIfNeeded(id, enrollmentData) {
    const sRef = studentRef(id);
    if (migratedStudentIds.has(id)) {
      const cached = await sRef.get().catch(() => null);
      return cached && cached.exists ? cached.data() : {};
    }
    const sSnap = await sRef.get().catch(() => null);
    if (sSnap && sSnap.exists) { migratedStudentIds.add(id); return sSnap.data(); }
    // Legacy shape: this profile predates the students/{id} split
    // (2026-08-27) and still carries its reward fields directly on the
    // enrollment doc. Copy them into a new student doc once. This is the
    // ONLY write this function performs, and it only ever CREATES a new
    // students/{id} doc — it never touches the existing enrollment doc.
    const migrated = {
      name: enrollmentData.name || "", avatar: enrollmentData.avatar || "",
      stars: enrollmentData.stars || 0, currentStreak: enrollmentData.currentStreak || 0,
      bestStreak: enrollmentData.bestStreak || 0, lastActiveDate: enrollmentData.lastActiveDate || "",
      recentTests: enrollmentData.recentTests || [], unlocks: enrollmentData.unlocks || [],
      equippedAvatar: enrollmentData.equippedAvatar || "", equippedTheme: enrollmentData.equippedTheme || "",
      lifetimeStars: enrollmentData.lifetimeStars || 0,
    };
    await sRef.set(migrated).catch(() => {});
    migratedStudentIds.add(id);
    return migrated;
  }
  ```
  This is how existing real data migrates — no manual script, no console
  surgery. The first time any device loads a household after this ships,
  every student profile in it gets a `students/{id}` doc created
  automatically from whatever reward data was already sitting on its
  (untouched) enrollment doc. Idempotent — safe to run every time, becomes a
  no-op once the student doc exists.
- [x] Rewrite `pushProfile(profile)` to branch on role:
  ```js
  async function pushProfile(profile) {
    const ref = profileRef(profile.id);
    if (!ref || !(await ready)) return;
    if (profile.role === "parent") {
      ref.set({ name: profile.name || "", role: "parent", pin: profile.pin || "" }, { merge: true })
        .catch(warnWriteFailed("profile " + profile.id));
      return;
    }
    ref.set({ grade: profile.grade || "", role: "" }, { merge: true })
      .catch(warnWriteFailed("enrollment " + profile.id));
    const sRef = studentRef(profile.id);
    sRef.set({
      name: profile.name || "", avatar: profile.avatar || "", stars: profile.stars || 0,
      currentStreak: profile.currentStreak || 0, bestStreak: profile.bestStreak || 0,
      lastActiveDate: profile.lastActiveDate || "", recentTests: profile.recentTests || [],
      unlocks: profile.unlocks || [], equippedAvatar: profile.equippedAvatar || "",
      equippedTheme: profile.equippedTheme || "", lifetimeStars: profile.lifetimeStars || 0,
    }, { merge: true }).catch(warnWriteFailed("student " + profile.id));
  }
  ```
  Note this only ever writes the THIN shape to the enrollment doc — it never
  strips the legacy fields already sitting there from before this shipped
  (can't, with `merge:true` — merge only adds/overwrites named fields, it
  doesn't remove unnamed ones — which is exactly the additive-only property
  we want here, not a limitation to work around).
- [x] Rewrite `watchProfiles(onChange)` to merge. Enrollment snapshot stays
      the live listener (unchanged trigger); for each doc, parent-role
      profiles pass through as today, student-role profiles get merged with
      a `migrateStudentIfNeeded()`-backed read:
  ```js
  function watchProfiles(onChange) {
    if (profilesUnsub) { profilesUnsub(); profilesUnsub = null; }
    const col = profilesRef();
    if (!col) return;
    profilesUnsub = col.onSnapshot({ includeMetadataChanges: true }, async (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      const merged = await Promise.all(snap.docs.map(async (d) => {
        const e = d.data();
        if (e.role === "parent") {
          return { id: d.id, name: e.name, role: "parent", pin: e.pin || "" };
        }
        const s = await migrateStudentIfNeeded(d.id, e);
        return {
          id: d.id, grade: e.grade || "", role: "",
          name: s.name || "", avatar: s.avatar || "", stars: s.stars || 0,
          currentStreak: s.currentStreak || 0, bestStreak: s.bestStreak || 0,
          lastActiveDate: s.lastActiveDate || "", recentTests: s.recentTests || [],
          unlocks: s.unlocks || [], equippedAvatar: s.equippedAvatar || "",
          equippedTheme: s.equippedTheme || "", lifetimeStars: s.lifetimeStars || 0,
        };
      }));
      onChange(merged);
    }, () => {});
  }
  ```
  Callers of `watchProfiles` in `app.js` (`watchProfilesList()`) receive the
  exact same flat shape as before — verify this call site needs ZERO changes.
- [x] Rewrite `watchProfile(profileId, onChange)` (singular — the currently
      active profile's live-update listener) to watch `studentRef(profileId)`
      instead of `profileRef(profileId)`. Checked against
      `applyRemoteProfileUpdate()` in `app.js`: every field it reads
      (`stars`, `currentStreak`, `bestStreak`, `lastActiveDate`,
      `recentTests`, `unlocks`, `equippedAvatar`, `equippedTheme`,
      `lifetimeStars`) is a student-doc field under this split — none are
      enrollment fields — so this is a one-line re-point, `app.js` needs no
      changes here at all. Grade changes don't need live cross-device push;
      that's an accepted, unchanged limitation (grade already wasn't
      live-watched before this plan either — check that assumption before
      relying on it).
- [x] Update `fetchHouseholdProfiles(code)` (used by School Overview) to
      merge the same way as `watchProfiles`, using `migrateStudentIfNeeded`
      too — School Overview's "practiced this week" calc reads
      `lastActiveDate`, which now lives on the student doc.
- [x] `progressRef`/`activityRef`/`pushProgress`/`fetchProgress`/
      `pushActivity`/`fetchActivityRange` — **unchanged**, still nested
      under `profileRef(profileId)`, per the explicit scope decision above.
      (Confirmed by inspection: byte-for-byte identical to before this plan.)

## `js/app.js` — exact changes (should be small)

- [x] Verify (don't just assume) that `createStudentProfile()`,
      `selectProfile()`, `persistProfile()`, `getProfiles()`, `saveProfiles()`,
      `applyRemoteProfileUpdate()`, and every render function touching
      `state.profile` need **zero changes** — they all go through
      `Sync.pushProfile`/`Sync.watchProfile`/`Sync.watchProfiles`, which now
      handle the split internally and hand back the same shape as before.
      If you find a call site that needs to change, that's a sign the merge
      functions above aren't producing a fully-compatible shape — fix the
      merge, don't patch around it in `app.js`.
- [x] `Sync.fetchHouseholdCatalogCode`, `Sync.saveShopConfig` etc. —
      unchanged, `shopConfig`/`catalogCode` correctly stay household-scoped
      (a store policy set per class, not something that should follow one
      student — this was already right).

## Security rules — keep `docs/firestore.rules` consistent (not applied yet, but shouldn't drift)

- [x] Add a `match /students/{studentId} { allow get, list, create, update:
      if signedIn(); allow delete: if false; }` block to
      `docs/firestore.rules`, matching the posture of every other collection
      in that file. This file isn't applied to the live project yet (still a
      pending user action item per earlier security review), but it must not
      silently miss the new collection — if it's ever applied without this
      block, `students/{id}` would be unreachable by default-deny, breaking
      this feature retroactively.

## How existing real data actually migrates

No manual step, no console script, no touching household `REDACTED-HOUSEHOLD-CODE` directly.
The very next time any real device opens the real app after this ships,
`watchProfiles`/`watchProfile`/`fetchHouseholdProfiles` runs
`migrateStudentIfNeeded()` against Micah, Robert, and Roman's existing
profile docs, and each gets a `students/{id}` doc created from their current
real stars/unlocks/streak/etc. — automatically, once, the first time they're
read. The two Candice parent profiles are untouched (parent-role, no split).
**Do not test this against the real household.** Prove it works with a
throwaway household seeded to look exactly like a pre-migration profile (see
verification steps below), and trust the logic to apply itself correctly to
the real one afterward — that's the whole point of "migrate on read" over a
manual fix.

## Verification (mandatory, in a real browser, against throwaway data only)

- [x] Create a fresh throwaway household. Using the Firebase JS SDK directly
      in the page's own console context (same technique already documented
      in `docs/HANDOFF.md` for past real-data fixes), write a profile doc
      in the OLD/full shape directly — i.e. simulate a pre-migration
      profile: `{ name: "Test Kid", avatar: "🦊", stars: 500,
      lifetimeStars: 500, grade: "5", currentStreak: 3, bestStreak: 7,
      unlocks: ["avatar:fox"], equippedAvatar: "🦊", recentTests: [] }` —
      deliberately with NO corresponding `students/{id}` doc yet.
      Done against throwaway household `ZTSTA1`.
- [x] **VERIFIED against real production Firestore after the user applied the rules (2026-08-27) — see updated status note at the top of this file.**
      Loaded `ZTSTA1` in the app: the student DID load with stars correctly
      showing 500 (not reset to 0), streak 3/7, unlocks intact — confirmed
      both visually (screenshot) and via `ws_profiles` in localStorage. The
      original enrollment doc was confirmed untouched (direct Firestore read
      after the fact: all legacy fields still present). **However, checking
      Firestore directly for the new `students/{id}` doc showed it was
      NEVER created** — every read/write to the `students` collection
      returns `permission-denied` under the project's currently-*deployed*
      security rules (a different, older ruleset than `docs/firestore.rules`,
      which is written but explicitly not-yet-applied — see Implementation
      Notes). The in-browser display looked correct only because
      `migrateStudentIfNeeded`'s create-path returns its computed object
      regardless of whether the persisting `.set()` actually succeeded.
- [x] **VERIFIED against real production Firestore (2026-08-27).** Used `Sync.pushProfile`
      to simulate a star spend (500→450, avatar swap). Confirmed via direct
      Firestore reads: the enrollment doc's legacy fields were untouched
      (still 500/🦊, exactly as the additive-only rule requires) and the
      write to `students/{id}` was attempted — but it also hit the same
      `permission-denied` wall, so the spend was never actually persisted
      anywhere. Reloading the page afterward showed the star count revert to
      500 — the update was silently lost. Root cause is the same live-rules
      gap, not the migration logic; see Implementation Notes.
- [x] **RE-VERIFIED against real production Firestore, post-fix and
      post-rules (2026-08-27).** The `migratedStudentIds` cache bug
      described below was real and is now removed (see "Architect
      follow-up" in Implementation Notes). With the rules applied and the
      fix in place: bought an emoji avatar as the migrated "Legacy Kid"
      (777 → 752 stars), confirmed via direct Firestore read that
      `students/{id}` now shows `stars: 752` and the new unlock — the write
      genuinely persists now, not just in-memory. A reload correctly shows
      752, not a revert to 500/777.
- [x] Add a brand NEW student profile via single-add. Confirmed in the real
      browser + real Firestore: the enrollment doc was created with the
      correctly-thin shape (`{ grade: "", role: "" }` — verified by direct
      read), and the app displayed the new student correctly at creation
      time (name/avatar come from the in-memory object created by
      `createStudentProfile()`, not round-tripped through Firestore first).
      **Bulk roster import not independently re-driven through the browser**
      — per `docs/HANDOFF.md`/`docs/school-scale-plan.md`, its loop calls
      `createStudentProfile()` directly (the same function just verified),
      so it exercises the identical `Sync.pushProfile` code path with no
      additional Sync-layer surface; re-testing it would only re-prove the
      same thing. Judgment call, recorded here per the plan's own
      instructions.
- [x] **RE-VERIFIED against real production Firestore (2026-08-27) — the
      actual mandatory proof this box asks for, now that it's unblocked.**
      Previously only proven via a Node harness (logic-only, described
      below) while the rules gap blocked real Firestore. After the user
      applied `docs/firestore.rules`: created a second, unrelated throwaway
      household, seeded with nothing but a bare `{ grade: "6", role: "" }`
      enrollment doc reusing the SAME student id as "Legacy Kid" from the
      first household (which by this point had 752 stars, an updated
      unlock list, and the octopus equipped from the purchase test above).
      Loading that second household showed Grade 6, 752 stars, and the
      octopus avatar — all pulled from the shared `students/{id}` record,
      none of it present in that household's own (deliberately bare)
      enrollment doc. Confirmed via direct Firestore read that the FIRST
      household's enrollment doc was still untouched throughout. This is
      the actual "a kid's rewards follow them to next year's class"
      scenario, proven against production, not a mock.
- [x] Test School Overview against a throwaway household with a few students.
      Verified in the real browser: watched throwaway household `ZTSTB2`
      (2 students) from the parent dashboard's School Overview screen and
      confirmed it rendered "Test Class B — 2 students · 0 of 2 practiced
      this week" with no individual student name/avatar/score shown
      anywhere (privacy-preserving aggregate intact). The "0 of 2" is
      correct given the test data (no `lastActiveDate` was ever set); the
      merge logic that reads `lastActiveDate` off the student doc was
      additionally verified directly via the Node harness.
- [x] Test a parent profile end-to-end (create, PIN entry, dashboard access)
      — fully verified in the real browser: created "Test Parent" with a
      4-digit PIN via the UI, confirmed the profile doc saved with the
      unchanged `{name, role:"parent", pin}` shape (direct Firestore read),
      entered the PIN, and reached the Parent Dashboard successfully. No
      `students/{id}` write is ever attempted for a parent — confirmed by
      code inspection (`pushProfile` returns immediately in the
      `role === "parent"` branch) and by the Node harness (Scenario 6).
- [x] Clean up all test households/students created during verification —
      localStorage, service worker registrations, and Cache Storage were
      cleared in the browser before finishing. Per the same accepted cost
      already documented in `docs/HANDOFF.md`, the throwaway Firestore
      documents themselves (households `ZTSTA1`/`ZTSTB2`, catalog
      `ZTSTACAT1`, their profile docs, and one parent profile) cannot be
      deleted under current rules and are left as harmless orphaned test
      data — no PII, same tolerance already established for this repo's
      testing practice.

## Implementation notes (fill in as you go)

_Same instruction as `docs/school-scale-plan.md`: record deviations,
judgment calls, and anything deliberately left undone, with reasons._

**`js/sync.js` and `js/app.js` code changes: complete, matching the plan's
given code verbatim** for `studentRef`, `migrateStudentIfNeeded`,
`pushProfile`, `watchProfiles`, `watchProfile`, and `fetchHouseholdProfiles`.
`js/app.js` needed zero changes, exactly as the plan predicted — verified by
inspection (every call site the plan names goes through `Sync.pushProfile`/
`Sync.watchProfile`/`Sync.watchProfiles`/`Sync.fetchHouseholdProfiles`) and
by exercising `createStudentProfile`, `selectProfile`, `persistProfile`,
`applyRemoteProfileUpdate`, and the parent-profile path live in the browser.
`node -e "new Function(...)"` syntax checks pass for both files.

---

### CRITICAL FINDING — the live Firestore project's deployed rules have no
### path for the new `students` collection, and this blocks the whole
### migration from working in production right now.

This is the single most important thing to act on before this ships. Full
account below because it changed what could and couldn't be verified.

**What I found.** Testing in the browser's own console against the real
Firebase project (`spelling-words-671aa`, the same one this app already
uses — testing only ever touched fresh throwaway codes, per the safety
rules), every read AND write to `db.collection("students").doc(...)`
returned `permission-denied`, even from a normal anonymous-authenticated
session — the exact same auth every real user of this app already has. A
control test against a random nonexistent collection name returned the
identical error, while `households`/`catalogs` reads and writes succeeded
normally. Conclusion: the rules **currently live** on the project (a
different, older ruleset than `docs/firestore.rules` in this repo, which
`docs/HANDOFF.md`'s security review already flags as written-but-not-yet-
applied) explicitly allow only the collections the app used before this
plan, with an implicit default-deny for anything else — so a brand-new
top-level collection like `students` is unreachable until the user
manually adds a rule for it via the Firebase console and publishes.

**Why I couldn't fix this myself.** Applying or editing live Firestore
security rules is "modifying system or security settings," which is on my
permanently-prohibited list regardless of instructions or permissions —
so this needed to stay a report, not an action, even though I could see
exactly what rule text would fix it (I added that block to
`docs/firestore.rules` per the plan's own instruction; see below). I also
checked whether a local Firestore Emulator could substitute for this
(so I could still prove the *feature* end-to-end without touching the live
project) — no Java runtime is installed on this machine, and installing a
JDK purely to unblock this test is a large download I have no channel to
get explicit user sign-off for as a non-interactive implementation pass, so
I didn't install one unprompted.

**What this means in practice, right now, if this ships as-is:**
Everything that reads or writes `students/{id}` — which is to say, this
plan's entire reason for existing — silently no-ops under the current live
rules. Concretely:
- `migrateStudentIfNeeded`'s `.set()` never persists. Its *first* call for
  a given id in a session still returns the correct data (it falls back to
  computing the shape from `enrollmentData` regardless of whether the
  persisting write succeeded), so a fresh page load looks completely fine.
- A **second** call for the same id, later in the *same* browser session
  (e.g. triggered by the live `watchProfiles` listener refiring because
  *any* other profile in the household changed — I reproduced this by
  simply adding a second student to the household), takes the "already
  migrated, just re-read" branch. That re-read also fails under the current
  rules, and the function returns `{}` instead of falling back again — which
  blanks the student's stars/name/avatar/streak/unlocks to zero/empty in
  the merged shape `watchProfiles` hands to `app.js`. I reproduced this
  twice, independently (once via a direct `Sync.pushProfile` star-spend
  call, once via adding a second student through the real UI), and
  confirmed via direct Firestore reads both times that the *underlying*
  enrollment doc was completely intact throughout — this is a display/
  session-cache bug, not real data loss, but it is alarming and would look
  exactly like data loss to a parent or kid mid-session.
- Because `watchProfilesList()` in `app.js` calls `saveProfiles(remoteList)`
  on every fire, this blanked shape gets written into `ws_profiles` in
  localStorage — so it also survives a reload, at which point `enterApp()`'s
  synchronous auto-resume path renders the blanked profile immediately, no
  live listener needed to reproduce it.
- Real stars a kid spends after the first touch (I tested this directly)
  are genuinely lost across a reload: `pushProfile`'s write to
  `students/{id}` fails silently, the thin enrollment write never carried
  reward fields to begin with under the new split, so nothing on the server
  reflects the spend, and the next load re-derives from the stale
  pre-spend enrollment snapshot.

None of this is a bug in how I implemented the plan's given functions — I
used them exactly as written, and I proved via a Node harness (below) that
they behave correctly once the collection is actually reachable. It's a
sequencing problem: this code cannot go live before the Firestore rules
that make its target collection reachable are published, and that
publishing step is a pending Firebase-console action item, same category as
the two items `docs/HANDOFF.md` already flags this way (applying
`docs/firestore.rules` generally, and enabling App Check). **Recommendation:
do not deploy this Phase A code to production until `docs/firestore.rules`
(including the `students` block added by this pass) is applied in the
Firebase console** — otherwise every real family using the app during the
gap window will see exactly the star-loss/blanked-profile behavior
described above, which is strictly worse than doing nothing.

**How I verified the actual split/merge logic instead**, given real
Firestore couldn't reach the collection: wrote a throwaway Node.js test
harness (not committed — lived only in this session's scratchpad, deleted
before finishing) that loads the literal, unmodified `js/sync.js` source
via `new Function(...)` against a small in-memory mock implementing exactly
the Firestore API surface that file calls (`collection/doc/get/set(merge)/
onSnapshot/batch`), with permissions equivalent to what
`docs/firestore.rules`'s new `students` block would grant once applied.
16 assertions, all passing, covering: legacy-profile migration on first
read, the enrollment doc staying byte-for-byte additive after a
`pushProfile` write, idempotent re-reads returning the *live* (not stale)
student-doc value once it exists, `watchProfile` (singular) correctly
re-pointing at the student doc, brand-new-student creation producing a
correctly-split pair from the start, parent profiles never touching the
`students` collection at all, `fetchHouseholdProfiles` merging correctly
for School Overview, and — the one the plan explicitly said not to skip —
the full cross-household "simulate next year" scenario: a student's
stars/lifetimeStars/streak/unlocks/recentTests/equippedAvatar all correctly
appearing in a second, unrelated household after reusing the same student
id with nothing but a bare `{ grade: "8", role: "" }` enrollment doc, with
the first household's own doc left untouched. This is strong evidence the
**logic** is correct; it is deliberately not presented as a substitute for
the mandatory real-Firestore proof, which is now blocked on the rules
update above.

---

**Design observation for the architect (not acted on, per instructions not
to redesign the given functions): `migrateStudentIfNeeded`'s cached branch
has no fallback.** The "already migrated" branch assumes that once an id is
in `migratedStudentIds`, the corresponding `students/{id}` doc reliably
exists and is readable, and returns `{}` if a `.get()` on it fails for any
reason. That assumption is safe under normal operation (nothing in this app
ever deletes a student doc), but the failure mode when it's wrong is
silent and severe — it *erases* the displayed profile rather than
degrading back to the enrollment-doc fallback the create-path already
knows how to compute. Flagging for the architect's judgment, not changed
here.

> **Architect follow-up (2026-08-27): fixed.** This was a real bug in the
> code I originally wrote into this plan, not something the implementer
> introduced — the plan's own given snippet had the flaw. Removed
> `migratedStudentIds` entirely: `migrateStudentIfNeeded` now does a fresh
> `.get()` on every call and recomputes from `enrollmentData` every time the
> student doc doesn't exist, rather than trusting session-scoped bookkeeping
> that could be wrong. This makes the function correct even under the
> *current* rules gap — a write that fails every single time now degrades to
> "keeps showing the right data, keeps harmlessly retrying the write" instead
> of "correct once, then blanks." Proved this against the exact reproduced
> scenario (a `students/{id}` write that always throws `permission-denied`,
> called three times for the same id): all three calls returned the full,
> correct data. See `js/sync.js`'s updated comment on `migrateStudentIfNeeded`
> for the in-code version of this reasoning. This does NOT unblock the
> "verify against real Firestore" checkboxes below — that still requires the
> user to apply the rules first — but it means the code sitting in the repo
> right now is safe to leave as-is while that's pending, rather than a live
> hazard.

**Security rules deviation: `students/{studentId}` denies `list`, unlike
the plan's literal given text (which included `list` alongside `get`).**
The plan's snippet was `allow get, list, create, update: if signedIn()`,
but `docs/firestore.rules`'s own stated rationale (in its header comment)
is specifically that top-level collections reached only by an id the
caller already has (`households`, `catalogs`) deny `list` to prevent an
anonymous client from dumping every document in the collection in one
query, while *subcollections* reached by first knowing a parent code
(`profiles`, `weeks`) keep `list` because the app genuinely needs it there.
`students` is a top-level collection exactly like `households`/`catalogs`
— the app only ever reaches a student doc via `.doc(id).get()`/`.set()`
with an id it already has (its own profile's id, or one being migrated),
never a query — so allowing `list` here would let any signed-in anonymous
client enumerate every student's name and stats across every household in
the project, the identical enumeration risk the existing rules file exists
to close for the other two collections. Denied `list` instead, matching
the file's own logic rather than the plan's literal text on this one
sub-point (the plan's instruction to use given code verbatim was scoped to
the three named functions in `sync.js`, not this rules snippet).

**`fetchHouseholdProfiles` merge for School Overview: also uses
`migrateStudentIfNeeded`, same as the plan asked, with one consequence
worth naming.** School Overview reads an *other* household's profiles by
code (a principal watching a class they don't otherwise have access to).
Under the current live-rules gap, calling this against a household with
unmigrated legacy profiles will attempt (and fail) to create `students/{id}`
docs for students the caller has no other relationship to — harmless (the
write silently no-ops, exactly like everywhere else affected by the rules
gap) but worth knowing this code path can trigger migration attempts for
students well outside the household actually connected on this device.

**Bulk roster import not independently re-driven through the browser** —
per `docs/HANDOFF.md`, its loop calls `createStudentProfile()` directly,
the exact function already verified live via single-add; there's no
additional `Sync`-layer code path bulk import touches that single-add
doesn't already exercise identically.

**`progress`/`activity` subcollections: confirmed genuinely untouched.**
Diffed `js/sync.js` before/after — `progressRef`, `activityRef`,
`pushProgress`, `fetchProgress`, `fetchAllProgress`, `watchProgress`,
`pushActivity`, `fetchActivityRange` are byte-for-byte identical, still
nested under `profileRef(profileId)` as the plan's scope decision requires.

**Nothing was deleted or stripped from any real or throwaway document at
any point.** Every write performed during implementation and testing was
either a brand-new `students/{id}` `.set()` (create-only, and in every
observed case it failed harmlessly under the current rules rather than
partially applying) or a `.set(..., {merge:true})` on an enrollment doc —
confirmed directly via Firestore reads after each write that no existing
field was ever removed. Household `REDACTED-HOUSEHOLD-CODE` and catalog `REDACTED-CATALOG-CODE` were never
referenced, connected to, or read at any point in this session.
