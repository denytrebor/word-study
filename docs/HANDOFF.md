# Word Study — Handoff Document

_Last updated: 2026-08-26_

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

Look & Say (TTS flashcards) · Spelling Practice · Vocab Practice · Test Mode
(one pass, max 2 replays, no feedback until the end) · Speed Quiz
(parent-led swipeable flashcards) · Word Scramble (tile-drag spelling) ·
Smart Review (weakest words across every week practiced — see Usability
features below; the only mode not scoped to a single week).

## Gamification (fully shipped per `docs/gamification-parent-mode-spec.md`)

Word mastery medals (bronze/silver/gold, derived from stats, never stored) ·
daily streaks + activity tracking · star shop (72 illustrated characters
across a standard and a "chase" tier, 24 emoji avatars, 6 themes), fully
parent-configurable via Manage Avatars (see below) · celebrations
(confetti/chimes, mute toggle) · PIN-gated parent dashboard (read-only,
local-storage-first with Firestore fallback). Explicit non-goals:
leaderboards, badges, weekly goals, teacher dashboard.

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
character — a code like `zoelive/weeks/7-w1` doesn't create a catalog with a
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
`starter-lists.js` is hand-authored content, not generated.

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
to a grade picker (Grades 1–8, 3 weeks × 12 words each — 8 spelling-only + 4
vocab-with-definition, matching the existing Abeka-style convention so every
mode including Vocab Practice works immediately).

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
there. HANDOFF's earlier note says the real `zoelive` catalog predates the field
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
`9S6NU3`/`zoelive`), or serve `docs/`/the repo root locally via
`python -m http.server` for a quick smoke test before deploying. Firestore
rules allow `create`/`update` on household docs but **not `delete`** — a
throwaway household can't actually be cleaned up after testing; leaving an
orphaned empty household code around is harmless (no PII, just consumes one
random 6-char code) and is the accepted cost of that testing pattern.

## Current family data (real, live — do not touch as test cleanup)

**Household `9S6NU3`**, catalog code **`zoelive`**:

| Profile | Role | Grade | Notes |
|---|---|---|---|
| Micah | student | 5 | Abeka spelling/vocab, 1 week loaded |
| Robert | student | 5 | Abeka spelling/vocab, same catalog as Micah |
| Roman | student | 7 | Wordly-Wise-style workbook, Lists 2–10 loaded (see below) |
| Candice | parent | — | PIN-protected dashboard access |
| Candice | parent | — | **Duplicate profile, same name** — not investigated or cleaned up, flagged to the user, no action taken |

**Roman's Grade 7 catalog** (`catalogs/zoelive/weeks/7-w1` … `7-w9`): 9 weeks,
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
real Firestore, throwaway households only, never `9S6NU3`/`zoelive`:
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
