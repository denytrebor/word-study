# School accounts — design record

Built 2026-10-05 for the Zoe Live pilot (grades 1-5, mixed iPad / Android / Chromebook, mediocre Wi-Fi, in-class and
home use). Designed from two independent reviews (Opus 5.5 and Codex, see `experiments/accounts-design/`, not committed)
and tested on a local Firestore emulator. **One Firebase project / one database**: school data lives in new
collections next to the family collections; families are unchanged.

## Requirements (owner) and how they are met
| # | Requirement | How |
|---|---|---|
| 1 | Join mode shows the school/class name | The class document has `name` + `school`; the card confirm screen says "Hi Maya! Mrs. Smith's 3rd Grade · Zoe Live" |
| 2 | Teacher sees all students; students don't see each other | Per-**device** access in the rules (anonymous auth gives every browser its own uid). A child's device is bound to that child only; it cannot read another student, the roster, cards or staff. Shared classroom devices see no student at all. |
| 3 | Optional home / parent monitoring | A separate **parent code** per child binds a device read-only (enforced in rules). Same practice record the teacher sees; no copy. |
| 4 | Same account across classes/years | Student identity is the global `students/{sid}`; rewards are portable. Transfer UI = Phase 1 (below). |
| 5 | Teacher-assisted recovery, no emails, no PINs | Teacher taps **Issue a new card**: new codes minted, old codes deleted, **every device bound to the child is revoked**. Revoked devices tell the child "Your card was replaced". Stars/progress survive. |
| 6 | Shared devices: not tracked per child, no sign-in/out churn | A **class device** is enrolled once with a class-device key. It practises the class's current week, shows no student list, and reports only a device-level count to the teacher dashboard. |

## Device kinds
| Device | How it joins | Can do |
|---|---|---|
| Teacher (`staff`) | Creates the class, or scans/types a **teacher key** | Whole class: roster, progress, word lists, cards, devices |
| Class device (`kiosk`) | **Class-device key** (QR or typed) | Read class + word list; report an activity count. Nothing about any student. |
| Child | **Student card** (QR link, scan, or 10-char code) | Read/write that child's practice and rewards only |
| Parent | **Parent code** (separate QR/code) | Read-only view of that one child |

Secrets: 10-char card/parent codes, 16-char keys, from the browser's CSPRNG. The database stores only **SHA-256
hashes** (the hash is the lookup document's id). Cards are printed once, then exist nowhere else — "Replace" mints new ones.

## Data model (new collections; see `docs/firestore.rules`)
`classes/{cid}` (+ `/staff/{uid}`, `/kiosks/{uid}`, `/cards/{sid}` hashes, `/profiles/{sid}` + `/progress` + `/activity`),
`classKeys/{hash}`, `studentCodes/{hash}` → `{studentId, classId, kind}`, `students/{sid}/devices/{uid}`,
`students/{sid}.classId`, and `catalogs/{c}.classId` (class word lists are staff-write-only).

## Honest limits (tell the school)
- Whoever holds a child's card can act as that child; keep cards private. Replace is the remedy.
- A leaked teacher key or class-device key gives that access until the keys are replaced/devices removed.
- A child can still inflate their own stars (accepted, as before). Scores are practice aids, not grades.
- Data already cached on a lost device cannot be recalled.
- No scheduled backups (Spark plan); deletion is permanent. Region nam5 (US).
- Class devices are not tied to a child: a teacher who wants per-child tracking needs a device per child.

## Testing (nothing here touches production)
`cd tools/rules-tests && npm install --legacy-peer-deps && npm run test:all`
- `tests.js` — 73 rules cases on the local emulator: family behaviour identical to the live rules, plus every school
  abuse case (child↔child, parent writes, stranger as staff, wrong-class keys, replaced cards, class-catalog capture...).
- `sync-integration.js` — 20 scenarios running the REAL `js/sync.js` (one instance per simulated device) against the rules.
- Dev: `firebase emulators:start --only firestore,auth` and open `http://localhost:8099/?emulator=1` (the `?emulator=1`
  hook only works on localhost). Different origins/ports act as different devices.

## Publishing the rules (owner step)
1. Firebase console → Firestore → Rules: copy the live text somewhere safe (history also keeps it).
2. Paste `docs/firestore.rules`, **Publish**.
3. Immediately re-check the family app (open it, practise a word) and run the live read-only checks in
   `docs/classroom-pilot/owner-checklist.md`. To roll back: republish the saved text.

## Not built yet (Phase 1+)
Remove/archive a student and delete their data in-app; export; **transfer to next year's class** (new teacher scans
the card; clear class-scoped test history); teacher "hold this week"; family household linking; teacher-device screen
lock PIN; App Check; naming class devices; a teacher-visible "devices signed in for this child" panel.
