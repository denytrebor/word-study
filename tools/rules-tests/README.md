# Firestore rules tests

Runs `docs/firestore.rules` against a LOCAL Firestore emulator — never production, no Firebase project needed.

    cd tools/rules-tests
    npm install --legacy-peer-deps      # once
    npm test                            # starts the emulator, runs tests.js

Needs Java. `run.js` uses the portable JRE in `tools/.jre/` (git-ignored) or the system Java.
To compare against the saved live rules: `RULES_FILE=firestore.rules.v1-live-2026-10-05 ONLY=family node ...`
(the family-behaviour checks pass on both; the two "capture" checks only pass on the new rules).

`firestore.rules.v1-live-2026-10-05` is the families-only rules text that was published on 2026-10-05.
