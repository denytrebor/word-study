# Word Study — Handoff Document

_Last updated: 2026-08-25_

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
  (state, screens, all 6 study modes, gamification). `js/sync.js` wraps
  Firebase. `js/shop-catalog.js` is static avatar/theme data.
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
(parent-led swipeable flashcards) · Word Scramble (tile-drag spelling).

## Gamification (fully shipped per `docs/gamification-parent-mode-spec.md`)

Word mastery medals (bronze/silver/gold, derived from stats, never stored) ·
daily streaks + activity tracking · star shop (24 avatars, 6 themes) ·
celebrations (confetti/chimes, mute toggle) · PIN-gated parent dashboard
(read-only, local-storage-first with Firestore fallback). Explicit non-goals:
leaderboards, badges, weekly goals, teacher dashboard.

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

- **Dress-up avatar shop upgrade** — explored via two rounds of hand-SVG
  Claude Artifact mockups, hit a real quality ceiling on hand-authored base
  art (see the memory record for links/details). Explicitly parked, live app
  untouched, only pick back up if the user says so.
- **Simplified word-search mode** — scoped as a possible 7th study mode
  (batch 8–10 words, horizontal/vertical only) but ranked behind Word Scramble
  by effort; nothing built.
- **List 1** for Roman's Grade 7 catalog — never provided, not in the catalog.
