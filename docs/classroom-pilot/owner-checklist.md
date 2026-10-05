# Owner checklist — before the class starts

Design and limits: `docs/school-accounts.md`. Everything is one Firebase project; classes use new collections.

## A. Only you can do these

1. ✅ **DONE 2026-10-05 — rules published and verified live (20/20 read-only checks).** *(Kept for reference:)* Run the tests, then publish the new rules. `cd tools/rules-tests && npm install --legacy-peer-deps && npm run test:all`
   must show 73 + 20 passing. Then: Firebase console → Firestore → Rules → copy the **current** text somewhere safe →
   paste `docs/firestore.rules` → Publish. Immediately open the family app and practise a word (family behaviour is
   unchanged and covered by the tests). *To roll back: republish the saved text.* I (Claude) can test and read but
   cannot publish rules for you.
2. ✅ **DONE 2026-10-05 — both hosts serve the school build.** *(Kept for reference:)* Deploy the app to both hosts: push for GitHub Pages, then
   `python tools/stage-cloudflare.py && npx wrangler deploy` for `wordstudy.trebor.me`. Cards always point at
   `https://wordstudy.trebor.me`, so that host must have the school version before any card is printed.
3. ✅ Region: **nam5** (US multi-region). **No scheduled backups** (Spark plan; needs Blaze) — decide whether that is
   acceptable for the pilot; deletion is permanent.
4. **Turn on the word-list reader (one command, ~2 minutes).** Photo/paste entry runs through our Cloudflare Worker. It works without any setup using a weak free reader; for accurate reading, give it a Claude key: create an API key at console.anthropic.com (set a monthly spend limit, e.g. $10; a scan costs roughly 1-2 cents), then in this folder run `npx wrangler secret put ANTHROPIC_API_KEY` and paste it. No redeploy needed. Check: the teacher screen no longer says "Basic reader in use". Never put the key in the code or chat.
4b. **App Check** (free) — not enabled; needs a code change + reCAPTCHA, and a mistake can lock the app out, so do it as its
   own step later. It stops scripts from burning the free daily quota.
5. **Retire the old family catalog name.** Your family catalog code is the school's name and was visible in old code
   comments. The class uses its own random catalog automatically; move the family to a new random code when convenient.
6. ✅ **Deleting a child is now in the app:** Teacher Dashboard → ✏️ the child → **🗑 Remove student** (tap twice). It deletes the card, devices, progress, activity and records. Use it when a family asks. No backups exist, so it is permanent.
7. **School approval** of `data-sheet.md` and `parent-handout.md` *before* enrolling children; ask `school-questions.md`.
8. **Print and laminate** the setup sheet (keys) and the student cards; store the teacher key like a password.
9. Use only `https://wordstudy.trebor.me` for the school.

## B. Create the class (you or the teacher, on the teacher's own device)

1. Open `https://wordstudy.trebor.me` → **🏫 School or classroom** → **👩‍🏫 I'm a teacher** → class name, school, grade →
   **Create class**. **Print the key sheet now** (teacher key + class-device key). They are not stored anywhere else.
2. You land on the **teacher dashboard**. **Add Students**: paste one child per line (`Maya R.` or `Maya R., 3`; blank
   grade = the class grade). **Print the cards now**: each child gets a *student card* (stays at school) and a
   *parent code* (goes home). The codes exist only on that sheet (**🪪 Print new cards** reopens it until you tap Done).
3. **📝 Word Lists → ✨ Add a week's words**: photograph the paper list (or paste it), tap Read it, compare with the page, Preview, Save. (`ai-word-list-prompt.md` is only a fallback for pasting through a chat assistant.)
4. **Each shared class tablet/Chromebook:** open the site → School or classroom → **Set up a shared class device** →
   scan/type the class-device key. It goes straight to the class's current week; no student list.
5. **A child's own device:** scan their card (or open the QR link, or type the code).
6. Try it: scan one card, practise a word, see it appear on the teacher dashboard.

## C. Rehearsal (the week before; use 2 test children)
- Card on an iPad (Safari), an Android tablet and a Chromebook: scan, and type the code. Check camera permission.
- Child device cannot see another child; parent code is read-only; class device shows no students.
- **Replace a card:** old device shows "Your card was replaced"; new card restores stars and progress.
- Shared class device offline for a minute, then back online; first sign-in on the school Wi-Fi (needs the network once).
- Edit a week after a child practised it: progress kept; **Undo** works.
- On the school's network, allow `wordstudy.trebor.me`, `www.gstatic.com`, `firestore.googleapis.com`,
  `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`.
- Monday rollover shows the new week.

## D. If you later want to remove all of this
Republish the saved family-only rules (kept as `tools/rules-tests/firestore.rules.v1-live-2026-10-05`) and revert the app.
Class data stays in the database, unused.
