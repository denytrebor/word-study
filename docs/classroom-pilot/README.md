# Classroom pilot kit — Zoe Live

Everything needed to run Word Study in **one classroom** as a proof of concept, written for the owner (the
"vendor"), the teacher and the principal. Built from two independent reviews (Opus 5.5 and Codex) of the app and
this goal; see `experiments/classroom-poc/` (local, not committed) for the full reviews.

**Goal:** one class where kids practise spelling/vocab/verse weekly, the teacher spends almost no admin time, nothing
goes wrong with data, and the principal sees enough to say "roll it out."

| File | For | What |
|---|---|---|
| `owner-checklist.md` | Owner | One-time tasks only you can do (Firebase console, privacy, devices) and the class setup procedure |
| `teacher-quickstart.md` | Teacher | One page, from "open the link" to first practice and the weekly routine |
| `ai-word-list-prompt.md` | Owner / teacher | Paste into any AI assistant with the week's word list to get text the app accepts |
| `parent-handout.md` | Parents / kids | How kids open the app at school and at home, what is stored |
| `data-sheet.md` | Principal | One-page plain-language data & privacy summary (DRAFT — owner and school must confirm each statement) |
| `pilot-plan.md` | Owner / principal | 6-week schedule, success measures, support, rollback, free-tier limits |
| `school-questions.md` | Owner | What to ask the school before launch |

## What changed in the app for this pilot (branch `classroom-pilot`)
- **Safe week editing** — fixing a typo keeps every child's progress and the week's Bible verse; preview shows the
  actual words and what is kept/added/removed; **Undo** restores the previous version.
- **Paste is forgiving** — bullets, numbering, headings, code fences, tabs/dashes/colons as separators, and one blank
  line inside a `WEEK` block no longer break an import.
- **Teacher dashboard** has **Word Lists**, **Add Students** and **Class Info** buttons (no more signing in as a
  child), plus a **Shared device** switch for classroom iPads/Chromebooks.
- **Class setup safety** — a roster/word list built in "Skip" mode moves into an empty class when you connect; joining
  a class no longer inherits the previous household's catalog; dashboard name/grade edits can't overwrite a child's stars.
- Grades like "3rd"/"Grade 3" are stored as "3"; a child whose grade has no list is told when they see another
  grade's words; the photo-scan library no longer loads on children's devices.

## School accounts (branch `school-accounts`) — supersedes the household-based class setup above
Per-device access: teacher devices, shared class devices (no student list), child cards, read-only parent codes, and
teacher-issued **replacement cards** for recovery. Design, limits and tests: `docs/school-accounts.md`. The owner must
publish `docs/firestore.rules` (see `owner-checklist.md`) before any class is created. The older "household as a class"
setup described in the early drafts is no longer the recommended path for the school.

## Known gaps still open (decide / schedule)
- Kids can still reach Manage Word Catalog / starter lists from their own Home screen (a "class mode" that hides
  adult controls from kids is the next engineering item; the dashboard buttons now make that safe to build).
- The invite link only pre-fills the join code (no "Join Mrs. X's class" screen yet).
- No remove/archive student, no CSV export, no teacher "hold this week" control.
- Access model is still "anyone with the class code has full access" — fine for a supervised pilot **only if the
  school knowingly accepts it**; see `owner-checklist.md` and `data-sheet.md`.
