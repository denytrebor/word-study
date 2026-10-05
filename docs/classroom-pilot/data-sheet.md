# Word Study — data & privacy at a glance (DRAFT — owner and school must confirm each line)

*Not legal advice. Whether COPPA, FERPA or a state student-privacy law applies, and what consent is needed, is for the
school and its adviser to decide.*

| Question | Answer (as built today) |
|---|---|
| Who runs it? | **[Owner name]**, an individual, for the pilot. Contact: **[email/phone]**. |
| What children's data is stored? | First name or school-approved nickname; grade; cartoon avatar; stars, streaks and shop choices; per-word practice counts; up to 3 recent misspellings per word with whether they were typed or spoken; test percentages. |
| What is **not** collected? | Email, birthdate, photos, location, advertising identifiers, analytics/tracking. No ads. |
| Where is it stored? | In the child's browser on the device, and in Google **Firebase (Firestore)** — region **nam5 (US multi-region)**. The site is served by GitHub Pages and Cloudflare. |
| Who can see it? | Anyone who has the **class code** (shared access, no individual accounts or passwords). The teacher PIN is a classroom convenience, not real security. |
| Other services touched | Google Firebase (storage + anonymous sign-in); the browser's speech service if the microphone button is used (audio goes to Apple/Google); a CDN only when an adult uses the photo-scan feature. |
| How are lists/words protected? | The class word list has a random code; anyone with that code could edit it — it is not published. |
| Retention | Kept while the pilot runs; **proposed: deleted within 30 days after the pilot ends** unless the school asks to continue. |
| Deletion / export | On request, within **7 days**, by the owner: remove the student's records from Firebase and clear the device. The app has no self-service delete/export yet. |
| If the code leaks | Stop new joins, tell the school contact, create a new class and re-enrol (the old class is then retired and its data deleted). |
| Incident notice | School contact notified within **72 hours** of any confirmed incident. |
| Pilot end | **[date]**; data export to the school on request, then deletion as above. |
| Known limits | No per-person permissions; a person with the code can change class records; no automatic retention or audit log. Suitable for a **supervised pilot** that the school knowingly accepts, not for unsupervised wide rollout. |
