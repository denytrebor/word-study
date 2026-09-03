# Word Study — Handoff Document

_Last updated: 2026-09-02_

A static PWA (no build step, no backend beyond Firebase) built for the user's kids
to self-study their weekly spelling/vocab word lists. Live at
**https://denytrebor.github.io/word-study/**, repo **`denytrebor/word-study`**
(public — required for free-tier GitHub Pages), local working copy at
`C:\Users\rober\OneDrive\Documents\claude\word-study`.

Read this file first for current state. For the full decision history, reasoning,
and every bug found along the way, see the `word-study-app` memory record — this
file is the current-state summary, that one is the incident/decision log.

---

## Architecture

- Vanilla HTML/CSS/JS, no framework, no bundler. `js/app.js` is the whole app
  (state, screens, all 7 study modes, gamification). `js/sync.js` wraps
  Firebase. `js/shop-catalog.js` is static avatar/theme data.
  `js/starter-lists.js` is bundled starter word-list content.
- **Local-first**: everything works offline via `localStorage`. Firebase
  (Firestore + Anonymous Auth, project `spelling-words-671aa`, free Spark plan)
  is optional cross-device sync layered on top — the app runs fine if Firebase
  fails to load.
- **Service worker**: network-first (not cache-first) so deploys show up
  without a stale-cache trap. Bump `CACHE_NAME` in `service-worker.js` on every
  deploy that touches cached assets (convention, not strictly required by the
  network-first strategy, but keeps old caches from lingering).
- **PWA install**: `manifest.webmanifest`, `display: standalone`. Installed via
  Safari "Add to Home Screen" on iPads. `start_url` is a static
  `"./index.html"` — it **cannot** be personalized per kid/household in the
  manifest, which matters if you're ever tempted to bake a household code into
  the install URL (see the UX section below for why that doesn't reliably work
  on iOS anyway).

## Data model (Firestore)

Two **deliberately separate** top-level collections — a catalog code can never
expose a household's private scores, since there's no document path from one to
the other:

- `households/{code}/profiles/{id}` — one profile per kid or parent.
  - `profiles/{id}/progress/{weekId}` — per-(profile, week) stats.
  - `profiles/{id}/activity/{date}` — daily activity/streak tracking.
- `catalogs/{catalogCode}/weeks/{weekId}` — shared word lists, organized by
  grade + week, sharable across households via the catalog code.

Both use short human-typed **codes** as the access control (no real
accounts/passwords) — anyone with a code has full read/write to that
household or catalog. Accepted tradeoff; the data is just word lists and
practice scores.

## Study modes

Look & Say (TTS flashcards, definition-free, every word) · Spelling Practice ·
Vocab Practice, split into two sub-modes reached via a picker screen behind
the same Home tile — Flip & Rate (self-graded reveal) and Match the Meaning
(word shown, pick its definition from up to 4 choices, actually graded) —
**both draw only from words that have a definition**, so a week with no
definitions gets a one-time explanation instead of a session full of
placeholder text; Look & Say deliberately stays definition-free and keeps
every word, which is the clean split between it and Vocab Practice · Test Mode
(one pass, max 2 replays, no feedback until the end) · Speed Quiz
(parent-led swipeable flashcards) · Word Scramble (tile-drag spelling) ·
Smart Review (weakest words across every week practiced — see Usability
features below; the only mode not scoped to a single week).

Spelling Practice and Smart Review both hold a miss on screen until the child
retypes the word correctly once ("Lock It In") before Continue appears — see
"Lock It In retype + Practice Buddy" below. Word Scramble, Flip & Rate, and
Match the Meaning are deliberately excluded from that gate (see that section
for why).

Test Mode's "Vocab Test" and Speed Quiz's "Vocab" kind are **deliberately NOT**
filtered to defined words the way Vocab Practice is — they only ever show the
word and ask for an honest self-rating, never promise a definition, so they
degrade fine on an undefined word. Left alone on purpose, to keep this change
scoped to the mode that actually claimed to show meaning.

## Gamification (fully shipped per `docs/gamification-parent-mode-spec.md`)

Word mastery medals (bronze/silver/gold, derived from stats, never stored) ·
daily streaks + activity tracking · star shop (72 illustrated characters
across a standard and a "chase" tier, 24 emoji avatars, 6 themes), fully
parent-configurable via Manage Avatars (see below) · celebrations
(confetti/chimes, mute toggle, and a Practice Buddy avatar that nods/cheers/
wobbles in the header — see "Lock It In retype + Practice Buddy" below) ·
PIN-gated parent dashboard (read-only, local-storage-first with Firestore
fallback). Explicit non-goals: leaderboards, badges, weekly goals, teacher
dashboard.

## Character avatars (`assets/avatars/`)

72 illustrated characters, sliced with **real per-pixel alpha transparency**
(no background-removal guesswork — see `tools/slice-avatars.py`'s docstring)
from three reference sheets the user supplied 2026-08-26, kept at
`tools/reference-sheets/`. Running `python tools/slice-avatars.py` (needs
pillow/numpy/scipy) regenerates the whole set and is the only way these files
should be produced. WebP at q92, ~2.1 MB total, all precached by the service
worker (`CHARACTER_AVATARS` in `service-worker.js` — keep in sync with
`CHARACTERS` in `js/shop-catalog.js` and the actual files in `assets/avatars/`;
a mismatch fails the whole SW install via `addAll()`).

**Slicing is not a grid crop, and the reason matters.** Characters overflow
their cells constantly (raised swords, wings, hair, feet hanging into the row
below), so a plain crop clips and a padded crop drags in neighbours. The first
version padded each cell and eroded the alpha mask 1px to snap the thread
joining two characters — which fails, because the real joins are ~13px WIDE
but very FAINT (alpha 19-67 against a body's ~250), and eroding hard enough to
break one would delete every thin sword blade on the sheet. A full audit of all
72 sprites on 2026-08-26 found **9 with foreign fragments** (a green sneaker
over a girl's cat ear, purple wingtips in another character's flames) and **0
clipped** — the approach was tuned against clipping and paid for it in bleed.

The current slicer instead labels the **whole sheet** at once, since a
character's own overflow is solidly connected to it while a neighbour's is
solidly connected to *them*: seed on high alpha (excluding the faint bridges),
label globally, give each cell the component that most occupies it, then split
contested soft pixels by nearest seed (a Voronoi via `distance_transform_edt`).
Glow and aura survive (nearest their own character); a neighbour's boot does
not. Two further guards: a character's *detached* own props (music notes, a
soccer ball, a floating orb) are re-added only when wholly inside the cell,
which a neighbour's intruding limb never is; and where two characters are
genuinely **opaquely fused** (sheet C column 4 never drops below alpha 120 at
the row2/row3 seam — labelling alone produced 493px-tall two-character
sprites), the mask is cut at the narrowest row between them, which is a no-op
for every cleanly separated sprite. All 72 re-verified visually after the
rewrite: no bleed, no clipping, props intact.

This fully **replaced** an earlier 10-character batch (boy-base/girl-base/
explorer/adventurer/scholar/student/jedi/princess/knight/warrior) that was
built by flood-fill background removal from a flat-backdrop reference sheet.
The user explicitly rejected reusing that batch once real-alpha sheets were
available — those files, `tools/reference-sheet.png`, and the old
`slice-avatars.py` were deleted outright, not deprecated in place. If any of
those ids turn up in old profile data, they're simply gone from the catalog —
`avatarHtml()`'s "unknown char: id" fallback (below) covers it.

**Value convention** (unchanged from the original design): `equippedAvatar`
holds either an emoji character (the original shop) or the string
`"char:<id>"`. Everything that displays an avatar goes through `avatarHtml()`
in `app.js`, which emits an `<img>` for `char:` values and escaped text
otherwise, falling back to 🙂 for a `char:` id missing from the catalog.
Unlocks are namespaced `avatar:<id>` / `char:<id>` so an id reused across the
two catalogs can never gift the other for free.

**Tiers**: each entry in `ShopCatalog.CHARACTERS` carries `tier: "standard"`
or `tier: "chase"`, plus `defaultPrice`/`defaultActive` — deliberately named
"default" because the catalog array is never the live truth for price/active,
only the starting point (see Shop Config below). Chase avatars are the 12
most elaborate designs (angel/phoenix/dragon-rider/etc.), meant to be
expensive and rotated rather than permanently purchasable; two
(`angel-knight-boy`, `phoenix-rider-girl`) default to always-active, the
other 10 default off, waiting in the pool for a parent to rotate in via
Manage Avatars. Standard tier spans free starters (4), a cheap "sticker" band
(20⭐, ~28 items), a mid costumed band (60⭐, ~24 items), and a small premium
band (120⭐, 4 items) — see the comments above each price band in
`shop-catalog.js` for the exact list; there's nothing enforcing these bands
beyond convention, a parent can set any price via Manage Avatars.

**Shop Config (parent-controlled active/price overrides)** — `js/app.js`:
- `ShopCatalog.CHARACTERS` entries are read-only defaults. The live
  active/price state is a sparse override object, `{ [id]: {active, price} }`,
  persisted to `localStorage` (`ws_shop_config`) and — when a household is
  connected — to `households/{code}.shopConfig` in Firestore (same doc,
  same merge pattern as `catalogCode`; see `Sync.saveShopConfig` /
  `fetchShopConfig` / `watchShopConfig` in `sync.js`). `effectiveCharacter()`
  merges default + override per field independently, so setting a custom
  price doesn't implicitly decide active or vice versa.
- **Manage Avatars** (`#screen-manage-avatars`, opened only from a button on
  the PIN-gated Parent Dashboard — it has no PIN of its own, it inherits the
  dashboard's) lists every character grouped Chase / Standard with a live
  "In Store" checkbox and an editable price. Changes save immediately
  (localStorage + Firestore) and the Star Shop re-fetches the config every
  time it's opened (`openShop()` renders from cache first, then reconciles),
  so a change the parent makes on their phone shows up next time a kid opens
  the shop on their iPad without needing an app restart.
- **Known limitation, accepted, not engineered around**: if a parent edits
  Manage Avatars on two devices within the same second or so, the second
  device's cloud-refresh fetch can land after the first device's local edit
  and briefly revert it in the UI until the next fetch. Household-scale risk
  window, self-corrects, not worth a CRDT-style merge for this app.
- No automatic calendar-based rotation was built — "rotate chase avatars on
  a schedule" is presently a manual act (toggle checkboxes in Manage
  Avatars), not a cron. If the user wants real scheduled rotation later,
  that needs a start/end date pair per chase avatar checked at render time —
  straightforward to add on top of this, deliberately not built speculatively.

Source art resolution is the hard ceiling: figures are ~230-310px tall on the
sheets, comfortable up to roughly 130-150 CSS px on a 2x screen and no
further. Displaying a character much larger than the shop tile needs new art,
not upscaling.

**Pricing model (revised 2026-08-26 per explicit user direction)**: characters
are the premium option, emoji avatars are the cheap everyday option — not the
reverse, and not comparable. Only 4 standard characters are active by
default: one boy and one girl at each of two skin tones (`basketball-boy`,
`karate-boy`, `cheerleader-girl`, `doctor-girl`), at 50⭐ — a deliberately
small, deliberately diverse "baseline row," not a curated 20-item storefront
like the first pass shipped. Every other standard character starts inactive
at 100-220⭐, comfortably above the emoji ceiling (150⭐), so rotating one in
via Manage Avatars reads as a real step up. All 68 non-baseline standard
characters remain in the catalog; only `defaultActive` changed, so a parent
who had already turned extras on keeps them — Manage Avatars overrides are
independent of these defaults. Chase tier unchanged (12 characters, 350⭐,
`angel-knight-boy`/`phoenix-rider-girl` default-on).

## Manage Word Catalog injection review (2026-08-26)

A focused, independent second pass specifically on the paste-to-render
pipeline (`parseCatalogText()` → preview → `mergeWeeks()`/Firestore →
`sanitizeWeek()` → every render site), since that's the one surface where a
household types large free-text blocks that get stored and rendered back
across every device on a shared catalog. There's no SQL anywhere in this app
(Firestore is a document store), so the analogous risks are stored XSS,
Firestore path/id abuse, prototype pollution, and ReDoS — all four were
checked, not assumed.

**Medium, fixed — the catalog *code* field, not the paste box, could resolve
into an unrelated Firestore document.** Unlike the household-code field
(`maxlength="6"`), the catalog-code input had no character restriction, and
`connectCatalog()` passed it straight to `.doc(catalogCode)`. Firestore's SDK
treats `/` in a doc-path argument as segment separators, not a literal
character — a code like `REDACTED-CATALOG-CODE/weeks/7-w1` doesn't create a catalog with a
slash in its name, it resolves directly into that real, existing week
document. Reachable not just by typing it but via a crafted `?catalog=`
invite link that pre-fills the field with no visible slash — one click on
Connect and it's silently misrouted. **Bounded, not a cross-household leak**:
the hardcoded `db.collection("catalogs")` root and Firestore's lack of `..`
traversal make it structurally impossible to reach the `households` tree, and
reaching any specific nested doc this way requires already knowing both a
real catalog code and a real week id inside it. Still a real robustness bug —
fixed by rejecting any code containing `/` or `\` (or over 60 chars) in
`connectCatalog()` before ever calling `catalogRef()`, with a clear toast
instead of a silent misconnect.

**Fixed, latent-not-exploited — `escapeAttr()` didn't escape `>` or `'`.**
Every existing call site happened to land in a double-quoted attribute or a
text node, where those two are inert, so nothing was actually broken — but
the gap meant correctness depended on every *future* call site avoiding
single-quoted attributes, which is exactly the kind of assumption that stops
being true the first time someone doesn't know it exists. Now escapes all
five HTML-meaningful characters, `&` first to avoid double-escaping.
Regression-tested with a live `">script` payload pasted through the real
Manage Word Catalog flow end-to-end (preview → save → reload → Home render):
zero live `<script>` elements at any point, content displayed as literal text.

**Fixed, defense-in-depth — post-save `state.catalogWeeks` bypassed
`sanitizeWeek()`.** Every *other* path that populates `state.catalogWeeks`
(`ensureCatalogLoaded()`) routes through it; the two post-`mergeWeeks()` save
paths (paste import and starter-list import) didn't. Not currently
exploitable — both sources already produce sanitizeWeek()-shaped output — but
it's exactly the kind of inconsistency that could silently reopen the
"poisoned catalog crashes other households" bug (see the bug-patterns section
above) the day either producer changes. Now both call `sanitizeWeeks()` too.

**Fixed, cheap hardening — no length cap on pasted word/definition text.**
Bounded by Firestore's 1MiB document cap either way (caught by the existing
try/catch), but a household sharing a catalog with a hostile member could
otherwise bloat everyone's sync with one absurdly long "word" before that
cap ever kicks in. `parseCatalogText()` now caps word text at 200 chars and
definitions at 500 — far beyond any real word or definition, so no effect on
legitimate use.

**Confirmed clean, no fix needed**: no catastrophic-backtracking risk in the
one regex in this path (`GRADE ... (starts ...)` — `\s+`/`\S+` operate on
disjoint character classes with no ambiguous split point, and the optional
suffix has no nested repetition); no prototype-pollution vector (`sanitizeWeek()`
builds fresh object literals rather than spreading, `mergeWeeks()` keys a
`Map` by id rather than assigning object properties, and pasted text is never
used as a dynamic property key anywhere); `slugify()` cannot produce a `/` or
a path-traversal segment under any input (output alphabet is strictly
`[a-z0-9-]+`), so a hostile grade name can't escape the `catalogs/{code}/weeks/`
subcollection; `sanitizeWeek()` validates shape/type only (by design — it's
not meant to sanitize content), and every render site was individually traced
and confirmed to still be doing the actual escaping.

## Parent-visible practice tracking (fixed 2026-08-26)

Every study mode already called `recordModeStart()` on open and its answers
landed in that day's activity doc's `modes` counts — the data existed from the
start. What was missing was surfacing it: the Parent Dashboard's only
prominent activity section was "Recent tests" (populated exclusively by Test
Mode/Speed Quiz via `student.recentTests`), with every other mode's usage
compressed into a single "· mostly spelling" fragment on one summary line. A
parent whose kid did Spelling Practice or Word Scramble — the two modes these
particular kids actually prefer — would see nothing resembling evidence that
practice happened.

Fixed by adding a **"This week's practice"** section to `renderStudentCard()`
in `app.js`: every mode used in the current 7-day window, sorted by session
count descending, via a `MODE_LABELS` map matching the Home menu's own
icons/names. It counts *sessions* (how many times `recordModeStart()` fired),
not answers — "used Word Scramble 3 times" is the honest claim the data
supports; answer-level totals stay in the existing accuracy line, paired with
real correct/attempted counts rather than presented alone. "Recent tests"
stays as its own section for percentage-scored Test Mode/Speed Quiz results
specifically — this doesn't replace it, it fills the gap next to it.

## Dashboard week tracker, parent self-manage, vocab split (2026-08-27)

**Labeled Sun→Sat week tracker.** The Parent Dashboard's unlabeled `.psc-dots`
strip was replaced with a **labeled S/M/Tu/W/Th/F/Sa row** rendered directly
under "This week's practice," using theme-stable `var(--success)` green rather
than `var(--accent)` (which swaps per equipped theme — pink in bubblegum,
yellow in gold, purple in galaxy — and "did they practice" must not read as a
different signal depending on which theme a kid last equipped). This is the
**only week view in the app that carries day labels for a human**, so it's
also the only one honest about days that haven't happened yet: a future day in
the current week is dimmed rather than shown as a missed one. Backing this is
a new `weekDatesSunToSat()` helper, deliberately separate from the existing
`weekDatesMonToSun()` — Home's kid-facing streak dots stay Monday-first
because they're unlabeled (the difference is invisible there) and
`mondayOfThisWeek()` (starter-list import) depends on `weekDatesMonToSun()`
meaning exactly what its name says. The mode-breakdown rows were also
re-laid-out so the `N×` count sits immediately left of its label instead of
stretched flush-right across the card.

**Parent can rename/delete their own parent profile.** A "Your parent
profile" block at the bottom of the Parent Dashboard (below the student
cards) lets a signed-in parent rename or delete *only the parent profile
whose PIN they just entered* — `state.parentProfile.id`, not any other
profile. Deliberately narrow: a parent profile is just a name + a PIN with no
subcollections, so deleting it destroys no practice data, whereas a **student**
owns `students/{id}`, `progress/*`, `activity/*`, stars, unlocks and a
class-roster position that Firestore would orphan if the enrollment doc were
deleted out from under them — student rename/delete is explicitly out of
scope here and remains its own future project. Deleting the last parent
profile in a household is allowed and safe (nothing in the app assumes one
exists — `renderProfiles()` already hides `#parent-list` when empty, and
"👨‍👧 Add a parent" is always on the profiles screen). The delete writes
Firestore first and local storage second — the reverse order would let an
in-flight `watchProfiles()` snapshot silently resurrect the just-deleted
profile before the remote delete lands. `docs/firestore.rules` now allows
`delete` on `profiles/{profileId}` specifically (previously `if false`, per
its own "NOT YET APPLIED" header) — this is the **only** delete path in the
whole rules file; `progress/`, `activity/`, `students/{id}`, `households/{code}`
and `catalogs/{code}` all stay non-deletable.

**Vocab Practice split into two definition-required sub-modes.** The
`💡 Vocab Practice` Home tile now opens a picker (`#screen-vocab-setup`)
offering **🃏 Flip & Rate** (the original self-grade reveal flow, now filtered
to defined words) and **🧩 Match the Meaning** (new: shows the word, grades
against 4 multiple-choice definitions pulled from the rest of the week's
list). Both draw exclusively from `wordsWithDefinition(progress)` — the old
`"(No definition added for this word)"` placeholder is gone, because a
meaning-focused mode that shows no meaning was indistinguishable from Look &
Say, which was the actual ambiguity reported. A week with zero defined words
gets a one-time explanation on the picker instead of a broken-feeling session;
a week with 1-2 defined words offers Flip & Rate but disables Match the
Meaning (needs at least 3 for a real multiple choice). Match the Meaning
records into the same `"vocab"` stat bucket as Flip & Rate, so medals/accuracy
stay one number per word regardless of which vocab sub-mode produced the
answer. **Test Mode's "Vocab Test" and Speed Quiz's "Vocab" kind are
deliberately left unfiltered** — see Study modes above.

## Lock It In retype + Practice Buddy (2026-08-27)

**"Lock It In" retype gate.** On a miss in Spelling Practice or Smart Review,
the correct spelling is shown as before, but Continue now stays hidden until
the child types the word correctly once — framed as a positive "locking it
in" moment (a distinct `playSound("lockin")` chime, not the first-try
`"correct"` tone) rather than a penalty. A wrong retype just clears the input
and shakes it (`.input-shake`, 0.3s) with no text or sound — the correct
spelling is already on screen, so nothing needs restating. The retype is
never passed to `recordAnswer()`: the miss was already recorded, so a second
call would double-count the attempt and could hand out a medal-up for a word
the child just got wrong. Scoped to only Spelling Practice and Smart Review —
the two modes where the answer *is* the typed spelling. Explicitly excluded:
Word Scramble (tiles, not typing), Flip & Rate (self-graded, no wrong answer
to correct), and Match the Meaning (its existing green-highlight-the-right-
choice behavior already fills the same role). One shared state machine
(`retype`/`beginRetype`/`handleRetypeSubmit`/`endRetype`) drives both modes
since their submit handlers are duplicated code, not a shared helper — the
gate lives in one place instead of drifting between two copies.

**Practice Buddy.** The equipped avatar — already shown in `#header-avatar`
on every study screen — now reacts in place: a nod on a correct answer, a
bigger cheer hop on streak milestones/medal-ups/perfect rounds/daily
goals/shop purchases/a 90%+ test score, and a gentle wobble on a miss. Built
as `reactBuddy(kind)` called *alongside* every existing `celebrate()`/
`playSound()` call rather than a parallel decision tree, so it can't drift
out of sync with the reward system those already drive. Purely visual — not
gated by `isMuted()` (mute is an audio setting, not a motion setting) — and
respects `prefers-reduced-motion`. Silent during Test Mode (`silent: true`),
same as every other mid-test feedback, so a header bounce can't leak
correctness before the results screen. `showScreen()` now calls both
`endRetype()` and `clearBuddy()` so bailing out through the header 🏠 button
mid-retype or mid-animation can never leave either feature in a stuck state
on the next screen. Deliberately cut from the original pitch: an idle
animation between questions, speech-bubble text, a second larger avatar in
the practice card, per-mode personality, and a settings toggle — all judged
not worth the added markup/maintenance for a 34px header figure; only
`prefers-reduced-motion` support was kept.

## Word list duplicate check (fixed 2026-08-26)

User found 3 of 12 words repeated within Grade 7 "Precision" Week 1 of the
starter lists. All 8 packs / 24 weeks were swept for within-week duplicates
(a word repeating across *different* weeks or grades is fine and expected;
only a repeat within one week's own list is a bug). Only that one week had
any — `benevolent`/`credible`/`plausible` appeared in both the spelling list
and (correctly) the vocab list; the spelling-list copies were swapped for
different Latin-root words at the same difficulty (`altruistic`, `spurious`,
`prescient`) so the vocab entries and their definitions were left intact.
Independently re-verified programmatically after the fix: all 24 weeks have
exactly 12 case-insensitive-unique words. If more starter content is ever
added, re-run this check — nothing enforces uniqueness at write time, since
`starter-lists.js` is hand-authored content, not generated. (Grade 5's pack
no longer holds to the "24 weeks / 12 words" shape as of 2026-08-28 below —
its replacement content was independently re-checked the same way, still
duplicate-free, just at a different size.)

## Grade 5 starter pack replaced with real curriculum (2026-08-28)

The synthetic Grade 5 "Word Power" content (3 weeks × 12 made-up words) was
replaced with an actual 5th-grade spelling curriculum, transcribed from
photos of a physical Abeka-style workbook (Pensacola Christian College,
2024) the user provided. **Two-agent pipeline**: one agent transcribed all 7
photographed pages (Spelling Lists 3–8 and 10 — List 9 was that workbook's
own review unit, recombining earlier words, and was deliberately skipped as
not-new content); a second agent independently re-read the same 7 photos
from scratch *before* looking at the first agent's output, then reconciled —
catching and fixing 3 real transcription errors, all adjacent-item ordering
swaps (List 6 words 17/18, List 8 words 16/17, and List 8 vocab words 28/29
were each transposed in the first pass). The corrected result was then
independently diffed against what actually landed in `starter-lists.js`
before being called done.

Unlike every other grade's pack, Grade 5 keeps each workbook list's **full**
word count (22 words for Lists 3–8, 25 for List 10) rather than being
trimmed to the other packs' ~8-spelling-plus-4-vocab convention — cutting
real curriculum down to match placeholder-pack sizing would throw away words
the child's actual assignment expects them to learn. Net effect: **7 weeks,
215 words total**, up from 3 weeks / 36 words. `toWeeks()` and every UI call
site (`starterPackWordCount()`, the starter-pack picker card) are already
fully dynamic on `pack.weeks.length` and per-week word counts, so nothing
else needed to change to support the larger pack. Bible-book spelling words
(e.g. "Deuteronomy", "1 and 2 Samuel") are kept as plain spelling entries
with the workbook's printed abbreviation dropped, since that abbreviation is
a reference note, not part of the word itself.

## Privacy Policy & Terms of Use (added 2026-08-26)

A plain-language (not corporate-legalese) `#screen-legal` page, linked from
the profile picker screen (reachable pre-login, since that's the only place
it's linked from — `showScreen("legal")`/`showScreen("profiles")` don't depend
on any profile being selected). Covers: what's collected (name/nickname,
grade, PIN, practice stats, avatar/theme prefs — nothing else, since the app
never asks for anything else), where it's stored (local-first; Firestore only
if sync is turned on), the shared-code access model stated honestly (anyone
with a code has full access, by design), children's-privacy language (parent
sets it up for their own kids, no ads/tracking/analytics/third-party sharing),
and an honest note that there's no in-app "delete my household" button yet.

**Contact address**: `argusresearchcenter@gmail.com`, filled in 2026-08-26 per
explicit user confirmation (a placeholder was left deliberately unfilled
until then, since this page is public on GitHub Pages). Stated as a stopgap
until the user has their own domain — worth swapping to a domain-based
address later rather than leaving the personal Gmail up indefinitely.

## Usability features (added 2026-08-26)

Two features aimed squarely at adoption and retention, both fully local, both
verified end-to-end in a browser before being written up here.

### 1. Starter Word Lists (`js/starter-lists.js`)

The app's single biggest adoption blocker was that a brand-new family opened it
to "No word list yet" and could do *nothing* until an adult typed out a full
week of words. Now: Home's empty state shows a prominent **⚡ Get Started with
a Starter List** button, and Manage Word Catalog offers the same thing, leading
to a grade picker (Grades 1–8, each 3 weeks × 12 words — 8 spelling-only + 4
vocab-with-definition, matching the existing Abeka-style convention so every
mode including Vocab Practice works immediately — **except Grade 5**, which
was replaced 2026-08-28 with a real, larger curriculum; see below).

- Import reuses the **same** save path as the paste importer (`mergeWeeks`,
  local + Firestore write, `loadCatalogAndWeek` refresh) rather than a second
  parallel path — one code path to reason about when catalog writes misbehave.
- A student profile with no `grade` set adopts the pack's grade on import,
  otherwise `computeAutoWeek()` filters it out by grade and the import appears
  to silently do nothing.
- Week ids are `starter-{grade}-w{n}` — deliberately NOT the paste parser's
  `{grade-slug}-w{n}`, so a starter pack can never overwrite a hand-typed week.
- **Word ids are deterministic** (`starter-{grade}-w{n}-v{i}` / `-s{i}`), not
  `uid()`. This is load-bearing: `loadProgressForWeek()` reconciles stored
  progress against the catalog *by word id*, so random ids would mean
  re-importing the same pack (or a second device importing it) mints new ids
  and silently resets the child's entire history for those weeks. Caught and
  fixed during self-review, then verified by re-importing a pack after
  practicing and confirming attempt counts survived.

### 2. Smart Review + Daily Goal

**Smart Review** (`🧠` on the Home menu, with a badge showing how many words are
waiting) is the first mode that is not scoped to a single week. It pulls the
student's weakest words out of *every* week they have ever practiced, so old
material doesn't rot once the class moves on.

- Queue is built from the `ws_progress_index_{profileId}` index, skips
  gold-medal words, and sorts weakest-first: medal rank ascending, then
  accuracy ascending, with never-practiced words scored 0.5 so they rank behind
  demonstrated weaknesses but ahead of merely-okay words. Capped at 15/session.
- **Structural gotcha worth preserving**: a review word belongs to *another
  week's* progress doc, so stats must be written back to that word's own doc —
  never to `state.progress`, which still points at the currently selected week.
  `reviewSession.docs` holds every touched doc by weekId and saves each
  individually; if the reviewed word's week happens to be the open one,
  `state.progress` is re-pointed at the saved doc so Home's medal counts don't
  show stale pre-review numbers. Verified by snapshotting two week docs, running
  a 15-word review spanning both, and confirming attempt counts landed in the
  correct doc (Week 1 +11, Week 2 +4, matching the queue exactly).
- Review is exempt from the "needs a current word list" nav guard, since it
  works off history and is useful precisely when the current week is empty.
- Guards against progress docs missing `spelling`/`vocab` sub-objects (older
  builds, tampered localStorage) — one malformed word must not throw, because
  the queue is rebuilt on every `renderHome()` for the badge count.

**Daily Goal** is a 20-answer/day target rendered as a progress bar on Home,
worth a one-time +5⭐. It counts answers via `recordAnswer()`, so no study mode
needs to know it exists. The `goalAwarded` flag lives **on the persisted
activity doc**, not in memory, so reloading the page or practicing on a second
device cannot re-award the bonus — verified by reloading mid-day and answering
again (stars held at 8, flag stayed true).

## Security review (2026-08-26) — what was found and fixed

A three-agent review (client-side, data layer, avatar QA). Everything below is
**fixed in code already**, except the two items explicitly marked as requiring
Firebase console access.

**Critical — the catalog document leaked the household code.** `connectCatalog()`
stored the household's own 6-character access code in plaintext as
`ownerHousehold` on the catalog doc. Catalog codes are *designed to be handed to
other families*, so the intended sharing workflow itself handed the other
household full read/write access to this one's profiles, PINs, and scores. Fixed
by storing an opaque 256-bit `ownerToken` instead (`generateOwnerToken` in
`sync.js`), compared token-to-token. Note a hash of the code would NOT have been
enough — 32^6 is ~1e9, brute-forceable offline in seconds. Legacy catalogs
carrying the old field, and catalogs with no owner recorded, fail open to
editable so nothing live gets locked out. **Manual cleanup worth doing: if any
catalog doc in Firestore still has an `ownerHousehold` field, delete that field
in the console** — the code no longer writes it but cannot scrub what is already
there. HANDOFF's earlier note says the real `REDACTED-CATALOG-CODE` catalog predates the field
and so should be clean; worth confirming.

**Medium — poisoned shared catalog content could crash other households.**
`loadProgressForWeek()` called `week.words.map()` unguarded, and `progress.words`
likewise. Any household with the catalog code could write a week doc with
`words` missing/null/a string and break week selection for *everyone* sharing
that catalog until someone hand-repaired Firestore. Fixed with
`sanitizeWeek()`/`sanitizeWeeks()` at the boundary (see the bug-patterns section
above), verified against a deliberately hostile catalog.

**Medium — a negative avatar price minted stars.** `effectiveCharacter()`
type-checked `price` but never range-checked it, and `buyItem()` does
`p.stars -= price`. A kid could write `shopConfig` directly via the SDK
(bypassing the Manage Avatars UI clamp) with `price: -100000` and buy their way
to a huge balance. Fixed with `sanitizePrice()` at both the config layer and the
spend layer; verified that `-100000`, `"free"`, and `NaN` all fall back to the
catalog default.

**Medium — a `undefined` field could silently stall sync forever.** Firestore
throws *synchronously* on an `undefined` field value, and since
`pushProgress`/`pushActivity` are fire-and-forget, that surfaced as an unhandled
rejection: local save succeeds, UI shows success, and every later write of that
doc fails identically with no user-visible error. Reachable via hand-edited
catalog data omitting `definition`. Fixed three ways — `sanitizeWeek()` forces
`definition` to a string, `loadProgressForWeek()` guards with `|| ""`, and
`stripUndefined()` in `sync.js` scrubs doc-shaped writes as defence in depth.

**Medium — swallowed write errors.** The fire-and-forget writes used
`.catch(() => {})`, hiding exactly the failure above. They now log via
`warnWriteFailed()`, and a failed shop-config sync tells the parent it saved
locally but did not reach the kids' devices.

**Also**: service worker now only caches same-origin 2xx responses; dead
`watchShopConfig` removed.

**Requires Firebase console access (not done, cannot be done from the repo):**
1. **Apply `docs/firestore.rules`.** The recommended ruleset is written out in
   that file with rationale. Its one substantive change is splitting `get` from
   `list` so a stranger cannot dump every household code and shopConfig in one
   query — the app only ever fetches by known id, so this costs the family
   nothing. It is **not yet applied**; review it against the live rules first.
2. **Enable App Check** (free on Spark). Anonymous auth means anyone can create
   documents, so a trivial script could exhaust the 20k/day write quota and take
   the app offline for the family. Low motivation for an obscure family app, but
   cheap to weaponise and cheap to prevent.

**Explicitly assessed and accepted, not bugs**: codes-as-passwords, the
client-side parent PIN, kids being able to tamper with their own local star
balance, and the public Firebase web config. All are documented design
tradeoffs. Note the PIN and the Manage Avatars gate *cannot* be made real at the
data layer under the current auth model — the whole household shares one
anonymous session, so Firestore rules cannot tell a parent from a kid. Making
that real needs per-person auth (Blaze-plan Cloud Functions), which is out of
scope. Household-code brute force was computed as infeasible: 32^6 ≈ 1.07
billion, ~59 years at Spark's 50k reads/day.

## Deploy process

```
git add <files>
git commit -m "..."
git -c credential.helper= -c credential.helper="!gh auth git-credential" push origin master
```

Plain `git push` **hangs indefinitely** on this machine (global
`credential.helper=manager` tries an interactive prompt with no UI to answer).
Never change the persisted git config to "fix" this — use the override above.
`gh` is already authenticated as `denytrebor`. GitHub Pages rebuilds
automatically on push, live within roughly 30–60 seconds.

**Testing practice**: for anything touching the sync layer or catalog import,
test against a throwaway household/catalog code first (not the real
`REDACTED-HOUSEHOLD-CODE`/`REDACTED-CATALOG-CODE`), or serve `docs/`/the repo root locally via
`python -m http.server` for a quick smoke test before deploying. Firestore
rules allow `create`/`update` on household docs but **not `delete`** — a
throwaway household can't actually be cleaned up after testing; leaving an
orphaned empty household code around is harmless (no PII, just consumes one
random 6-char code) and is the accepted cost of that testing pattern. (This is
about the `households/{code}` doc specifically, not every doc in the tree — a
parent CAN now delete their own `profiles/{id}` doc, see "Parent self
rename/delete" below. Students, progress, and activity stay non-deletable.)

## Current family data (real, live — do not touch as test cleanup)

**Household `REDACTED-HOUSEHOLD-CODE`**, catalog code **`REDACTED-CATALOG-CODE`**:

| Profile | Role | Grade | Notes |
|---|---|---|---|
| Micah | student | 5 | Abeka spelling/vocab, 1 week loaded |
| Robert | student | 5 | Abeka spelling/vocab, same catalog as Micah |
| Roman | student | 7 | Wordly-Wise-style workbook, Lists 2–10 loaded (see below) |
| Candice | parent | — | PIN-protected dashboard access |
| Candice | parent | — | **Duplicate profile, same name** — not investigated or cleaned up, flagged to the user, no action taken |

**Roman's Grade 7 catalog** (`catalogs/REDACTED-CATALOG-CODE/weeks/7-w1` … `7-w9`): 9 weeks,
one per workbook "List" (2 through 10), 30 words each (10 vocab w/ definitions
+ 20 spelling words). Labels read "Grade 7 · List N" (matching the physical
book) even though the underlying doc ids/weekNumbers are sequential 1–9 — that
mismatch is intentional and cosmetic, doesn't affect app function.
`weekStartDate`s are set so **List 3 is the current week as of 2026-08-25**,
advancing weekly through List 10 (2026-10-11). List 1 was never provided by
the user — if it shows up later it needs to be inserted as its own earlier
week with an earlier start date, not appended after List 10.

## Known bug patterns worth checking for in new code

- **Post-commit lock**: anything that auto-checks/completes on state change
  (Word Scramble's tile-fill, a round-completion bonus check) needs an
  explicit "already handled" flag reset per attempt — an array/state that's
  only populated asymmetrically across rounds/attempts will silently
  double-fire or mis-fire. Bit the app twice already (Scramble stat
  double-count, retry-round bonus firing after a wrong answer).
- **Firestore `undefined` field**: `.set()`/`.update()` throws *synchronously*
  on any field value of `undefined`, before your `.catch()` can run. Always
  guard optional profile fields with `|| ""` / `|| []` etc. in `sync.js`.
- **Shared catalog content is untrusted input from another user.** Anyone with
  the catalog code can write `catalogs/{code}/weeks/{id}` directly, so a week
  doc is not our own data — it can be missing `words`, have `words` as a
  string/null, contain junk word entries, or carry a non-date `weekStartDate`.
  All catalog weeks are normalized through `sanitizeWeek()`/`sanitizeWeeks()`
  in `app.js` at the point they enter `state.catalogWeeks`; never `.map()` over
  `week.words` (or a stored `progress.words`) without going through that or an
  `Array.isArray` guard. A 2026-08-26 security review found exactly this crash
  path — an unguarded `week.words.map()` in `loadProgressForWeek()` that let one
  household break week selection for every household sharing their catalog.
- **Self-echo / safe-apply**: a device's own Firestore write echoes back
  through its own `onSnapshot` listener. Filter `hasPendingWrites`, and only
  apply remote state changes to `state.week` (or similar live-session state)
  when the user is on a screen where that's safe (Home/Progress), never
  mid-session or mid-edit.
- **Local-date math**: never use `.toISOString()` for "today"/week-math — it
  shifts the calendar date for anyone not at UTC. Use local-calendar-date
  formatting throughout (already fixed once, don't reintroduce it).
- **Bulk catalog import re-pastes must be cumulative**: the paste parser
  numbers weeks 1, 2, 3... fresh within *each individual paste*, and doc ids
  are deterministic (`{grade-slug}-w{n}`) — pasting just one new week later
  will land on an existing id and silently overwrite it via `mergeWeeks`.
  Always paste a grade's **entire** running list (all prior weeks + the new
  one, chronological) into Manage Word Catalog, never just the newest week.
- **Multi-photo transcription**: when building a bulk-import paste from
  several photographed workbook pages, verify each page's own printed list
  number for its vocab AND spelling sections independently — don't trust the
  order photos were pasted into chat. This exact mistake mismatched vocab
  words across 3 of Roman's 9 weeks on 2026-08-25 before being caught and
  fixed directly in Firestore. Do a cheap post-import verification pass
  (dump each week's first vocab word + first/last spelling word, eyeball
  against source) before calling an import done.

## Student/Class split — Phase A of long-term identity model (2026-08-27, LIVE)

Full design reasoning in `docs/long-term-architecture.md`; implementation
plan (with current status) in `docs/phase-a-student-model-plan.md`. Short
version: a student's durable identity — stars, `lifetimeStars`, unlocks,
streaks, equipped avatar/theme, `recentTests` — now lives in a new top-level
`students/{id}` collection instead of on `households/{code}/profiles/{id}`.
The household/profile doc becomes a thin per-class enrollment record (just
`grade` for a student-role entry). Both share the same document id, so a
student moving to next year's class is just a new thin enrollment doc
pointing at the same `students/{id}` — no data copy, which is the whole
point: this is the fix for "how do a kid's rewards follow them to a new
class" raised during the school-scale conversation. Parent-role profiles are
completely unchanged (no rewards/history to decouple). `progress`/`activity`
subcollections deliberately stay where they are — out of scope for this
pass, a separate future migration if ever wanted.

`js/app.js` needed zero changes — every place it reads `state.profile.X`
still sees the same flat shape it always has. Only `js/sync.js` knows the
data now lives in two documents; it merges on read
(`migrateStudentIfNeeded()`) and splits on write (`pushProfile()`). Existing
real profiles migrate themselves automatically and losslessly the first
time they're loaded after this ships — no manual script, no console
surgery — by copying whatever reward fields are still sitting on the old
profile doc into a new student doc. **Additive only, by design**: the
migration never mutates or strips the old doc, so even if something goes
wrong, nothing that already existed is at risk — worth preserving as the
standing principle for any future migration this app does.

**Live and verified against real production Firestore (2026-08-27).**
`docs/firestore.rules` (which includes a `students` block, denying `list`
for the same enumeration-risk reason `households`/`catalogs` already do)
was applied via Firebase console → Firestore Database → Rules → Publish.
The architect re-verified the full feature afterward end-to-end against
real Firestore, throwaway households only, never `REDACTED-HOUSEHOLD-CODE`/`REDACTED-CATALOG-CODE`:
`students/{id}` reachable and correctly `list`-denied; a legacy-shape
profile migrates itself on load with nothing blanked; a real purchase
persists correctly to the student doc; the original enrollment doc stays
byte-for-byte untouched afterward; and — the scenario this whole feature
exists for — a second, unrelated household seeded with nothing but a bare
`{grade, role}` pointer correctly showed that student's full stars/avatar,
carried over from the shared record alone. Parent PIN flow and School
Overview confirmed unaffected. Zero console errors.

**A real bug was found and fixed during this pass, before any of the above
verification**: the original design for `migrateStudentIfNeeded()` cached
"already migrated this session" per id, and if the underlying write had
ever failed (which it reliably did before the rules were applied), a second
call for the same id would trust that stale cache, skip recomputing, and
return an empty object — blanking a real student's stars/name/avatar to
zero in the UI and, after a reload, in `localStorage` too. Fixed by removing
the cache entirely: the function now always re-derives from the enrollment
doc's data when the student doc doesn't exist, on every call, so a
persistently-failing write degrades to "keeps showing the correct data,
keeps harmlessly retrying" instead of "correct once, then blanks." Proved
against the exact failure scenario (a write that always throws
`permission-denied`, called repeatedly for the same id) before the rules
were even applied — this is why the feature was safe to leave in the repo
during the gap between shipping the code and applying the rules.

**Small follow-up the same day: `unlockDates` (when each avatar/theme was
earned).** A `long-term-architecture.md` idea ("legacy avatars" — showing
*when* something was earned, not just that it's still owned) that's cheap
now that profiles are durable. Purely additive: `buyItem()` in `app.js`
stamps `p.unlockDates[unlockId]` with the local-calendar purchase date
alongside the existing `p.unlocks` push; threaded through the same three
`sync.js` spots that already carry `unlocks` (`pushProfile`,
`migrateStudentIfNeeded`, `watchProfiles`'s merge — deliberately NOT added
to `fetchHouseholdProfiles`, since School Overview never surfaces individual
data and has no use for it). No migration: every read is `|| {}`-guarded, so
existing unlocks with no entry just have no date, forever, which is exactly
correct — that information was never captured and can't be reconstructed.
No UI surfaces this yet (deliberately out of scope for this pass — there's
no "your collection" view to put it in); this is instrumentation for
whenever that gets built, not a finished user-facing feature.

## Scaling to a school (shipped 2026-08-26, per `docs/school-scale-plan.md`)

The user's wife, a small K-12 school's principal, wanted to offer Word Study
to the school (~60 students, grades 2-12). Full plan and reasoning in
`docs/school-scale-plan.md`; this section is the current-state summary.

**A "class" is a `households/{code}` document, unchanged** — the load-bearing
decision everything else follows from. Rejected one household for the whole
school (every family would see every other family's kids on the shared
profile picker before any PIN — student profiles have no PIN) and one
household per student (privacy-perfect but 60 codes to generate/lose/recover
instead of one per class). A class of ~15-25 kids who already sit in the same
room, with a teacher who can post one code on the wall like a wifi password,
bounds the privacy blast radius to "classmates" (already a normal visibility
level) and turns "60 codes to lose" into "a handful of classes to lose." This
is a recommendation conveyed to the school, not something the app enforces —
nothing stops a household-per-family setup instead if that fits better.

**Bulk class roster import** (`#screen-class-roster`, reached via "👥 Add a
Class Roster" on the profile picker) lets a teacher paste a whole roster —
one student per line, `Name` or `Name, Grade`, with a single "default grade"
field for lines that omit one — instead of adding 20 kids one at a time.
Mirrors the catalog editor's paste → preview → confirm shape. `btn-add-profile`'s
single-add handler was refactored to extract `createStudentProfile(name, grade)`
so the bulk-import loop calls that directly rather than the full click
handler, which used to `selectProfile()` immediately after creating — fine
for a parent adding one kid, wrong for a teacher adding 20 (it would "enter"
the app as each of 20 kids in sequence). Same defensive caps as
`parseCatalogText()`: 60 chars/name, 200 students/paste.

**Class Info screen** (`#screen-class-info`, "🏫 Class Info") pulled the
code/copy-link display out of the small inline strip on the profile picker
into its own screen a teacher can put on a wall — big code, a QR code, and
the existing Copy/Copy-invite-link buttons. Reachable both immediately after
creating a household (before the existing join-tap password-save flow even
runs — `openClassInfo()` tracks whether it was opened from the household
screen and sends "Back" there instead of to the profile picker, so that flow
isn't short-circuited) and as a persistent, ungated button on the profile
picker whenever a household code exists (ungated deliberately: anyone
viewing that screen already has the code's full access, so gating the
*display* of it adds friction with no real security benefit).

The QR encodes `inviteURL("household", code)` via a vendored local QR
encoder, `js/vendor/qrcode.js` (the well-known kazuhikoarase MIT-licensed
implementation, fetched once from its GitHub source — no CDN `<script>` tag,
no hand-rolled Reed-Solomon math). Verified independently, not just
eyeballed: pulled the actual boolean module matrix out of a live `QRCode`
instance and decoded it with `jsQR` (an unrelated decoder), which read back
the exact invite URL.

**Profile grid at class scale**: `renderProfiles()` now shows a live
search/filter box and switches to alphabetical order once a household has
more than 8 students (not configurable — a threshold nobody will ever need
to tune isn't worth a settings UI); below that, renders exactly as before
with zero visual change for the family case. Tapping a profile that doesn't
match this device's cached `ws_active_profile` shows a brief "is this you?"
interstitial first — a mis-tap guard for a shared classroom device cart, not
a security boundary (no PIN, no real gate — that would contradict the whole
"kids just tap their name" design). On a 1:1 device this never shows after
the first login, because `enterApp()`'s existing auto-resume bypasses the
picker screen entirely once `ws_active_profile` is set.

**School-wide word delivery** needed no new logic — `catalogs/{code}` already
lets one shared catalog hold every grade's weeks side by side, and
`computeAutoWeek()` already filters by each profile's own grade. The
recommended workflow (stated for a principal, not a developer): pick one
memorable catalog code for the whole school, every class connects to it once
via Manage Word Catalog, whoever manages curriculum pastes their grade's
weeks into that one shared catalog, and every enrolled kid in every class
sees their own grade's current week automatically. If two teachers ever edit
the same grade's same week at the same time, the more recent save wins
(existing `mergeWeeks()` behavior, not new). The catalog editor's placeholder
text and hint now show a 3-grade paste example to make this obvious at a
glance rather than looking like a one-grade-at-a-time tool.

**School Overview dashboard** (`#screen-school-overview`, "🏫 School
Overview" button on the Parent Dashboard) gives a principal a bird's-eye view
across every class without visiting each household's dashboard separately.
Deliberately **read-only, aggregate-only, and privacy-preserving by
construction** — it never shows an individual student's name, avatar, or
score, only per-class counts, so it can't reopen the privacy problem the
class-per-household decision above exists to avoid. A local-only "watchlist"
of class codes + labels (`ws_school_watchlist` in `localStorage`, managed by
pasting a small `CODE, Label` list) lives only on whichever device the
principal uses for this; one new read-only `Sync.fetchHouseholdProfiles(code)`
reads an arbitrary household's `profiles` subcollection (same slash/length
validation as `connectCatalog()`, since it's user-typed and handed to
`.doc()`). "Practiced this week" is computed from each profile's existing
`lastActiveDate` field rather than pulling every student's daily activity
docs — one Firestore read per watched *class* regardless of roster size,
not one per student, which matters more at school scale than it did for a
single household's own dashboard.

**Capacity**: Firestore Spark's free-tier caps (50k reads/day, 20k
writes/day) comfortably cover this school's actual scale even under a
generous estimate (all 60 kids practicing twice a day, ~30 ops/session ≈
3,600 ops/day) — no paid plan needed. `docs/firestore.rules` was applied by
the user on 2026-08-27 (originally flagged in the 2026-08-26 security review
as should-do-before-enrolling-real-kids at school scale, since multiple
unrelated families' children's data now shares the project) — **enabling
Firebase App Check is still outstanding**, same category of action, not yet
done. Likewise, school enrollment of *other* families' children may need the
school's own data-privacy-agreement process; the current `#screen-legal`
page was written for one family's own kids and wasn't rewritten for a
school context, which is a judgment call for the principal, not something
to draft unprompted.

**Not built (Phase 4, nice-to-have, explicitly optional in the plan)**: a
single whole-school "N words practiced together" fun counter. Skipped
because computing it accurately would need reading every student's progress
subcollection across every watched class (no field already read by the
School Overview aggregate maps to a real word-attempt count — `lifetimeStars`
is stars, not words, and is itself parent-adjustable via Manage Avatars
pricing), which is exactly the more-expensive new data path the plan's own
text for this phase said to avoid rather than invent for a nice-to-have.

## Login/recovery UX (shipped 2026-08-25)

**Problem**: the household code is the only way back in on a device — there
are no real accounts. iOS Safari has a documented quirk of silently wiping a
site's `localStorage` (where the household connection lives) if a Home Screen
web app isn't opened for about a week. No warning, kid is just logged out with
no way back in except asking a parent for the code.

**Fix**: the household join field (`#join-household-code` in
`index.html`/`app.js`) is now a real `type="password"` input inside an actual
`<form>` (`#join-household-form`), paired with a hidden `autocomplete="username"`
field. That's the specific shape browsers/iCloud Keychain look for to offer
"Save Password?" — that storage survives a site-data wipe, unlike
`localStorage`. An eye-icon toggle lets the user reveal the code while typing;
it's forced back to `type="password"` right before the actual submit so the
save-password heuristic sees a real password field at that moment. Creating a
brand-new household no longer auto-enters the app — it drops the fresh code
into the same field and asks for one confirming "Join" tap, so the save
prompt has a chance to fire at creation time too.

**Known limitation**: this is a best-effort browser feature, not guaranteed —
Safari sometimes declines the save prompt for SPA-style (non-navigating) form
submits, and a user can dismiss/decline it. Recommended as defense-in-depth,
not a full replacement for writing the code down somewhere durable (a note in
Settings, a card on the device). The `?household=CODE` invite-link query param
already existed (pre-fills the field) but does **not** auto-submit, and can't
be baked into the Home Screen icon reliably since the manifest's `start_url`
is static and shared by the whole family, not personalizable per install.

## School-readiness backlog, round 1 (2026-09-01)

A Fable 5.1 codebase review produced a QoL backlog + a "Class Word Wall"
differentiator pitch; the owner declined the Word Wall (read as a bolt-on) and
asked for everything else implemented. This section is the result. Every item
below is code-complete and syntax-checked; **no browser was available in this
session to click through it live** — verification was static tracing plus one
standalone Node script re-running the catalog parser's actual logic against
real inputs (WEEK N targeting + the edit round-trip math), not a full in-app
smoke test. Treat this as "implemented, wants a real click-through" rather
than "verified working."

**Anti-farming, round 2** (round 1 was the same-day `bonusRoundsToday` cap
above `## Anti-farming star economy` in `docs/gamification-parent-mode-spec.md`
§2): three more places could mint stars without being gated by that cap.
- `recordAnswer()` gained an `opts.noStars` flag. Self-graded modes — Flip &
  Rate's "I Knew It", Speed Quiz's "Got It" (both kinds), Vocab Test's "I Knew
  It" — now always pass it: word stats/medals still update (the learning
  signal stays honest), but no star, no first-practice bonus, no daily-goal
  credit, no streak advance. `renderResultsScreen`'s own perfect-round bonus
  gained a matching `allowBonus` flag (false for Speed Quiz always, false for
  Vocab Test, true for Spelling Test).
- New `offGradeWeek()`: the week picker lets a student browse another grade's
  list (its own hint text suggests it) — stats still record on any grade, but
  `noStars`/`canPay:false` now zero the stars when `state.selectedWeek.grade
  !== state.profile.grade`. Smart Review is deliberately exempt (it pulls from
  the student's own past weeks, which may legitimately be a past grade, not a
  grade being browsed into).
- `awardRoundCompletionBonus(session, canPay)` and `awardCappedBonus` both took
  a `canPay` gate so the same noStars/offGrade logic reaches the perfect-round
  and retry-clear bonuses, not just per-answer stars.

**Per-device activity caps** (`getOrInitActivity()` was localStorage-only, so
a second device reset every cap to zero): `selectProfile()` now fetches
today's remote activity doc once via the existing `Sync.fetchActivityRange`
and merges it with the local one through a new `mergeActivityDocs()` — max of
every counter/map entry, OR of every boolean flag — before either is used or
pushed. Same call also seeds Smart Review's pool (`loadAllProgressDocs`) from
`Sync.fetchAllProgress` when the local index is empty, so a new/wiped device
isn't starting with zero review words.

**Grade 5 content compatibility**: `scrambleSafeWords()` filters entries with
digits or spaces (`"1 and 2 Samuel"`) out of Word Scramble's queue — real
shipped curriculum, not hypothetical, see the Grade 5 section above. A new
`normalizeSpelling()` (trim + collapse internal whitespace + lowercase)
replaces the ad hoc `.trim().toLowerCase()` compares at every spelling-grading
site (Spelling Practice, Smart Review, Test Mode, the "Lock It In" retype
target) — doesn't fix the TTS-pronounces-digits-as-words mismatch, that's a
bigger problem, but removes stray-whitespace false negatives.

**School-shared catalog now actually shareable**: `openCatalogEditor()`'s
`ownerToken` check used to permanently lock every household but the one that
created a shared catalog out of editing it — contradicted
`docs/school-scale-plan.md`'s stated design. New `editorTokens` array on the
catalog doc (`Sync.addCatalogEditor`, arrayUnion) plus an explicit "enable
editing for this class too" button on the readonly note — deliberate, not
auto-granted on connect, same soft-guardrail posture as `ownerToken` itself.

**Per-week catalog edit/delete** (`## Manage Word Catalog` screen): the only
edit path used to be re-pasting an entire grade's year, and a single-week
paste silently landed on week 1 every time. `parseCatalogText()` now accepts
an explicit `WEEK N` line that overrides the auto-incremented position for
the block that follows it (a plain multi-week paste with no `WEEK` lines is
unaffected — verified both cases with the standalone parser trace mentioned
above). A new "Existing Weeks" list under the paste box offers ✏️ (loads that
week back into the paste box via `weekToPasteText()`/`impliedSeriesStart()`,
which reconstructs the GRADE header's implied start date so re-parsing
regenerates the exact same week id and date) and 🗑️ (in-app confirm, then
`Sync.deleteCatalogWeek`). **`docs/firestore.rules`'s `catalogs/*/weeks/*`
delete rule changed from `if false` to `if signedIn()`** to match — that file
is still explicitly marked NOT YET APPLIED to the live project; if it's ever
applied as it stood before this change, per-week delete would silently fail
against real Firestore rules even though the client code works. Apply the
updated rules file in the Firebase console for delete to actually work live.

**Firestore write volume** (`docs/school-scale-plan.md`'s capacity math
assumed less than this actually cost): `persistProfile()` → `Sync.pushProfile`
and `saveProgress()` → `Sync.pushProgress` are now debounced ~2s
(`scheduleProfilePush`/`scheduleProgressPush`, force-flushed via
`flushPendingSyncPushes()` at the exact same moments `flushActivity()` already
treats as "must not lose this": session end, every 10th answer, tab hidden,
and now also the top of `selectProfile()` so switching profiles mid-session
can't let one profile's still-pending write get clobbered by the next
profile's first write landing in the same global pending slot). `pushProfile`/
`pushProgress`/`pushActivity` in `sync.js` now `return` their write promises
instead of firing-and-forgetting internally — additive, every existing caller
still ignores the return value exactly as before. `watchProfiles()`'s
`migrateStudentIfNeeded` gained a cache, but ONLY for the "confirmed to
already have a `students/{id}` doc" branch — the still-migrating branch stays
deliberately uncached, for the exact blanking-bug reason documented in that
function already.

**New: "This Week's Words"** (`openWordList()`, first tile on Home) — a plain
reference list of the current week's words in catalog order with a speaker
button and each word's definition when one exists (nothing shown when there
isn't, same rule `wordsWithDefinition()` already documents for Look & Say).
No stats, no medals — Progress already covers that; this is what a kid reaches
for at the start of a week, before drilling. A "Hear the Whole List" button
speaks all the words as one combined utterance (comma-joined) rather than
looping `speak()`, since `speak()` cancels any utterance already in progress.

**Home screen additions**: a "N of TOTAL words at Silver or better" progress
bar under the week label (same visual language as the daily-goal track — both
answer "am I done," different time scales); a one-time toast recap
("Last week: 🥇 N · 🥈 N — new list!") the first time Home auto-advances onto
a new week, via `checkWeekRollover()`/`ws_last_seen_week_{profileId}`; a
"Start here" recommendation card above the tile grid
(`renderHomeRecommendation()`) driven by simple priority rules over data
every mode already produces. Also fixed the bug the progress bar and recap
both depend on reading correctly: `loadCatalogAndWeek()` used to prefer a
saved `ws_selected_week_*` pin forever once "Change Week" was tapped once —
it now expires that pin once the auto-computed week for the SAME grade has
genuinely moved past it (a deliberate look at a different grade is left
alone, since there's no "current week" to compare against for a grade the
profile isn't in).

**Test Results / Speed Quiz results**: a "✏️ Practice the Ones I Missed"
button launches Spelling Practice (or Flip & Rate for vocab misses, filtered
to words that actually have a definition) on just the missed word subset —
`openSpelling`/`openVocab`/`openScramble` all now accept an optional word
subset, falling back to the full current week when none is given. Deliberately
NOT added to the parent dashboard's needs-work list — that would mean
launching a study session as a student from inside a read-only parent-mode
screen, a bigger change (session/identity handling) than this item's scope
warranted; a kid reaching for their own Progress/results screen is the
lower-risk place for this.

**Parent Dashboard**: inline student name/grade editing (`renderStudentCard`'s
new ✏️ toggle + `saveStudentEdit`) — there was no edit path at all before this,
which matters once a year (promotion) and once per roster typo caught on day
one; delete is still deliberately absent, see the existing PARENT SELF-MANAGE
section above for why. A "This week's hardest words (whole class)" card
(`renderHardestWordsCard`) aggregates the SAME per-student current-week data
`loadParentDashboard` already fetches — zero new reads. Above
`PROFILE_SEARCH_THRESHOLD` (8) students, the dashboard renders a compact
sortable table (`renderRosterTable`, least-active-first) instead of one full
card per kid, each row expanding lazily into the existing full card on tap.

**Star Shop**: native `confirm()` on purchases replaced with an in-app
confirm box (`requestBuyItem`/`pendingBuy`) — the same "a native dialog reads
as a browser error inside an installed PWA" reasoning was then reused for the
new catalog week-delete confirm too, rather than reaching for `confirm()`
there as a new precedent. A new "🏆 My Trophy Shelf" screen (reached from the
shop) shows every owned illustrated character at full size with its earn
date (`unlockDates`, recorded since 2026-08-28 but never surfaced until now),
plus lifetime stars / best streak / gold-word count aggregated the same
device-local way Smart Review's pool already is. Match the Meaning's
distractor pool now tops up from other weeks of the same grade
(`extraDistractorPool`) when the current week has fewer than 6 defined words,
so the same 3 wrong answers don't repeat every round. A small header dot
(`sync-status-dot` — synced/pending/offline, hidden entirely when sync isn't
enabled for the household) reflects whether the debounced writes above have
actually reached Firestore. Speed Quiz's Home tile now says "needs a reader"
underneath, and the viewport meta's `maximum-scale=1` (blocked pinch-zoom) is
gone.

**Copy pass**: light, not a rewrite — "Parent Dashboard" → "Parent / Teacher
Dashboard", "Add a parent" → "Add a parent or teacher", the household-connect
subtitle and a few Privacy Policy sentences now say "family or class"/"parent
or teacher" instead of assuming a family. Same wording chosen once and
threaded through, not a deep rewrite of the legal page.

**Deliberately deferred, not forgotten**: a "promote all students +1 grade"
bulk button (mentioned as a nice-to-have alongside the per-student grade edit,
didn't fit cleanly into this pass); any further Match the Meaning / week-list
polish beyond what's listed above.

## Gamification, round 2: the addictive-loop pass (2026-09-02)

A second, narrower Fable 5.1 pass (separate from the school-readiness review
above) diagnosed the reward loop as "correct but flat" — every mode paid the
same +1 star with the same sound, and five of seven modes ended on a 1.8s
toast dumped straight to Home with no session summary. The owner approved all
8 proposed mechanics ("all 8 mechanics"). Screened for the difference between
compelling and manipulative throughout: no loss-framing, no purchasable
streak insurance, no chance-based reward, nothing visible to other students.
Built and verified live in a real browser this session (not just statically
traced) — see the star-math cross-check below.

**Mechanic 1, Session Wrap-Up** (`showSessionWrapUp`, new
`#screen-session-wrapup`): Spelling, Vocab Flip & Rate, Match the Meaning,
Word Scramble, and Smart Review now end on a results card — stars earned
this session, every word that leveled a medal, the best in-session streak,
and a "next time" line naming the word closest to its next medal — instead
of a toast to Home. **Play Again** relaunches the same mode on the same word
set directly. `showStars` is false whenever the session was `noStars`/
off-grade throughout (self-graded or wrong-grade) — frames around medals
instead of a stars tally that would read as a broken "0". Smart Review
previously had NO completion reward at all (`awardRoundCompletionBonus`
wasn't wired into its finish path); it now gets one, built by hand since
`reviewSession` is a flat single pass with no round/retry shape to reuse.
Each of the 5 session objects (`spell`, `vocab`, `vmatch`, `scramble`,
`reviewSession`) grew `starsThisSession`/`medalUps`/`bestStreak`/`wordSet`,
accumulated via `trackSessionResult()` called right after every
`recordAnswer()`. **Bug found and fixed during live testing**:
`trackSessionResult()` originally set `bestStreak` from `session.streak`
before the caller's own `.streak++`, so a session correct the whole way
through reported one less than its true best (11 instead of 12 on a 12-word
perfect run) — moved the `bestStreak` update to right after each mode's own
increment instead. **Second bug found and fixed**: the wrap-up's star tally
initially only summed `recordAnswer()`'s return value, missing every bonus
awarded via a separate `addStars()` call (bonus word, hot-streak milestones,
round-completion) — `awardRoundCompletionBonus`, `handleHotStreak`, and
`checkBonusWord` below now all add to `session.starsThisSession` themselves
when their own bonus actually pays. Verified live: a 12-word perfect
Spelling round showing "25 stars this round" cross-checked exactly against
12 base + 2 (streak-5) + 3 (streak-10) + 3 (bonus word) + 5 (perfect round).

**Mechanic 2, star fly-in + count-up** (`animateStarGain`, called from the
one `addStars()` choke point): a `+N` particle rises and fades from
`#header-stars`, and the header number ticks up over ~400ms instead of
snapping. `#header-stars` gained a nested `#header-stars-count` span so the
particle (appended as a sibling) survives the count-up's own `textContent`
writes. Skips straight to the final value under `prefers-reduced-motion`,
same posture as the existing buddy-animation media query.

**Mechanic 3, next-medal nudge** (`medalProgress`/`medalProgressText`, next
to `wordMedal`): mirrors `wordMedal`'s own thresholds to report how many more
correct answers a word needs for its next medal ("2 more for Silver"), or
"Keep it up for X" when the raw count is already there but accuracy isn't.
Gold reports nothing (nowhere left to go). Surfaced via `appendMedalNudge()`
on the correct-feedback line in Spelling/Match/Scramble/Smart Review (NOT
Flip & Rate — self-graded taps have no feedback box to hook into) and as a
small line per word on the Progress screen.

**Mechanic 4, hot-streak escalation**: the correct-answer chime's pitch
rises a step per in-session streak point, capped at 8 steps
(`playSound("correct", streakStep)` — `recordAnswer()` gained an
`opts.streakStep` parameter since it has no access to a mode's own streak
counter, which lives on the session object and increments AFTER
`recordAnswer()` returns; callers pass `session.streak + 1`, the value about
to become true). At streak 5/10/15 (`handleHotStreak`, `HOT_STREAK_BONUSES`)
a named burst fires with a small bonus (+2/+3/+4) routed through the
existing `awardCappedBonus` — shares the same 8/day round-bonus budget on
purpose, so it can't mint currency independently of every other bonus in
this file. `canPay: false` (self-graded/off-grade) skips the bonus AND the
burst sound entirely; the plain pitch-rise still plays regardless (feedback,
not currency). A streak of 5+ ending (a miss — the only place `.streak` gets
reset) now names what was achieved via `endStreak()`
("That was a 9-streak — nice!") — never that it ended or was lost.

**Mechanic 5, Bonus Word** (`pickBonusWord`, `checkBonusWord`,
`MAX_BONUS_WORDS_PER_DAY = 5`): one word per session (Spelling, Match,
Scramble — NOT Vocab Flip & Rate, which is always self-graded and can never
back up a payout, and NOT Test Mode, silent by design) is secretly worth +3,
weighted toward the profile's own weaker half via the existing
`wordsNeedingWork()` ranking rather than the single weakest word (keeps it a
real surprise). Revealed only on a correct answer — a miss is just a normal
miss, no reveal, no "you missed it" framing. If never reached, the wrap-up
screen (mechanic 1) names it after the fact: `"jump" — get it next time!`
via `bonusWordMissedNudge()`. Capped separately from the round-bonus budget
(`bonusWordsToday` on the activity doc, alongside `bonusRoundsToday`) so a
short list can't be farmed for repeated bonus draws.

**Mechanic 6, Gold the List** (`checkGoldTheList`, `GOLD_LIST_BONUS = 15`): a
one-time trophy per week when every word in `state.progress.words` reaches
Gold — checked against the FULL current week, never a session's own subset,
since completing the list is a whole-week event. Recorded permanently as
`profile.weekTrophies[weekId] = dateAwarded` (new field, threaded through
`sync.js`'s `pushProfile`/`migrateStudentIfNeeded`/`watchProfiles` allowlists
and `applyRemoteProfileUpdate`'s field list — same shape as `unlockDates`).
A `🥇 N of TOTAL Gold` line sits on Home under the existing week-progress
bar, flipping to `🏆 All Gold — earned <date>!` once banked. The Trophy
Shelf screen (added in the school-readiness pass) grew a "Gold Weeks"
section listing every earned trophy, week label looked up against the
currently loaded catalog (falls back to the raw id for a week the
family/class has since moved off of, rather than hiding an earned trophy).
Excluded from off-grade weeks via `offGradeWeek()`.

**Mechanic 7, Beat Your Best** (`recordTestResult`, `bestPriorScore`,
`RECENT_TESTS_MAX = 10`, up from 5): `profile.recentTests` entries gained a
`mode` field (`"test"` vs `"speed"`) so a swipe-graded Speed Quiz score can
never be compared against a real typed/checked Test Mode one — different
rigor, kept separate. Test/Speed results now show "Best: N%" for the
matching `weekId`+`kind`+`mode`, or "New best! 73% → 87%" on improvement.
On a tied or lower score, shows ONLY the existing best — never the current
number, never a delta, never a down-arrow. No line at all when there's no
prior comparable run (first attempt on that combination). Speed Quiz now
writes into `recentTests` too (it never did before this pass), which is
what makes its own "Best" comparisons possible at all.

**Mechanic 8, Earned Streak Shield** (`ensureStreakForToday`): every 7 days
of an active daily streak banks one shield, capped at holding 1
(`p.streakShields`, new field, threaded through the same sync allowlists as
`weekTrophies`). If exactly one day is missed AND a shield is held, it
auto-spends to continue the streak as if uninterrupted — free, automatic, no
purchase path, no shop entry, no player-facing toggle or countdown. Only
ever surfaces at the moment it saves something ("🛡️ Your shield kept your
streak going!") — never a warning about running low. This is the considered
alternative to a purchasable streak-freeze (the mechanic Duolingo gets
criticized for): earned by studying, not sold, and it removes the anxiety
point (the cliff) instead of selling insurance against it.

**Judgment calls**: mechanic 5's bonus is +3 (between the per-word +1 and
the milestone +2/+3/+4, deliberately not the biggest number in the file so
it reads as a nice surprise rather than the main event); mechanic 6's
display lives on Home (the ambient counter) + Trophy Shelf (the permanent
record) rather than a third new screen; mechanic 7's cap moved from 5 to 10
specifically so a week of practice can't evict the actual best score right
before a kid gets a chance to beat it. Gold-the-list's +15 and the daily
first-practice +3 are deliberately NOT counted in the wrap-up's
"stars this round" tally — both are day/week-scale bonuses with their own
toast, not literally "from this round," and folding them in would make the
number harder to reason about, not easier.

## Parked / not built

- **Mix-and-match dress-up** (equip a hat, then a torso, then a weapon onto one
  base) — still not built, and the character set above does not enable it. The
  reference sheet's accessory catalog is drawn at arbitrary scales and angles,
  not fitted to the base pose, so compositing those pieces reproduces exactly
  the floating-hat misalignment that killed the earlier hand-SVG rounds. This
  needs per-slot art generated against one fixed pose (an image model can do
  that; this session cannot) — then slicing and anchor-point work, not more
  hand-authored paths.
- **Simplified word-search mode** — scoped as a possible 7th study mode
  (batch 8–10 words, horizontal/vertical only) but ranked behind Word Scramble
  by effort; nothing built.
- **List 1** for Roman's Grade 7 catalog — never provided, not in the catalog.

## Privacy policy accuracy pass, accessibility fixes, and OCR photo import (2026-09-02)

Follow-up to a Fable 5.1 legal/privacy review the owner requested after the
gamification build. Three unrelated pieces of work, all small and all live.

**Privacy policy corrections** (`index.html`'s `#screen-legal`) — factual
fixes only, no new legal clauses added (a limitation-of-liability clause,
data-retention policy, etc. need an actual attorney, not an AI-drafted
addition — see the review's punch list, not repeated here). The policy
previously implied Firebase only activates "if a household chooses to turn
on sync"; in reality `Sync.init()` calls `signInAnonymously()` on load
regardless (`sync.js`), so the wording now says that plainly and clarifies
that nothing is WRITTEN to Firebase until a household code is actually
created/joined. Also added: a sentence disclosing the browser's own
speech-recognition service is used by the mic button (Google's on Chrome,
Apple's on Safari); a sentence naming GitHub Pages as host and Firebase as
a third party operating under Google's own terms; broadened "personal
family use" to "personal family or classroom use" in the Terms. The Class
Roster paste placeholder (`index.html`) changed from full names
(`Amelia Rivera, 5`) to first-name-only (`Amelia, 5`) to match the
policy's "first name or nickname" framing and nudge real usage toward
collecting less — `parseRosterText()` only ever splits on the first comma,
so this needed no parser changes.

**Accessibility fixes**, all found by reading the code, not a full audit:
icon-only header/mic buttons (`btn-home`, `btn-mute-toggle`,
`btn-switch-profile`, the three `*-mic` buttons) now carry `aria-label` in
addition to `title`; `refreshMuteButton()` flips its label between "Mute
sounds"/"Unmute sounds" with state instead of a static string. Every
per-mode feedback div (`spell-feedback`, `review-feedback`,
`vmatch-feedback`, `scramble-feedback`) and the shared `#toast` now carry
`role="status" aria-live="polite"`, so correct/incorrect feedback and every
toast reach a screen reader — deliberately did NOT make the header star
count live, since its count-up animation would spam-announce every
intermediate value. Word Scramble's filled answer slots
(`renderScrambleTiles()`) are now real `<button>`s with an
`aria-label="Remove letter X"` instead of `div`s with a click handler, so
`removeFromAnswer` is keyboard-reachable the same way bank tiles already
are; empty slots stay plain `div`s (nothing to activate). Nine
placeholder-only inputs across profile creation, roster import, and parent
self-manage got matching `aria-label`s. `showScreen()` now moves focus to
the new screen's `h1`/`h2` (every screen has one) via a scripted
`tabindex="-1"` — silent to a mouse/touch user (`:focus-visible` doesn't
ring a programmatically-focused element), but a screen-reader/keyboard
user is no longer left on a heading that's no longer there. Contrast:
`--muted` moved from `#6b7280` (~4.3:1 against `--bg`, just under AA's
4.5:1) to `#4b5563` (~6.7:1); `.streak-banner-text` and
`.home-recommend-label` moved from `color: var(--accent)` (~2:1 against
`--bg` — accent is a highlight color, never vetted as text) to
`var(--primary-dark)`, which this app already trusts as body text
(`.definition-box`, `.vmatch-choice`) — Galaxy theme gets its own override
back to `var(--accent)` for those two selectors specifically, since its
dark background needs a LIGHT accent-as-text, not a darker one (same
reasoning as Galaxy's existing `--text`/`--card`/`--border`/`--muted`
overrides above).

**OCR photo import** (`js/app.js`, `index.html`'s catalog editor,
Tesseract.js 5.1.1 pinned from jsdelivr) — a teacher can now tap
"📷 Scan a Photo" in Manage Word Catalog to OCR a photo of a word list
entirely client-side (WASM in the browser; the photo never leaves the
device, so this adds no backend and no new attack surface, matching the
app's architecture). The extracted text only ever FILLS the existing paste
box — never auto-parses or auto-saves — because OCR on a photographed
workbook page (this curriculum's own multi-word entries like
"1 and 2 Samuel" included) isn't reliable enough to trust unread; it goes
through the exact same preview → edit → save flow a manual paste already
does. Guards against `Tesseract` being undefined (CDN didn't load, e.g.
offline) with a toast rather than a crash. Verified live end-to-end
against a real generated test image (three words, clean font) with 100%
extraction accuracy and zero console errors; real workbook photos will be
noisier, which is exactly why the review step stays mandatory. This is a
deliberate, documented exception to `app.js`'s "no external library"
confetti comment (which was about not needing one for a simple canvas
effect, not a hard rule) — the app already loads Firebase from
`gstatic.com`, so this isn't a new category of dependency, just one more
pinned CDN script.

## OCR auto-rotation: the scan feature was untestable on real photos (2026-09-02)

**The bug.** The first real-world use of "📷 Scan a Photo" returned pure
noise — pages of `L = y CY - 8 = Pr hk`. Not a bad scan; no recoverable
words at all. The photo was a workbook page shot with a phone held
sideways, which is how anyone holding a book in one hand takes the shot.

**Root cause.** Tesseract only reads text running left-to-right. It has no
built-in orientation detection in the LSTM-only build tesseract.js 5 ships,
so a page rotated 90° isn't read badly — it isn't read at all. EXIF does
not rescue this: EXIF records how the *phone* was held, not how the *page*
sat under it. The test photo carried EXIF orientation 3 (180°), and even
after honoring that tag the page still needed a further 270° turn.

The previous entry above states this was "verified live end-to-end… with
100% extraction accuracy" — against a *generated* upright PNG. That test
could never have caught this, and its passing gave false confidence in a
feature that failed on the first real input. **A camera feature has to be
tested against a real camera photo, EXIF and all.**

**The fix** (`js/app.js`): decode with EXIF applied
(`createImageBitmap(file, {imageOrientation:"from-image"})`, `<img>`
fallback), OCR a 1000px copy at all four right-angle rotations, keep the
highest-confidence angle, then re-read at full resolution through one
reused worker (`Tesseract.recognize()` builds and tears down a worker per
call — five of those would dominate the runtime).

**Measurements**, taken on the actual failing photo (4032×3024), first in
Node and then re-confirmed in Chrome against the shipped code paths:

| | result |
|---|---|
| probe confidence, correct angle vs. other three | 48 vs 26–30 (unambiguous) |
| target words recovered, before → after | ~0/33 → 22/33 |
| full-res vs. 2400px final pass | 26/33 vs 20/33 |
| grayscale + autocontrast | 22/33 (worse — dropped) |
| runtime, desktop Chrome | 4.4s probe + 3.4s final |

Two counter-intuitive results worth keeping: **don't downscale the final
pass** (accuracy tracks resolution, and confidence does *not* — it moved
only 61→64 across a drop that cost six words, so confidence is a good
orientation comparator and a bad accuracy gauge), and **don't preprocess**
— grayscale/autocontrast scored worse than the untouched photo.

**Still imperfect, by nature.** The bottom third of the test page is
warped by page curl and camera angle and reads poorly at any rotation
(`tropics` → `Quatoy`). Rotation fixes orientation, not perspective. The
review-before-save step therefore stays mandatory, and the hint text now
says a flat, straight-on shot reads best.

## Scan no longer stacks a failed scan on top of the last one (2026-09-02)

Scanning always appended: `box.value + "\n\n" + text`. After a scan that read
badly, the natural move is to retry — and the retry's text landed *underneath*
the previous garbage. You scroll to the box, see the same gibberish on top, and
conclude the fix didn't work. This wasted a full debugging round on exactly that
misread, on top of the undeployed-fix problem below.

Appending is still right for the real multi-page workflow (scan page 1, scan
page 2), so this doesn't just switch to replace. Instead: when the box already
has text, tapping Scan asks "Add to it / Replace it / Cancel" first. An empty
box skips the prompt entirely. Replace stashes the old value and offers "Undo
replace" in the status line, so a bad scan can't cost text it landed on.

Verified in the real app (not a harness) by stubbing the file input's `click()`
so no OS dialog blocks, then feeding generated images through the actual change
handler: empty box → no prompt, picker opens; filled box → prompt, picker does
NOT open; Add to it → "PREVIOUS TEXT kitten"; Replace it → "puppy" alone plus an
Undo button; Undo → "PREVIOUS TEXT kitten" restored.

### The deploy lesson

The rotation fix in the previous entry was committed and reported as done, but
never pushed. GitHub Pages kept serving the old bundle, so the user retested the
identical bug twice and reasonably concluded the fix had failed. Confirmed by
fetching the live file: `curl .../js/app.js | grep -c decodeOriented` returned 0.

**A fix to this app is not done when it is committed — it is done when it is
pushed, because the only place it runs is GitHub Pages.** When someone reports
"still broken," check what is actually deployed before re-debugging the code:
that one curl would have saved the whole round.

Also worth recording, since it narrows future OCR debugging: tesseract.js *does*
honor EXIF when handed a `File` directly. An upright-displaying photo with
sideways stored pixels scored 24/33 words on the OLD code. So EXIF was never the
bug — page orientation within the frame was.

## The one parameter that fixed the scan: PSM 11 (2026-09-02)

Asked whether the numbered words could be pulled out and spell-checked, then
whether anything short of an LLM would help. Measuring beat both guesses: the
fix was a single Tesseract parameter, not a parser and not a vision model.

Tesseract defaults to page segmentation mode 3, "fully automatic", which models
the page as flowing prose. A workbook page is not prose - it is short numbered
entries in three columns wrapped around illustrations - so mode 3 merged text
across the column gutters (`1. submarine illiantly`) and dropped whole entries.
**Mode 11, "sparse text", finds words anywhere without assuming paragraphs.**

Measured on the failing photo against the page's 33 known words:

| variant | words |
|---|---|
| psm 3 (the shipped default) | 23/33 |
| psm 4 (single column) | 22/33 |
| psm 6 (uniform block) | 26/33 |
| **psm 11 (sparse text)** | **29/33** |
| psm 11 + 1.5x upscale | 27/33 |
| psm 11 + Sauvola adaptive threshold | 27/33 |

Same runtime. In-browser end-to-end the number is 27/33 (browser JPEG decode and
canvas resampling differ slightly from PIL's), up from 22/33 before. Mode 11 also
made the orientation probe *more* decisive - upright scored 60 against 29-34,
where an explicit mode 3 probe picked the wrong way up in one run - so both the
probe and the final pass use it.

Rejected by measurement, recorded so they don't get retried: 1.5x upscaling,
Sauvola adaptive thresholding, and grayscale + autocontrast (22/33) all scored
worse than the untouched photo. Preprocessing is not the lever here.

### A parser was the wrong instinct

Before finding this, a geometric extractor was prototyped: take each `N.` marker
from the word-level bounding boxes, grab the words to its right up to the column
gutter, cluster into columns, keep the longest increasing run. It reached 20/35 -
below the 24/35 ceiling set by how many words Tesseract read at all. The lesson:
**when extraction is lossy, fix the recognizer before writing a parser for its
output.** Mode 11 also emits one entry per line, which is what the parser was
being built to reconstruct, so the parser became unnecessary.

Spell-check was also considered and rejected on the merits: it cannot recover a
word the OCR never saw, and it is actively unsafe for a spelling app. The real
misread was `daily` -> `dally`, and `dally` is a real English word - a spell
checker passes it silently, converting an honest gap into a confident wrong word
taught to a child. `subtrahend` is the mirror risk: real but rare, so a
dictionary may "correct" it to something wrong. Flag low confidence; never
auto-correct a spelling list.

## Sorted numbered-word extraction, and what targeted cropping is actually for (2026-09-02)

Even with mode 11 reading well, the box still received the whole page: ~156
lines of which only ~19% carried a real list word. The read was fine; the
*output* was the problem. When the page is a numbered list, reading the
numbers lets us emit just the words in the page's own order and drop the
other ~127 lines.

**How it works** (`js/app.js`): parse `N.` markers line-by-line (mode 11 puts
one entry per line, so no bounding-box geometry is needed), repair
digit-lookalikes in the marker (`I.` -> `1.`), then resolve collisions by
neighbour proximity - a real entry sits within a few lines of its own n-1/n+1,
while the decorative `1. might` two columns over sits near nothing. That
neighbour rule is what finally got item 1 right; ranking on OCR confidence had
picked the decoration.

**Two passes, merged.** Mode 11 (sparse text) reads the list; mode 6 (uniform
block) reads the warped lower half better. Merging took the sorted list from
23 to 25 of the page's 33 known entries. Where the passes disagree, or the
word fails a shape test, the entry is flagged in the status line rather than
silently resolved.

**The numbering must not reach the box.** `parseCatalogText` turns each whole
line into one word, so writing `1. submarine` would create a catalog word
literally called "1. submarine". Only the words are written; the numbers drive
ordering and the "couldn't read numbers 17, 24, 25..." gap report.

End-to-end in Chrome on the original failing photo: 27 entries, 24 correct, in
order, importable - against a wall of noise before. Cost is ~17s on desktop
(four probes plus two full-resolution passes), up from ~7s.

### Known failure mode

A misread marker can put a wrong word in a *correct-looking* slot: `33. torrid`
lost its second digit and landed in slot 3, displacing `subtitle`. The shape
check flagged it ("Orrid"), but the displaced word is silently gone rather than
reported as a gap. Flags catch it; the gap report does not.

### Targeted cropping - measured, and it is not an accuracy fix

Tested cropping to the list region and to the warped vocabulary region, each at
1x/2x/3x:

| | words | signal |
|---|---|---|
| full page | 23/23 spelling words | 156 lines, 19% carry a real word |
| cropped list | 20-21/23 | 50 lines, 40% |
| cropped vocab, 2x | 6/10 vocab (recovers `estuary`) | 48 lines, 13% |

Cropping **lowered** word recall - the full page already reads the spelling
list 23/23, and a crop changes the local statistics Tesseract thresholds
against. What it does buy is signal density: junk drops from ~127 lines to
~30. But the numbered extraction above removes that noise anyway, without
asking anyone to draw a box. So a crop UI is a nice-to-have for pages the
parser cannot handle, not the fix for this one. Do not build it expecting
better recognition.
