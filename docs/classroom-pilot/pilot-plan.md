# Pilot plan — one class, six weeks

## Principle
**Concierge for launch, teacher independence later.** The owner enters the first 4–6 weeks of words and verses (using
`ai-word-list-prompt.md`) and runs setup, so the teacher's first weeks involve no admin. Around week 3–4 the teacher
takes over weekly entry with the same prompt, owner reviewing. Paper lists remain the official assignment throughout.

## Timeline
| When | Who | What |
|---|---|---|
| **Week −2** | Owner | Ask `school-questions.md`. Get written approval of `data-sheet.md` and `parent-handout.md`. Do part A of `owner-checklist.md` (rules, App Check, region, deletion procedure, privacy page). Deploy and freeze code. |
| **Week −1** | Owner | Create the synced class, roster, teacher profile, private word list, 4–6 weeks of words/verses (part B). Join every class device and set **Shared device**. Rehearse (part C) with two test children on the school's real devices and Wi-Fi. Print the setup card, QR sheet and handouts. |
| **Day 1** (owner present, ~25 min) | Owner + teacher | Kids find their name → "Yes, this is me" → *This Week's Words* → *Look & Say* → *Spelling Practice* for 5 min → 2 min Star Shop → show **🔀 switch child** → handout goes home. Teacher counts children on the right profile/list. Stop if the wrong words appear. |
| **Week 1** | Owner | Check the dashboard daily; send the teacher a two-line summary; 10-minute check-in on day 3; 15-minute retro on Friday. Compare dashboard samples with what the teacher observed. |
| **Weeks 2–3** | Teacher + owner | 3 short sessions a week; owner delivers next week's list by Friday; try one real typo fix and one new-student add together. |
| **Week 4** | Teacher | Teacher runs the routine alone (adds a week with the prompt, owner reviews). Short spelling/vocab check; ask what helped. |
| **Week 5** | Principal + teacher + owner | Review results, incidents, support burden, usage. Decide: continue this class, revise, or stop. Expand one class at a time and repeat the privacy steps. |

## What "success" means (agree these with the principal before Day 1)
| Measure | Source | Target |
|---|---|---|
| Children practising ≥ 3 days/week | dashboard (last practised / answers this week) + teacher observation | ≥ 70% by week 3, held to week 6 |
| Start-up on Day 1 | teacher count | ≥ 90% of present children start the right activity within 3 min |
| Words reaching Silver or better by Thursday | dashboard medals | ≥ 60% of class-weeks |
| Friday spelling-test average | teacher's gradebook vs the 4 weeks before | class mean up, or fewer children under 70% |
| Teacher admin time | self-report | ≤ 10 min/week by week 3 |
| Wrong-profile / login incidents | owner log | trending to ~0 by week 3 |
| **Data incidents** (lost progress, wrong words) | owner log | **0** |
| Teacher + parent sentiment | 5-question survey, week 6 | teacher wants to continue; ≥ 2/3 of parents positive |

Stars and medals are practice aids, not grades, and the dashboard can undercount some activities (reading, verse,
self-rated vocab) — label dashboard numbers as approximate in the report.

## If something goes wrong (rollback)
Paper lists stay official. Stop editing. Restore a week with **↩️ Undo the last save**, or re-paste the saved text of
that week (keep every pasted list in a folder). If code is the problem: `git revert` and redeploy both hosts. A
leaked code = retire the class and re-enrol; follow `data-sheet.md`.

## Free-tier limits (Firebase Spark: 50k reads, 20k writes, 20k deletes per day)
- **One class (≈20 children, 3 opens/day, 36-week catalog):** roughly 5k reads and 1–3k writes per day — plenty.
- **Whole school on one shared catalog (60 children):** about 50k reads/day — at the cap. Use **one catalog per
  class** (the app creates one automatically) before expanding. Writes depend on how much children practise; the
  two reviews' estimates differ, so **watch Firebase console → Usage daily in week 1** and alert at 50% of either
  quota. Both hosts and the owner's family share this one project's quota.
- Money is not the risk (overage is cents); a hard daily cut-off on the free plan is.
