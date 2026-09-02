# Spec: Tier 1 Gamification + Parent Mode

**Status:** approved for implementation — not yet built
**Author:** architecture session 2026-08-24
**Implementer notes:** read `README`-level context in the memory file / commit history first. This spec is written to be executed by an agent with no prior context on this codebase. Follow it closely; where it says MUST, that guard exists because of a real bug we already hit once.

---

## 0. Context: what this app is

A vanilla-JS PWA (no build step, no framework) at `denytrebor.github.io/word-study`, source in this repo. Kids practice weekly Abeka spelling/vocab word lists in 6 study modes. Data syncs via Firebase (Firestore + Anonymous Auth, project `spelling-words-671aa`, free Spark plan).

**Data model today:**

- `households/{code}` — one family. Code is the only access control (rules just check `request.auth != null`), so anyone with a household code has full read/write on that household. This is accepted for family-scale data.
  - `.catalogCode` — points at the shared word catalog
  - `profiles/{profileId}` — `{name, avatar, stars, grade}`
    - `progress/{weekId}` — `{weekId, grade, label, words: [{id, text, definition, spelling: {attempts, correct}, vocab: {attempts, known}}]}`
- `catalogs/{catalogCode}/weeks/{weekId}` — shared word lists (grade + week + words). Deliberately a separate top-level collection so sharing a catalog code can NEVER expose a household's scores. **Do not add any per-student data under `catalogs/`.**

**Live production data exists:** household `9S6NU3`, catalog `zoelive`, profile "Micah" (grade 5). Migrations MUST be backward-compatible with existing profile docs (missing new fields must default sanely — the codebase's `load(key, fallback)` / `|| 0` idioms already handle this pattern; keep doing that).

**Files:** `index.html` (all screens as `<section class="screen">`), `css/style.css` (design tokens as CSS custom props on `:root`), `js/app.js` (one IIFE, screen-per-section pattern), `js/sync.js` (`Sync` module wrapping Firestore), `service-worker.js` (network-first; **bump `CACHE_NAME` version on every release**).

**Hard-won invariants — violate these and you will reintroduce real data-loss bugs we already fixed:**

1. **Self-echo guard:** every `onSnapshot` listener filters `snap.metadata.hasPendingWrites`. Any new listener MUST do the same.
2. **Safe-apply guard:** remote data may only replace in-memory state (`state.progress`, and now anything you add) while the active screen is Home or Progress — never mid-study-session or mid-edit. See `applyRemoteProgressUpdate` for the pattern.
3. **Post-commit lock:** any auto-checking interaction (see Word Scramble's `scramble.locked`) MUST lock after committing a result so repeat taps can't double-count stats/stars.
4. **Local dates only:** all calendar-date math uses `dateToLocalStr()` / `todayLocalStr()` helpers in app.js — never `toISOString()` for dates (timezone bug we fixed).
5. Push with `git -c credential.helper= -c credential.helper="!gh auth git-credential" push origin master` (plain `git push` hangs on this machine). Test everything locally (python http.server + browser) before pushing; bump SW cache version.

---

## 1. Goals

Make daily practice self-motivating for kids aged ~8–13, and give parents visibility, replacing Quizlet for: 2 kids + 2 cousins now, potentially a ~50-student private school later. Four features, in build order:

1. **Word mastery medals** (bronze/silver/gold per word)
2. **Daily streak** (days-in-a-row practiced) + activity tracking (also feeds parent mode)
3. **Star Shop** (spend stars on avatars & themes)
4. **Celebrations** (confetti, sounds, milestone moments)
5. **Parent Mode** (PIN-gated dashboard: per-kid scores, usage, readiness)

Build and TEST each feature before starting the next. Each section below has acceptance criteria.

**Non-goals (do NOT build):** leaderboards, badges/achievements, weekly goals, teacher dashboards, streak freezes, any real authentication. These are later tiers. **Update, 2026-09-02:** streak freezes and a weekly-goal-shaped mechanic WERE eventually built (see §2's "Second gamification pass" bullet and `docs/HANDOFF.md`'s "Gamification, round 2") — deliberately not the rejected shapes, though. "Streak freeze" here meant a purchasable one (Duolingo's model); what shipped is an earned, automatic, unpurchasable shield with no shop entry. The weekly-goal-shaped one ("Gold the List") isn't a goal a parent/teacher sets — it's the medal system's own existing Gold threshold, aggregated to the week level.

---

## 2. Feature: Word mastery medals

### Definition

A word's medal is **derived** (pure function — do not store it) from its existing per-word stats within the current week's progress doc:

```
totalCorrect  = spelling.correct + vocab.known
totalAttempts = spelling.attempts + vocab.attempts
accuracy      = totalAttempts ? totalCorrect / totalAttempts : 0

gold:   totalCorrect >= 8 AND accuracy >= 0.90
silver: totalCorrect >= 5 AND accuracy >= 0.80
bronze: totalCorrect >= 2
none:   otherwise
```

Implement as `wordMedal(w)` next to the existing `wordStatus(w)`; `wordStatus` stays (parent mode uses both).

### UI

- **Progress screen:** replace/augment the status icon with the medal: 🥉/🥈/🥇 (none = current ⚪). Keep the "Looking good / Needs practice" text.
- **During practice (all modes with a correct/incorrect moment):** when an answer causes a word to *cross a medal threshold*, show a celebration (see §5) and a toast: “🥈 ‘necessary’ leveled up to Silver!”. Detect by computing medal before and after the stat increment.
- **Home screen:** under the word count, add a medal summary line: `🥇 3 · 🥈 7 · 🥉 12` for the selected week.

### Star economy change (anti-farming)

Today: +1 star per correct answer, unbounded. Change to:

- Correct answer on a **non-gold** word: **+1 star** (unchanged).
- Correct answer on a word that was **already gold before this answer**: **+0 stars** (stats still increment; the UI should NOT show a sad message — just no star tick. Kids will discover gold words are "done" and move to shaky ones, which is the point).
- **Per-word daily cap:** a single word can award at most **3 stars per local calendar day** regardless of medal. Track in the daily activity doc (§3) as `starEarns: {wordId: count}`; check before awarding.
- **New bonuses** (these make events feel big and offset the caps):
  - Perfect first round of any session (no misses, ≥4 words): **+5 stars**
  - Completing a retry round (clearing all missed words): **+2 stars**
  - First session of the day (first answer recorded today): **+3 stars**
  - Daily streak milestone reached (3, 7, 14, 30, 60, 100 days): **+5, +10, +15, +25, +40, +75**
- **Round-bonus daily cap:** unlike the per-word cap above, perfect-round/retry-clear/perfect-test bonuses aren't tied to a word, so a short list replayed on repeat (exit → re-enter → answer the same known words) could mint stars forever. Cap the perfect-round (+5), retry-clear (+2), and perfect-test (+5) bonuses combined at **8 paid bonuses per local calendar day**, tracked as `bonusRoundsToday` on the activity doc (§3). Past the cap the round still completes and celebrates (toast/sound/confetti) — it just stops naming a star amount, so hitting the cap reads as "no more bonus today," never as broken.
- **Self-graded and off-grade answers pay no stars at all** (2026-09-01, see `docs/HANDOFF.md`'s "Anti-farming, round 2"): Flip & Rate's "I Knew It", Speed Quiz's "Got It" (either kind), and Vocab Test's "I Knew It" are self-reported, never checked — `recordAnswer(w, correct, statKind, { noStars: true })`. A week browsed from the week picker that doesn't match the profile's own grade also pays nothing (`offGradeWeek()`), so a student can't farm an easier grade's list. Stats and medals still update in both cases — only the currency/streak/goal side is cut off. Round-completion bonuses take a matching `canPay` argument so the same rule reaches perfect-round/retry-clear bonuses, not just per-answer stars.
- **Second gamification pass (2026-09-02, see `docs/HANDOFF.md`'s "Gamification, round 2")** layered 8 more mechanics on top of everything above — a Session Wrap-Up screen, star fly-in/count-up, a next-medal nudge, hot-streak escalation, a Bonus Word, a "Gold the List" weekly trophy, "Beat Your Best" on test results, and an earned/automatic streak shield. Every new bonus routes through the SAME `awardCappedBonus`/`canPay` gates this section defines — none of it is a parallel economy. Full detail lives in HANDOFF.md, not duplicated here.

All star mutations continue to flow through `addStars(n)` — extend it, don't fork it.

### Acceptance criteria

- Practicing a gold word increments its stats but not stars.
- The 4th star-earning correct on one word in one day awards nothing.
- Medal-up toast + celebration fires exactly once per threshold crossing (guard with the pre/post computation, not a stored flag).
- Progress and Home render medals correctly for the existing live profile (Micah) whose words currently have stats — verify thresholds compute sensibly against real data.

---

## 3. Feature: Daily streak + activity tracking

This is one system serving two consumers: the kid-facing streak and the parent dashboard.

### Data model

New subcollection: `households/{code}/profiles/{profileId}/activity/{YYYY-MM-DD}` (doc ID = local date string):

```
{
  date: "2026-08-24",          // same as doc id
  answers: 41,                  // total answer events (correct + incorrect)
  correct: 35,
  starsEarned: 18,
  starEarns: { wordId: n, … }, // per-word daily star cap tracking (§2)
  bonusRoundsToday: 3,          // round-completion bonuses paid today, capped at 8 (§2)
  modes: { spelling: 2, vocab: 1, scramble: 1, test: 0, speed: 0, flashcard: 1 }, // session-starts per mode
  weekIds: ["5-w1"],           // which catalog weeks were practiced
}
```

Cached on the profile doc (for cheap rendering; activity docs are the source of truth):

```
currentStreak: 4,
bestStreak: 9,
lastActiveDate: "2026-08-24",
recentTests: [ {date, kind: "spelling"|"vocab", pct, weekId} ]  // last 5, newest first
```

### Write strategy (quota-aware)

Keep an in-memory activity object for today, mutated on every answer. **Flush** (Firestore `set` with merge + local mirror in localStorage under `ws_activity_{profileId}_{date}`) at these moments only: session end (exit/complete), every 10th answer, `visibilitychange`→hidden, and mode-start (to record the `modes` increment). Do NOT write per-answer — at family scale it wouldn't matter, but this pattern must survive 50 students on the free tier's 20K writes/day.

Streak computation: on profile select, read `lastActiveDate`/`currentStreak` from the profile doc; when the first answer of a local day is recorded — if `lastActiveDate` is yesterday → `currentStreak++`; if today → no change; else → `currentStreak = 1`. Update `bestStreak = max(...)`. Push via existing `pushProfile`. (Trust the cache; a full recompute from activity docs is a nice-to-have repair path, not required.)

`recentTests`: on Test Mode completion, unshift `{date, kind, pct, weekId}`, trim to 5, save via `pushProfile`.

### UI

- **Home screen:** a streak banner above the menu grid: `🔥 4-day streak!` with the last 7 days as dots (Mon–Sun, filled = practiced, today highlighted). If streak is 0: “Practice today to start a streak!”
- **Header:** unchanged (stars only) — don't crowd it.
- Streak milestone crossings trigger celebration + bonus stars (§2).

### Sync notes

- The new `watchProfile` payload will now carry streak fields — the existing `applyRemoteProfileUpdate` must merge them under the same safe-apply guard (invariant 2).
- Do NOT add an `onSnapshot` on activity docs; parent mode reads them on demand (§6).

### Acceptance criteria

- Two sessions same day → streak unchanged after the first; answering on the next local day → streak +1; skipping a day → resets to 1 on next practice.
- Activity doc for today exists in Firestore after a session with correct counts, and survives page reload (local mirror merges, not overwrites, on flush).
- Streak survives device switch (cached fields sync via profile doc).

---

## 4. Feature: Star Shop

### Catalog (static, in code — `js/shop-catalog.js` or a const in app.js)

- **Avatars** (~24): keep the current 10 free (they're the default rotation), add ~14 purchasable emoji avatars with escalating prices: 6 at **25⭐** (e.g. 🐙 🦖 🐉 🦅 🐺 🦈), 5 at **60⭐** (e.g. 🚀 🧙 🦸 🤖 👑), 3 at **150⭐** (e.g. 🌈 ⚡ 🔥 — "legendary", visually flagged).
- **Themes** (6): each is a named set of CSS custom-property overrides applied via `data-theme="<id>"` on `<html>` — `--primary`, `--primary-dark`, `--accent`, `--bg` (keep text/card colors shared so contrast stays safe). Default (current indigo) is free. Purchasable at **40⭐** each: Ocean (teal/blue), Forest (green), Sunset (orange/pink), Galaxy (deep purple/near-black bg with light text — check contrast!), Bubblegum (pink), Gold (amber — price this one **120⭐** as a flex item).

### Data model (profile doc additions)

```
unlocks: ["avatar:rocket", "theme:ocean", …],   // ids namespaced by kind
equippedAvatar: "🚀",                            // replaces `avatar` usage at display time; fall back to legacy `avatar` field
equippedTheme: "ocean" | undefined,
lifetimeStars: 231,                              // monotonically increasing; `stars` becomes the SPENDABLE balance
```

Migration rule: on first load of a profile without `lifetimeStars`, set `lifetimeStars = stars`. From then on `addStars` increments both; purchases decrement only `stars`. Header shows spendable `stars`. (Lifetime is there so future levels/badges never conflict with spending; surface it subtly in the shop: “All-time: 231 ⭐”.)

### UI

- New screen `screen-shop`, entered from a **🛍️ Star Shop** menu card on Home (add to grid).
- Two sections (Avatars, Themes). Each item card: emoji/swatch, price, and one of three states — **Owned → tap to equip** (equipped item shows a ✓ ring), **Affordable → tap to buy** (confirm dialog: “Buy 🚀 for 60 ⭐?” using the existing `confirm()` idiom), **Too expensive → dimmed with price**.
- Purchase: deduct, add to `unlocks`, auto-equip, celebration (§5), `pushProfile`.
- Theme applies instantly and persists (apply on profile select from `equippedTheme`).

### Concurrency note

Two devices spending the same balance simultaneously can double-spend — acceptable at family scale, last-write-wins via existing profile sync. Document with a code comment; do not build resolution machinery.

### Acceptance criteria

- Buying updates balance immediately, survives reload and appears on a second device (verify via Firestore console or two tabs).
- Equipped avatar shows in header + profile picker (fallback to legacy `avatar` when `equippedAvatar` absent — Micah's existing doc must keep working untouched).
- Theme changes recolor primary/accent/bg everywhere with readable contrast; default theme needs no `data-theme` attribute.
- A profile with 0 stars can browse, equip owned items, and buy nothing.

---

## 5. Feature: Celebrations (juice)

### Confetti

Write a tiny self-contained canvas confetti (~60–80 lines, no external library — the SW/CSP posture is no-CDN): a fixed-position full-viewport canvas created on demand, ~80 particles, gravity + drift + rotation, auto-removes after ~2.5s. Expose `celebrate(intensity)` with `"small" | "big"`.

### Sounds

WebAudio-synthesized (no audio files): short ascending two-note chime for correct-ish events, a brighter three-note arpeggio for big events. Expose `playSound(kind)` with `"correct" | "medal" | "purchase" | "streak" | "perfect"`. **Mute toggle**: a 🔇/🔊 icon button in the header next to the switch-profile button; persisted in `localStorage` (`ws_muted`), default **unmuted**. All sound calls are no-ops when muted or when `AudioContext` is unavailable. iOS note: instantiate/resume the `AudioContext` lazily inside a user-gesture handler (first tap), or sounds will silently fail on iPad.

### Trigger map

| Event | Confetti | Sound |
|---|---|---|
| Correct answer (any mode) | – | `correct` (keep it subtle) |
| Word medal-up | small | `medal` |
| Perfect first round (session) | big | `perfect` |
| Retry round cleared | small | `perfect` |
| Test result ≥ 90% | big | `perfect` |
| Shop purchase | small | `purchase` |
| Streak milestone | big | `streak` |

### Acceptance criteria

- No console errors when AudioContext is blocked/absent; mute persists across reloads; confetti never blocks input (canvas `pointer-events: none`) and cleans itself up (no leaked canvases after 10 triggers).

---

## 6. Feature: Parent Mode

### Concept

A parent is a **profile with `role: "parent"`** in the same household — no new auth. A 4-digit PIN gates the dashboard *as a child-proofing speed bump, not security* (anyone with the household code can read the data anyway; add a code comment saying exactly this so nobody mistakes it for a security boundary).

### Data model (profile doc)

```
role: "parent" | undefined (undefined = student — all existing profiles),
pin: "4831",        // parent only; plain string, 4 digits
```

Parent profiles have no grade, no stars, no streak, no progress subcollection.

### Flows

- **Create:** On the profile screen, below the student form, a quiet link-style button: “👨‍👧 Add a parent”. Tapping reveals name + 4-digit PIN fields (numeric, `inputmode="numeric"`, `maxlength=4`) + Create. Pushes profile with `role:"parent"`.
- **Profile picker rendering:** student cards unchanged; parent profiles render in a separate row beneath, smaller, with a 🔒 badge. `pushProfile`/`watchProfiles` in sync.js must round-trip the `role` and `pin` fields (extend the field lists in both).
- **Enter:** tapping a parent card prompts for PIN (simple inline input on the picker, not `prompt()`); 3 wrong attempts kicks back to picker. Correct PIN → `screen-parent-dashboard`. Selecting a parent must NOT run the student `selectProfile` path (no catalog/week/progress load, no `ACTIVE_KEY` persistence — parents re-enter PIN each visit; do not auto-resume into parent mode on app open).

### Dashboard screen (`screen-parent-dashboard`)

Header shows parent name + a plain Exit (back to picker). Then **one card per student profile** in the household, each showing:

1. **Identity row:** avatar, name, grade, ⭐ spendable / lifetime, 🔥 current streak (+ best).
2. **Usage:** last practiced (“today / yesterday / Aug 20 / never”), this week's practice dots (Mon–Sun, from activity docs), total answers + accuracy this week, most-used mode this week.
3. **Current week readiness:** selected/auto week label; medal summary (🥇n 🥈n 🥉n ⚪n); the **words that need work** — list every current-week word that is `shaky` or unpracticed, worst first (sort by accuracy ascending, unpracticed last). This is the “what to drill before Friday” panel — it's the single most parent-valuable element, make it prominent.
4. **Recent tests:** the `recentTests` array — date, Spelling/Vocab, score %; color the % (≥90 green, ≥70 amber, else red).

**Data loading:** on dashboard open, for each student: profile doc (already synced), this week's progress doc (`Sync.fetchProgress`), and the last **7 days** of activity docs via a new `Sync.fetchActivityRange(profileId, fromDate, toDate)` (7 point-reads per kid using known date-string ids — do NOT use a collection query; with ≤50 students × on-demand parent views this stays trivially inside quota). No live listeners on the dashboard; add a “Refresh” button instead. Show a lightweight loading state per card.

**Read-only in v1.** No editing kids' data, no goal-setting, no PIN recovery (a forgotten PIN is fixed by creating a new parent profile; note this in the create-UI hint text).

### Acceptance criteria

- A parent profile never appears with stars/streak in the student picker area, never triggers study-mode code paths, and app reload lands on the picker (not the dashboard).
- Wrong PIN ×3 returns to picker; correct PIN opens dashboard listing ONLY student profiles (a second parent profile must not get a card).
- Dashboard renders correctly for a student with zero activity (all “never/0” states) and for Micah's real data.
- Kid devices are unaffected: existing student flow untouched end-to-end (regression-test one full study session after this feature).

---

## 7. Build order, testing, release

1. §3 activity/streak plumbing first (medals' star caps depend on the activity doc), but ship UI in this order per feature: **§2 medals → §3 streak UI → §5 celebrations → §4 shop → §6 parent mode.** One feature per commit, tested locally in a real browser (the repo's established workflow: `python -m http.server`, click through with cleared localStorage AND with a simulated existing profile) before moving on.
2. Never test against the live household `9S6NU3`/catalog `zoelive` — create throwaway households, then delete them from the Firestore console when done (established practice).
3. Bump `CACHE_NAME` in `service-worker.js` once per push (not per feature).
4. Update the Firestore security rules ONLY if you add a collection outside existing matched paths — `activity/{date}` sits under `profiles/{profileId}`, which is already covered by the recursive match? **Check this:** the current rules match `progress/{weekId}` explicitly, not a wildcard under profiles. You WILL need to add an `activity/{date}` match block mirroring the `progress` one (auth-only). Rules are edited in the Firebase console (Firestore → Rules) — same auth-only shape as existing blocks.
5. After all features: run one end-to-end pass as a fresh family (create household → parent → kid → import words → practice all modes → buy → check dashboard), then delete the test data and push.

## 8. Out of scope, explicitly

Leaderboards (needs a privacy design — catalog-attached opt-in space; future spec), badges, weekly goals, teacher dashboard, write-batching beyond §3's flush strategy, profile rename/delete UI (parents needing this use the Firestore console for now — do not build it as a side quest).
