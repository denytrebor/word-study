# Owner checklist — before the class starts

## A. Only you can do these (consoles, accounts, policy)

1. ✅ **Firestore rules — verified 2026-10-05.** The live rules (last published Sep 2, 2026) behave exactly as
   `docs/firestore.rules` specifies: listing `households`, `students` and `catalogs` is denied; a catalog-week delete
   and a profile-doc delete are allowed; deleting progress, activity, student or household documents is denied;
   unauthenticated requests are denied. Re-run this check after any rules change. (Limit: the rules still don't
   check class membership — anyone who knows a class code has full access to that class.)
2. **Turn on App Check** (free) so scripts can't burn the free-tier quota and take sync down.
3. ✅ **Firestore region: `nam5` (US multi-region), Standard edition, Native mode.** Note: **no scheduled backups
   are configured** (console → Firestore → Disaster Recovery) — decide whether the pilot needs them.
4. **Use a random catalog code for the class — never the school's name.** The app now auto-creates a random 10-character
   list code when a teacher taps *Word Lists* in a class with none. Do **not** use your existing family catalog for the
   class. (The family catalog is named after the school and was mentioned in code comments in the public repository
   until this change; treat that code as known and avoid sharing it. To retire it, move the family to a new random code.)
5. **Decide how data is deleted** and write it down (the privacy page promises deletion on request). Deleting a child
   fully is an owner console job: remove `households/{class}/profiles/{id}` plus its `progress` and `activity`
   subcollection documents and `students/{id}`, then have the device clear site data.
6. **Update the privacy page** (`index.html` Privacy Policy & Terms): it currently describes a family app hosted on
   GitHub Pages. Add: the class use, both hosts (GitHub Pages and Cloudflare), Firebase as the processor, who to contact,
   retention, and that the microphone (speech recognition) sends audio to the browser vendor. Have the school review.
7. **Get the school's written OK** on `data-sheet.md` and `parent-handout.md` *before* children are enrolled
   (consent/ed-tech approval rules differ by school and state — ask them; this is not legal advice).
8. **Ask the questions in `school-questions.md`** (devices, grade, class size, how words are distributed).
9. **Use one address only: `https://wordstudy.trebor.me`.** The GitHub address and this one keep separate browser
   storage, so a device that used the wrong one looks "logged out".
10. **Deploy order:** merge `classroom-pilot` → push (GitHub Pages) → `python tools/stage-cloudflare.py && npx wrangler deploy`
    (Cloudflare). Do not change code during the first two pilot weeks.

## B. One-time class setup (do this yourself, synced — never "Skip")

On a laptop at `https://wordstudy.trebor.me`:
1. **Create a New Household.** The *Class Info* screen shows the class code, QR and invite link. Write the code on the
   setup card. Tap **Back**, then **Join** (this connects the device and lets the browser offer to save the code).
2. **Add a Class Roster:** one child per line, `First L.` (add a last initial so two "Emma"s are distinct), grade as
   `3` (the app now normalises `3rd` / `Grade 3`). Preview, then **Add These Students**.
3. **Add a parent or teacher:** the teacher's name and a 4-digit PIN (it keeps curious kids out; it is not real security).
4. Open the **teacher dashboard** (tap the teacher name, enter the PIN) → **📝 Word Lists**. A private list is created.
   Paste the first 4–6 weeks (use `ai-word-list-prompt.md`), **Preview → "Check the words"**, compare with the school's
   list, **Save**. Add the Bible verse with a `VERSE John 3:16` line (text fills in from the KJV automatically).
5. **Try it as a child:** pick one student, open *This Week's Words*, then *Spelling Practice* — confirm the right words
   and that the first word is spoken.
6. **Each class device:** open the site → join with the code (or scan the QR) → open the teacher dashboard → switch
   **Shared device** on. Then add the site to the Home Screen if the school wants an icon.

## C. Rehearsal (the week before; use 2 test children — yours are ideal)
- Join a second device and confirm both see the same roster and words.
- Shared device: switch children; the next child must not start as the previous one.
- Edit a week after a child has practised it (fix a definition); confirm the child's progress is kept and the verse stays.
  Press **Undo the last save** and confirm the earlier version returns.
- Clear a device's site data, rejoin with the code, pick the same child; progress should return.
- On the **school's Wi-Fi**: confirm the site loads and the sync dot goes green. Ask IT to allow `wordstudy.trebor.me`,
  `www.gstatic.com`, `firestore.googleapis.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`,
  and (adults only, photo scan) `cdn.jsdelivr.net`.
- Monday rollover: confirm the new week appears on its start date.
