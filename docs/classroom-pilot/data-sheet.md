# Word Study — data & privacy at a glance (DRAFT — owner and school must confirm each line)

*Not legal advice. Whether COPPA, FERPA or a state student-privacy law applies, and what consent is needed, is for the
school and its adviser to decide.*

| Question | Answer (as built today) |
|---|---|
| Who runs it? | **[Owner name]**, an individual, for the pilot. Contact: **[email/phone]**. |
| What children's data is stored? | First name or school-approved nickname; grade; cartoon avatar; stars, streaks and shop choices; per-word practice counts; up to 3 recent misspellings per word with whether they were typed or spoken; test percentages. |
| What is **not** collected? | Email, birthdate, photos, location, advertising identifiers, analytics/tracking. No ads. |
| Where is it stored? | In the child's browser on the device, and in Google **Firebase (Firestore)** — region **nam5 (US multi-region)**. The site is served by GitHub Pages and Cloudflare. |
| Who can see it? | The **teacher** (all students in their class). A **child's own device** sees only that child; a **parent code** shows only that one child, read-only; **shared class devices** see no student. Access is per device, enforced by the database rules (tested). No passwords or emails: whoever holds a child's card can open that child's practice, so cards are kept private and a teacher can replace one at any time. The operator can also see the data. |
| Other services touched | Google Firebase (storage + anonymous sign-in); GitHub Pages and Cloudflare (hosting); the browser's speech service if the microphone button is used (audio goes to Apple/Google); Anthropic (Claude) only when an adult uses "Add a week's words": the photo or pasted spelling list is sent through our own server to Claude to read the words; it is not stored by Word Study and contains no student data. |
| How are lists/words protected? | The class word list can only be edited by the class's teacher devices. |
| Retention | Kept while the pilot runs; **proposed: deleted within 30 days after the pilot ends** unless the school asks to continue. |
| Deletion / export | On request, within **7 days**, by the owner: remove the student's records from Firebase and clear the device. The app has no self-service delete/export yet. |
| If a card or key leaks | Card: the teacher issues a new one (old card and its devices stop working at once). Teacher/class-device key: remove the devices from the dashboard and issue new keys; the owner is informed. |
| Incident notice | School contact notified within **72 hours** of any confirmed incident. |
| Pilot end | **[date]**; data export to the school on request, then deletion as above. |
| Known limits | Whoever holds a child's card can act as that child; a child can still inflate their own stars (scores are practice aids, not grades); cached copies on a lost device cannot be recalled; shared class devices aren't tied to a child; no scheduled backups; no in-app delete/export yet (owner does it on request). Suitable for a **supervised pilot** that the school knowingly accepts. |
