// Cross-device sync via Firebase (Firestore + Anonymous Auth).
// Every device that knows the same "household code" reads/writes the same
// private profiles/scores. Every household that knows the same separate
// "catalog code" reads (and can add to) the same shared word catalog —
// catalogs and households are deliberately different top-level collections
// so that sharing a catalog code can never expose anyone's scores: there is
// no path from a catalog code to a household's profiles/progress data.
// If Firebase fails to load or init, the app still works purely local.
const Sync = (function () {
  const HOUSEHOLD_KEY = "ws_household_code";
  const CATALOG_KEY = "ws_catalog_code";
  const OWNER_TOKEN_KEY = "ws_owner_token";
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

  let db = null;
  let ready = Promise.resolve(false);
  let profilesUnsub = null;
  let profileUnsub = null;
  let progressUnsub = null;

  function init() {
    if (typeof firebase === "undefined" || !window.FIREBASE_CONFIG) {
      ready = Promise.resolve(false);
      return;
    }
    try {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      // Local development only: ?emulator=1 on localhost talks to the Firebase
      // emulators (see tools/rules-tests). Never active on the real sites.
      const onLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      const useEmulator = onLocalhost && new URLSearchParams(location.search).get("emulator") === "1";
      if (useEmulator) {
        db.useEmulator("127.0.0.1", 8085);
        firebase.auth().useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
      }
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      ready = firebase
        .auth()
        .signInAnonymously()
        .then(() => true)
        .catch(() => false);
    } catch (e) {
      ready = Promise.resolve(false);
    }
  }
  init();

  function generateCode() {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  // An opaque, high-entropy identifier for "this household," used ONLY to mark
  // catalog ownership. It exists specifically so the catalog document never
  // has to carry the household's real access code — see ensureOwnerToken().
  // 256 bits from a CSPRNG: unlike the 6-char household code (32^6 ≈ 1e9,
  // brute-forceable offline in seconds), this cannot be reversed or guessed,
  // which is the whole point of using a token here instead of a hash of the code.
  function generateOwnerToken() {
    const bytes = new Uint8Array(32);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ----------------------------- School class session -----------------------------
   * A device is EITHER a family device (household code) OR a school device
   * (class session). Families keep working exactly as before; a school device
   * never holds a class code at all — it holds proof, per device, of what it
   * may do (see docs/firestore.rules). Modes:
   *   staff  — a teacher device: sees the whole class
   *   kiosk  — a shared classroom device: class word list only, no students
   *   child  — a child's own device(s) bound by a card
   *   parent — a parent device bound by a parent code (read-only)
   * localStorage "ws_class_session" = { cid, mode, name, school, grade,
   *   catalogCode, label, sids:[...] }.
   */
  const CLASS_KEY = "ws_class_session";

  function getClassSession() {
    try { return JSON.parse(localStorage.getItem(CLASS_KEY) || "null"); } catch (e) { return null; }
  }
  function setClassSession(s) {
    if (s) localStorage.setItem(CLASS_KEY, JSON.stringify(s));
    else localStorage.removeItem(CLASS_KEY);
  }
  function classMode() { const s = getClassSession(); return s ? s.mode : null; }
  // True when there is anything to sync with: a family household or a class.
  function isConnected() { return !!getHouseholdCode() || !!getClassSession(); }

  // All secrets come from the browser's CSPRNG (never Math.random). The
  // 32-character alphabet divides 256 evenly, so `byte & 31` is unbiased.
  function randomCode(len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let s = "";
    for (let i = 0; i < len; i++) s += CODE_CHARS[bytes[i] & 31];
    return s;
  }
  // Unbiased pick from an arbitrary alphabet (rejection sampling).
  function randomFrom(alphabet, len) {
    const limit = 256 - (256 % alphabet.length);
    let s = "";
    while (s.length < len) {
      const bytes = new Uint8Array(len * 2);
      crypto.getRandomValues(bytes);
      for (let i = 0; i < bytes.length && s.length < len; i++) if (bytes[i] < limit) s += alphabet[bytes[i] % alphabet.length];
    }
    return s;
  }
  async function sha256hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Codes are shown as groups ("KX7PM-R4TQ9") and typed by adults: forgive
  // case, spaces and dashes. (The alphabet has no 0/O/1/I, so a typed O, 0, I
  // or 1 can never be part of a real code.)
  function normalizeSecret(raw) {
    return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  /* ----------------------------- Household ----------------------------- */

  function getHouseholdCode() {
    return localStorage.getItem(HOUSEHOLD_KEY);
  }
  function setHouseholdCode(code) {
    localStorage.setItem(HOUSEHOLD_KEY, code);
  }

  async function createHousehold() {
    const okAuth = await ready;
    if (!okAuth || !db) throw new Error("Sync not available");
    const code = generateCode();
    const token = generateOwnerToken();
    await db.collection("households").doc(code).set({
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      ownerToken: token,
    });
    setHouseholdCode(code);
    localStorage.setItem(OWNER_TOKEN_KEY, token);
    return code;
  }

  // Returns this household's owner token, creating and persisting one if the
  // household predates the token (every household created before 2026-08-26).
  // Cached locally so the ownership check on the catalog editor doesn't cost a
  // Firestore read on every open.
  async function ensureOwnerToken() {
    const cached = localStorage.getItem(OWNER_TOKEN_KEY);
    if (cached) return cached;
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return null;
    const ref = db.collection("households").doc(hCode);
    const snap = await ref.get();
    let token = snap.exists ? snap.data().ownerToken : null;
    if (!token) {
      token = generateOwnerToken();
      await ref.set({ ownerToken: token }, { merge: true });
    }
    localStorage.setItem(OWNER_TOKEN_KEY, token);
    return token;
  }

  async function joinHousehold(code) {
    const okAuth = await ready;
    if (!okAuth || !db) throw new Error("Sync not available");
    const clean = code.trim().toUpperCase();
    const snap = await db.collection("households").doc(clean).get();
    if (!snap.exists) return false;
    setHouseholdCode(clean);
    const data = snap.data();
    // A class with no catalog of its own must not inherit the one this device
    // used before (e.g. a family's) — that silently showed the wrong words.
    if (data.catalogCode) localStorage.setItem(CATALOG_KEY, data.catalogCode);
    else localStorage.removeItem(CATALOG_KEY);
    return true;
  }

  function profilesRef() {
    const cs = getClassSession();
    if (cs && cs.cid) {
      if (!db) return null;
      return db.collection("classes").doc(cs.cid).collection("profiles");
    }
    const code = getHouseholdCode();
    if (!db || !code) return null;
    return db.collection("households").doc(code).collection("profiles");
  }
  function profileRef(profileId) {
    const col = profilesRef();
    return col ? col.doc(profileId) : null;
  }

  // Phase A split (docs/phase-a-student-model-plan.md, 2026-08-27): a
  // student's durable identity — stars, unlocks, streak, etc. — now lives
  // here, in a top-level collection keyed by the SAME id as its enrollment
  // doc under households/{code}/profiles/{id}. That shared id is the only
  // link between them; no separate foreign-key field is needed. This is what
  // lets a student keep their rewards when they move to next year's class
  // (a new enrollment doc, same studentId) instead of copying data forward
  // by hand every year.
  function studentRef(studentId) {
    if (!db) return null;
    return db.collection("students").doc(studentId);
  }

  // A profile created before this split still carries its reward fields
  // directly on the enrollment doc (households/{code}/profiles/{id}) instead
  // of a separate students/{id} doc. The first time such a profile is read
  // after this shipped, copy those fields into a brand-new students/{id} doc
  // — this is the ONLY write this function performs, and it only ever
  // CREATES that new doc; the legacy enrollment doc is never touched, so its
  // old fields just sit there unread forever (see the plan's additive-only
  // rule).
  //
  // An earlier version cached "already migrated" broadly, and it silently
  // blanked a real student's stars/name/avatar to zero the moment the
  // migration write failed once (e.g. Firestore rules not yet covering the
  // new collection — exactly what happened in testing, see
  // docs/phase-a-student-model-plan.md's Implementation Notes), because a
  // LATER call for the same id trusted the cache, skipped recomputing from
  // enrollmentData, and returned {} instead. The still-migrating branch below
  // MUST keep recomputing from enrollmentData on every call — a persistently-
  // failing write must degrade to "keeps retrying, keeps showing correct
  // data," never "works once, then blanks."
  //
  // The cache re-added below for A3 (docs/HANDOFF.md school-scale write-
  // amplification) is deliberately narrower than that earlier one: keyed
  // ONLY on "confirmed to already have a students/{id} doc" (the sSnap.exists
  // branch), never on the still-migrating branch above, so it can't
  // reintroduce the blanking bug. Once a student is in this cache,
  // watchProfiles() below stops re-reading their doc on every later
  // snapshot — safe because that listener only fires on enrollment-doc
  // changes (a grade edit, a new student), never on the student doc itself,
  // so a cached entry here was never "live" in the first place; this only
  // removes redundant re-reads of data that wasn't getting any fresher
  // anyway. A student's OWN active session still gets true live updates
  // through watchProfile() (singular), which is unaffected.
  const migratedCache = new Map();

  async function migrateStudentIfNeeded(id, enrollmentData) {
    if (migratedCache.has(id)) return migratedCache.get(id);
    const sRef = studentRef(id);
    const sSnap = await sRef.get().catch(() => null);
    if (sSnap && sSnap.exists) {
      const data = sSnap.data();
      migratedCache.set(id, data);
      return data;
    }
    const migrated = {
      name: enrollmentData.name || "", avatar: enrollmentData.avatar || "",
      stars: enrollmentData.stars || 0, currentStreak: enrollmentData.currentStreak || 0,
      bestStreak: enrollmentData.bestStreak || 0, lastActiveDate: enrollmentData.lastActiveDate || "",
      recentTests: enrollmentData.recentTests || [], unlocks: enrollmentData.unlocks || [],
      unlockDates: enrollmentData.unlockDates || {},
      equippedAvatar: enrollmentData.equippedAvatar || "", equippedTheme: enrollmentData.equippedTheme || "",
      lifetimeStars: enrollmentData.lifetimeStars || 0,
      weekTrophies: enrollmentData.weekTrophies || {}, streakShields: enrollmentData.streakShields || 0,
    };
    sRef.set(migrated).catch(warnWriteFailed("student migration " + id));
    return migrated;
  }

  // Returns the write promise(s) (settled, never rejected — every branch
  // already ends in .catch(warnWriteFailed)) so a caller that cares about
  // completion, not just fire-and-forget, can track it — see B6's
  // trackSyncWrite in app.js. Every existing caller still ignores the return
  // value exactly as before; this is additive.
  async function pushProfile(profile) {
    const ref = profileRef(profile.id);
    if (!ref || !(await ready)) return;
    if (getClassSession()) {
      // School child device: rules allow ONLY the reward fields on the student
      // doc (never name, grade, class) and nothing on the roster doc. A shared
      // classroom device and a parent device write nothing for students.
      const mode = classMode();
      if (mode !== "child") return;
      return studentRef(profile.id).set({
        avatar: profile.avatar || "", stars: profile.stars || 0,
        currentStreak: profile.currentStreak || 0, bestStreak: profile.bestStreak || 0,
        lastActiveDate: profile.lastActiveDate || "", recentTests: profile.recentTests || [],
        unlocks: profile.unlocks || [], unlockDates: profile.unlockDates || {},
        equippedAvatar: profile.equippedAvatar || "",
        equippedTheme: profile.equippedTheme || "", lifetimeStars: profile.lifetimeStars || 0,
        weekTrophies: profile.weekTrophies || {}, streakShields: profile.streakShields || 0,
      }, { merge: true }).catch(warnWriteFailed("student " + profile.id));
    }
    if (profile.role === "parent") {
      return ref.set({ name: profile.name || "", role: "parent", pin: profile.pin || "" }, { merge: true })
        .catch(warnWriteFailed("profile " + profile.id));
    }
    // Enrollment doc is now THIN for students — just the class-scoped fields.
    // merge:true only adds/overwrites these two named fields, so a legacy
    // profile's old reward fields (stars, unlocks, etc. from before this
    // split) are left sitting on the doc untouched, never stripped.
    const enrollmentWrite = ref.set({ grade: profile.grade || "", role: "" }, { merge: true })
      .catch(warnWriteFailed("enrollment " + profile.id));
    const sRef = studentRef(profile.id);
    const studentWrite = sRef.set({
      name: profile.name || "", avatar: profile.avatar || "", stars: profile.stars || 0,
      currentStreak: profile.currentStreak || 0, bestStreak: profile.bestStreak || 0,
      lastActiveDate: profile.lastActiveDate || "", recentTests: profile.recentTests || [],
      unlocks: profile.unlocks || [], unlockDates: profile.unlockDates || {},
      equippedAvatar: profile.equippedAvatar || "",
      equippedTheme: profile.equippedTheme || "", lifetimeStars: profile.lifetimeStars || 0,
      weekTrophies: profile.weekTrophies || {}, streakShields: profile.streakShields || 0,
    }, { merge: true }).catch(warnWriteFailed("student " + profile.id));
    return Promise.all([enrollmentWrite, studentWrite]);
  }

  // Name/grade edits from the teacher dashboard. pushProfile() above writes the
  // WHOLE student record from the caller's local copy, so editing a child's
  // grade from a stale dashboard used to overwrite stars/streak/unlocks that
  // the child's own device had since advanced. This writes only the identity
  // fields, and merge:true leaves everything else alone.
  async function pushProfileIdentity(profile) {
    const ref = profileRef(profile.id);
    if (!ref || !(await ready)) return;
    const writes = [ref.set(getClassSession() ? { grade: profile.grade || "", displayName: profile.name || "" } : { grade: profile.grade || "" }, { merge: true }).catch(warnWriteFailed("enrollment " + profile.id))];
    const sRef = studentRef(profile.id);
    if (sRef) writes.push(sRef.set({ name: profile.name || "" }, { merge: true }).catch(warnWriteFailed("student " + profile.id)));
    return Promise.all(writes);
  }

  // The app's first and only delete. It may ONLY ever be pointed at a
  // role:"parent" profile: a parent's entire Firestore footprint is this one
  // enrollment doc (pushProfile above writes nothing else for a parent — no
  // students/{id} doc, and parents never accumulate progress/ or activity/
  // subcollections). A STUDENT id must never be passed here: Firestore does
  // not delete a document's subcollections with it, so their progress and
  // activity docs would survive as unreachable orphans under a deleted parent
  // path. Resolves true when the doc is gone, false when sync isn't available
  // at all (offline / no household) so the caller can tell the user their
  // local delete may not have travelled; a rejected write propagates.
  async function deleteParentProfile(profileId) {
    const ref = profileRef(profileId);
    if (!ref || !(await ready)) return false;
    await ref.delete();
    return true;
  }

  async function fetchHouseholdCatalogCode() {
    const cs = getClassSession();
    if (cs && cs.cid) {
      if (!db || !(await ready)) return null;
      const csnap = await db.collection("classes").doc(cs.cid).get();
      return csnap.exists ? (csnap.data().catalogCode || null) : null;
    }
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return null;
    const snap = await db.collection("households").doc(hCode).get();
    return snap.exists ? (snap.data().catalogCode || null) : null;
  }

  function cacheCatalogCode(code) {
    localStorage.setItem(CATALOG_KEY, code);
  }

  // Enrollment doc stays the live listener (unchanged trigger — a class
  // roster change is still what should re-render the profile picker).
  // Student-role docs get merged in per-snapshot via migrateStudentIfNeeded,
  // so callers (watchProfilesList() in app.js) see the exact same flat shape
  // as before the split — zero changes needed upstream.
  function watchProfiles(onChange) {
    if (profilesUnsub) { profilesUnsub(); profilesUnsub = null; }
    if (getClassSession() && classMode() !== "staff") return; // children/parents/class devices never list a roster
    const col = profilesRef();
    if (!col) return;
    profilesUnsub = col.onSnapshot({ includeMetadataChanges: true }, async (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      const merged = await Promise.all(snap.docs.map(async (d) => {
        const e = d.data();
        if (e.role === "parent") {
          return { id: d.id, name: e.name, role: "parent", pin: e.pin || "" };
        }
        const s = await migrateStudentIfNeeded(d.id, e);
        return {
          id: d.id, grade: e.grade || "", role: "",
          name: s.name || "", avatar: s.avatar || "", stars: s.stars || 0,
          currentStreak: s.currentStreak || 0, bestStreak: s.bestStreak || 0,
          lastActiveDate: s.lastActiveDate || "", recentTests: s.recentTests || [],
          unlocks: s.unlocks || [], unlockDates: s.unlockDates || {}, equippedAvatar: s.equippedAvatar || "",
          equippedTheme: s.equippedTheme || "", lifetimeStars: s.lifetimeStars || 0,
          weekTrophies: s.weekTrophies || {}, streakShields: s.streakShields || 0,
        };
      }));
      onChange(merged);
    }, () => {});
  }

  // The active profile's live-update listener now watches the STUDENT doc
  // instead of the enrollment doc. Every field applyRemoteProfileUpdate() in
  // app.js reads (stars, currentStreak, bestStreak, lastActiveDate,
  // recentTests, unlocks, equippedAvatar, equippedTheme, lifetimeStars) is a
  // student-doc field under this split, none are enrollment fields — so this
  // is a one-line re-point with no changes needed in app.js. Grade changes
  // don't get pushed live this way (grade already wasn't live-watched before
  // this plan either), which is an accepted, unchanged limitation — a grade
  // bump only takes effect via the enrollment listener in watchProfiles.
  function watchProfile(profileId, onChange) {
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    const ref = studentRef(profileId);
    if (!ref) return;
    profileUnsub = ref.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.hasPendingWrites || !snap.exists) return;
      onChange(snap.data());
    }, () => {});
  }

  /* ------------------------------ Catalog ------------------------------ */
  // A catalog lives at catalogs/{catalogCode} with a `weeks` subcollection.
  // It is a fully separate collection tree from households/{code} — knowing
  // a catalog code grants read/write only to that catalog's word lists,
  // never to anyone's profiles or scores.

  function getCatalogCode() {
    return localStorage.getItem(CATALOG_KEY);
  }

  function catalogRef(catalogCode) {
    if (!db) return null;
    return db.collection("catalogs").doc(catalogCode);
  }
  function catalogWeeksRef(catalogCode) {
    const ref = catalogRef(catalogCode);
    return ref ? ref.collection("weeks") : null;
  }

  // Creates the catalog if the code is new, or just connects to it if it
  // already exists (so "create" and "join" collapse into one action for a
  // memorable, human-chosen code like a school name). Also attaches it to
  // the current household so every device/profile in that household picks
  // it up automatically.
  async function connectCatalog(catalogCode) {
    const okAuth = await ready;
    if (!okAuth || !db) throw new Error("Sync not available");
    const clean = catalogCode.trim();
    if (!clean) throw new Error("Empty catalog code");
    // Firestore's .doc(path) treats "/" as path SEGMENT separators, not a
    // literal character — catalogRef(clean) below is
    // db.collection("catalogs").doc(clean), so a code containing a slash
    // (e.g. "mycatalog/weeks/7-w1") doesn't create a catalog with a slash in
    // its name, it resolves straight into an existing nested document
    // (catalogs/mycatalog/weeks/7-w1, a real week doc). Found in the
    // 2026-08-26 security review, reachable not just by typing it but via a
    // crafted ?catalog= invite link that pre-fills this field with no
    // visible slash — one click on Connect and it's misrouted. Reject
    // before ever calling catalogRef rather than let the SDK reinterpret it.
    if (!/^[^/\\]{1,60}$/.test(clean)) throw new Error("Invalid catalog code");
    const ref = catalogRef(clean);
    const snap = await ref.get();
    if (!snap.exists) {
      // Ownership is marked with an opaque ownerToken, NEVER the household
      // code. A catalog code is *meant to be handed to other families* — so
      // anything stored on this document is readable by them by design.
      // Storing the raw household code here (as this once did) leaked full
      // read/write access to the owning household's profiles and scores to
      // every household they shared a word list with: found in the 2026-08-26
      // security review, and the reason this field is a token now.
      //
      // It remains a soft guardrail either way — it only lets the UI warn
      // before someone overwrites another household's shared word list, and
      // cannot stop a determined technical user writing directly.
      const token = await ensureOwnerToken();
      await ref.set({
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        ownerToken: token || "",
      });
    }
    const hCode = getHouseholdCode();
    if (hCode) {
      await db.collection("households").doc(hCode).set({ catalogCode: clean }, { merge: true });
    }
    localStorage.setItem(CATALOG_KEY, clean);
    return clean;
  }

  async function fetchCatalogMeta(catalogCode) {
    const ref = catalogRef(catalogCode);
    if (!ref || !(await ready)) return null;
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
  }

  // A school-wide catalog is created by whichever class connects to it
  // first, and ownerToken alone would then lock every other class out of
  // ever adding their own grade's weeks — exactly the gap
  // docs/school-scale-plan.md's "any connected household can add to it"
  // claim didn't actually implement. editorTokens is an explicit, additive
  // grant (a teacher taps a button, this is not auto-granted on connect) so
  // it stays a deliberate action instead of a silent bypass, matching the
  // soft-guardrail posture of ownerToken itself — arrayUnion so two teachers
  // requesting access around the same time can't clobber each other's grant.
  async function addCatalogEditor(catalogCode) {
    const ref = catalogRef(catalogCode);
    if (!ref || !(await ready)) return false;
    const token = await ensureOwnerToken();
    if (!token) return false;
    await ref.set({ editorTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
    return true;
  }

  async function saveCatalogWeeks(catalogCode, weeks) {
    const okAuth = await ready;
    if (!okAuth || !db) throw new Error("Sync not available");
    const col = catalogWeeksRef(catalogCode);
    const batch = db.batch();
    weeks.forEach((w) => batch.set(col.doc(w.id), w));
    await batch.commit();
  }

  async function fetchCatalogWeeks(catalogCode) {
    const col = catalogWeeksRef(catalogCode);
    if (!col || !(await ready)) return [];
    const snap = await col.get();
    return snap.docs.map((d) => d.data());
  }

  // C3: the catalog editor's only edit path used to be "re-paste the whole
  // grade" — no way to remove a week that's wrong or no longer wanted.
  // NOTE: docs/firestore.rules currently blocks delete on catalogs/*/weeks/*
  // (`allow delete: if false`) and, per that file's own header, is not yet
  // applied to the live project anyway — but if it ever is applied as
  // written, this call fails. See the updated comment in that file.
  async function deleteCatalogWeek(catalogCode, weekId) {
    const col = catalogWeeksRef(catalogCode);
    if (!col || !(await ready)) return false;
    await col.doc(weekId).delete();
    return true;
  }

  // Firestore's .set()/.update() throw SYNCHRONOUSLY on any field whose value
  // is `undefined` — before a .catch() can run (see docs/HANDOFF.md). Inside an
  // async function that surfaces as a rejected promise instead of a crash, and
  // since the write-and-forget callers never await it, the failure is entirely
  // silent: the local save already succeeded, the UI shows success, and every
  // later write of that same doc fails identically until the bad field is
  // fixed. `pushProfile` avoids this by listing every field with a `|| ""`
  // default; the doc-shaped writers below can't, so they strip instead.
  function stripUndefined(value) {
    if (Array.isArray(value)) return value.map(stripUndefined);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const out = {};
      Object.keys(value).forEach((k) => {
        if (value[k] !== undefined) out[k] = stripUndefined(value[k]);
      });
      return out;
    }
    return value;
  }

  // Write-and-forget paths have no UI to report into, so a swallowed rejection
  // used to leave a permanently stalled sync completely invisible. Log instead
  // of discarding, so a console check reveals it.
  function warnWriteFailed(what) {
    return (err) => console.warn("[word-study] sync write failed:", what, err);
  }

  /* ----------------------------- Shop config ----------------------------- */
  // Which avatars are active in the Star Shop and what they cost is a
  // household-wide storefront decision (the parent's, not any one kid's), so
  // it lives on the household doc itself (households/{code}.shopConfig) next
  // to catalogCode — same doc, same merge pattern as connectCatalog above —
  // rather than on a profile. Shape: { [avatarId]: { active: bool, price: number } }.

  async function saveShopConfig(config) {
    const cs = getClassSession();
    if (cs && cs.cid) {
      if (!db || !(await ready) || cs.mode !== "staff") return;
      await db.collection("classes").doc(cs.cid).set({ shopConfig: config }, { merge: true });
      return;
    }
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return;
    await db.collection("households").doc(hCode).set({ shopConfig: config }, { merge: true });
  }

  async function fetchShopConfig() {
    const cs = getClassSession();
    if (cs && cs.cid) {
      if (!db || !(await ready)) return null;
      const csnap = await db.collection("classes").doc(cs.cid).get();
      return csnap.exists ? (csnap.data().shopConfig || null) : null;
    }
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return null;
    const snap = await db.collection("households").doc(hCode).get();
    return snap.exists ? (snap.data().shopConfig || null) : null;
  }


  /* ------------------------------ Progress ------------------------------ */
  // Per (profile, week) practice results — kept separate from the shared
  // catalog content so scores never live anywhere but under the owning
  // household's own profiles subtree.

  function progressRef(profileId, weekId) {
    const p = profileRef(profileId);
    return p ? p.collection("progress").doc(weekId) : null;
  }

  // Returns the write promise (settled, never rejected — see pushProfile's
  // matching comment) for the same B6 tracking reason.
  async function pushProgress(profileId, weekId, progressDoc) {
    const ref = progressRef(profileId, weekId);
    if (!ref || !(await ready)) return;
    return ref.set(stripUndefined(progressDoc), { merge: true }).catch(warnWriteFailed("progress " + weekId));
  }

  async function fetchProgress(profileId, weekId) {
    const ref = progressRef(profileId, weekId);
    if (!ref || !(await ready)) return null;
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
  }

  async function fetchAllProgress(profileId) {
    const p = profileRef(profileId);
    if (!p || !(await ready)) return [];
    const snap = await p.collection("progress").get();
    return snap.docs.map((d) => d.data());
  }

  function watchProgress(profileId, weekId, onChange) {
    if (progressUnsub) { progressUnsub(); progressUnsub = null; }
    const ref = progressRef(profileId, weekId);
    if (!ref) return;
    progressUnsub = ref.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.hasPendingWrites || !snap.exists) return;
      onChange(snap.data());
    }, () => {});
  }

  /* -------------------------- School Overview --------------------------- */
  // Read-only, arbitrary-code lookup for the principal's cross-class overview
  // (docs/school-scale-plan.md Phase 3) — deliberately NOT scoped to
  // getHouseholdCode(), since this reads OTHER households' data by code, one
  // the caller is not connected to. Aggregation (which fields count as
  // "practiced this week") is left to app.js, which already owns local-
  // calendar-date math (todayLocalStr/localDateMinusDays) — duplicating that
  // here would risk the exact toISOString()-style date bug HANDOFF.md already
  // warns about. Same slash/length validation as catalogRef() for the same
  // reason: a code is user-typed and must never be handed to .doc() unchecked.
  async function fetchHouseholdProfiles(code) {
    const clean = String(code || "").trim();
    if (!/^[^/\\]{1,60}$/.test(clean)) return null;
    if (!db || !(await ready)) return null;
    try {
      const snap = await db.collection("households").doc(clean).collection("profiles").get();
      // School Overview's "practiced this week" reads lastActiveDate, which
      // now lives on the student doc under the Phase A split — merge the
      // same way watchProfiles() does, migrating any pre-split enrollment on
      // the way (this is exactly the "arbitrary other household, read by
      // code" path, so it hits profiles that may never have been opened in
      // the merged shape before).
      const merged = await Promise.all(snap.docs.map(async (d) => {
        const e = d.data();
        if (e.role === "parent") {
          return { id: d.id, name: e.name, role: "parent", pin: e.pin || "" };
        }
        const s = await migrateStudentIfNeeded(d.id, e);
        return {
          id: d.id, grade: e.grade || "", role: "",
          name: s.name || "", avatar: s.avatar || "", stars: s.stars || 0,
          currentStreak: s.currentStreak || 0, bestStreak: s.bestStreak || 0,
          lastActiveDate: s.lastActiveDate || "", recentTests: s.recentTests || [],
          unlocks: s.unlocks || [], equippedAvatar: s.equippedAvatar || "",
          equippedTheme: s.equippedTheme || "", lifetimeStars: s.lifetimeStars || 0,
        };
      }));
      return merged;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------ Activity ------------------------------ */
  // One doc per (profile, local-calendar-date) — the source of truth for
  // streaks and the parent dashboard. Never watched live; read on demand.

  function activityRef(profileId, date) {
    const p = profileRef(profileId);
    return p ? p.collection("activity").doc(date) : null;
  }

  // Returns the write promise for the same B6 tracking reason as pushProfile.
  async function pushActivity(profileId, date, activityDoc) {
    const ref = activityRef(profileId, date);
    if (!ref || !(await ready)) return;
    return ref.set(stripUndefined(activityDoc), { merge: true }).catch(warnWriteFailed("activity " + date));
  }

  async function fetchActivityRange(profileId, dateStrings) {
    const p = profileRef(profileId);
    if (!p || !(await ready)) return [];
    const results = await Promise.all(
      dateStrings.map((d) => p.collection("activity").doc(d).get().catch(() => null))
    );
    return results.filter((snap) => snap && snap.exists).map((snap) => snap.data());
  }

  /* ----------------------------- School API ----------------------------- */

  async function authedUid() {
    const okAuth = await ready;
    if (!okAuth || !db) throw new Error("Sync not available");
    const u = firebase.auth().currentUser;
    if (!u) throw new Error("Not signed in");
    return u.uid;
  }
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();

  // Creates a class owned by this device and returns the two secrets that must
  // be printed ONCE: the teacher key (other teacher devices) and the class-device
  // key (shared classroom tablets). Only their SHA-256 hashes are stored.
  async function createClass({ name, school, grade, label }) {
    const uid = await authedUid();
    const cid = randomFrom("abcdefghijklmnopqrstuvwxyz0123456789", 20);
    const teacherKey = randomCode(16), deviceKey = randomCode(16);
    const catalogCode = randomCode(10);
    const [th, dh] = await Promise.all([sha256hex(teacherKey), sha256hex(deviceKey)]);
    const classRef = db.collection("classes").doc(cid);
    const b1 = db.batch();
    b1.set(classRef, { name, school, grade, catalogCode: "", createdBy: uid, createdAt: TS(), v: 1 });
    b1.set(classRef.collection("staff").doc(uid), { kh: th, label: label || "Teacher device", at: Date.now() });
    b1.set(db.collection("classKeys").doc(th), { classId: cid, role: "teacher", at: Date.now() });
    b1.set(db.collection("classKeys").doc(dh), { classId: cid, role: "device", at: Date.now() });
    await b1.commit();
    // The class word list is created in a second batch: its rule needs this
    // device to already BE staff, which only exists once batch 1 has committed.
    const b2 = db.batch();
    b2.set(db.collection("catalogs").doc(catalogCode), { classId: cid, createdAt: TS() });
    b2.set(classRef, { catalogCode }, { merge: true });
    await b2.commit();
    setClassSession({ cid, mode: "staff", name, school, grade, catalogCode, label: label || "Teacher device", sids: [] });
    localStorage.setItem(CATALOG_KEY, catalogCode);
    return { cid, teacherKey, deviceKey, catalogCode };
  }

  // Turns this device into a teacher device or a shared classroom device,
  // depending on what the key was issued for. Returns the session, or null for
  // an unknown key.
  async function redeemKey(rawKey, label) {
    const uid = await authedUid();
    const key = normalizeSecret(rawKey);
    if (key.length !== 16) return null;
    const h = await sha256hex(key);
    const ks = await db.collection("classKeys").doc(h).get();
    if (!ks.exists) return null;
    const { classId, role } = ks.data();
    const classRef = db.collection("classes").doc(classId);
    if (role === "teacher") {
      await classRef.collection("staff").doc(uid).set({ kh: h, label: label || "Teacher device", at: Date.now() });
    } else {
      await classRef.collection("kiosks").doc(uid).set({ kh: h, label: label || "Class device", at: Date.now(), lastActiveDate: "", answers: 0 });
    }
    const cs = await classRef.get();
    const c = cs.exists ? cs.data() : {};
    const session = {
      cid: classId, mode: role === "teacher" ? "staff" : "kiosk",
      name: c.name || "", school: c.school || "", grade: c.grade || "", catalogCode: c.catalogCode || "",
      label: label || (role === "teacher" ? "Teacher device" : "Class device"), sids: [],
    };
    setClassSession(session);
    if (session.catalogCode) localStorage.setItem(CATALOG_KEY, session.catalogCode);
    return session;
  }

  // Teacher: enrols one child. Returns the codes — they exist only in this
  // return value (the database keeps hashes), so the caller must print/keep them.
  async function enrolStudent({ name, grade, avatar }) {
    const cs = getClassSession();
    if (!cs || cs.mode !== "staff") throw new Error("Not a teacher device");
    await authedUid();
    const sid = crypto.randomUUID();
    const childCode = randomCode(10), parentCode = randomCode(10);
    const [hc, hp] = await Promise.all([sha256hex(childCode), sha256hex(parentCode)]);
    const classRef = db.collection("classes").doc(cs.cid);
    const b = db.batch();
    b.set(db.collection("students").doc(sid), { name, classId: cs.cid, avatar: avatar || "", stars: 0, currentStreak: 0, bestStreak: 0, lifetimeStars: 0 });
    b.set(classRef.collection("profiles").doc(sid), { grade: grade || "", displayName: name, status: "active", joinedAt: Date.now() });
    b.set(db.collection("studentCodes").doc(hc), { studentId: sid, classId: cs.cid, kind: "child", at: Date.now() });
    b.set(db.collection("studentCodes").doc(hp), { studentId: sid, classId: cs.cid, kind: "parent", at: Date.now() });
    b.set(classRef.collection("cards").doc(sid), { childHash: hc, parentHash: hp, issuedAt: Date.now(), issueCount: 1 });
    await b.commit();
    return { sid, name, grade: grade || "", childCode, parentCode };
  }

  // Teacher: "Issue a new card". Mints new codes, then revokes the old codes and
  // EVERY device that was bound with them. Printed card = new; old = dead.
  async function replaceCard(sid) {
    const cs = getClassSession();
    if (!cs || cs.mode !== "staff") throw new Error("Not a teacher device");
    await authedUid();
    const classRef = db.collection("classes").doc(cs.cid);
    const cardRef = classRef.collection("cards").doc(sid);
    const old = await cardRef.get();
    const oldData = old.exists ? old.data() : {};
    const childCode = randomCode(10), parentCode = randomCode(10);
    const [hc, hp] = await Promise.all([sha256hex(childCode), sha256hex(parentCode)]);
    const b = db.batch();
    b.set(db.collection("studentCodes").doc(hc), { studentId: sid, classId: cs.cid, kind: "child", at: Date.now() });
    b.set(db.collection("studentCodes").doc(hp), { studentId: sid, classId: cs.cid, kind: "parent", at: Date.now() });
    b.set(cardRef, { childHash: hc, parentHash: hp, issuedAt: Date.now(), issueCount: (oldData.issueCount || 1) + 1 });
    await b.commit();
    const dead = db.batch();
    if (oldData.childHash) dead.delete(db.collection("studentCodes").doc(oldData.childHash));
    if (oldData.parentHash) dead.delete(db.collection("studentCodes").doc(oldData.parentHash));
    await dead.commit();
    const devs = await db.collection("students").doc(sid).collection("devices").get();
    for (let i = 0; i < devs.docs.length; i += 4) {
      const chunk = db.batch();
      devs.docs.slice(i, i + 4).forEach((d) => chunk.delete(d.ref));
      await chunk.commit();
    }
    return { sid, childCode, parentCode, revokedDevices: devs.docs.length };
  }

  async function listStudentDevices(sid) {
    const snap = await db.collection("students").doc(sid).collection("devices").get();
    return snap.docs.map((d) => Object.assign({ uid: d.id }, d.data()));
  }
  async function listClassDevices() {
    const cs = getClassSession();
    if (!cs || cs.mode !== "staff") return { staff: [], kiosks: [] };
    const classRef = db.collection("classes").doc(cs.cid);
    const [st, ki] = await Promise.all([classRef.collection("staff").get(), classRef.collection("kiosks").get()]);
    return {
      staff: st.docs.map((d) => Object.assign({ uid: d.id }, d.data())),
      kiosks: ki.docs.map((d) => Object.assign({ uid: d.id }, d.data())),
    };
  }
  async function removeClassDevice(kind, uid) {
    const cs = getClassSession();
    if (!cs || cs.mode !== "staff") throw new Error("Not a teacher device");
    await db.collection("classes").doc(cs.cid).collection(kind === "staff" ? "staff" : "kiosks").doc(uid).delete();
  }

  // Child/parent: redeem a card. Looks up the hashed code, binds THIS device to
  // that student, then reads what the confirmation screen needs. Returns null
  // for an unknown/replaced code.
  async function redeemCard(rawCode) {
    const uid = await authedUid();
    const code = normalizeSecret(rawCode);
    if (code.length !== 10) return null;
    const h = await sha256hex(code);
    const cs = await db.collection("studentCodes").doc(h).get();
    if (!cs.exists) return null;
    const { studentId, classId, kind } = cs.data();
    await db.collection("students").doc(studentId).collection("devices").doc(uid).set({ kind, h, at: Date.now() });
    const [stu, cls, prof] = await Promise.all([
      db.collection("students").doc(studentId).get(),
      db.collection("classes").doc(classId).get(),
      db.collection("classes").doc(classId).collection("profiles").doc(studentId).get(),
    ]);
    return {
      sid: studentId, cid: classId, kind,
      student: stu.exists ? stu.data() : {},
      cls: cls.exists ? cls.data() : {},
      grade: prof.exists ? (prof.data().grade || "") : "",
    };
  }

  // Remembers a bound student on this device (a child device may hold siblings).
  function rememberBoundStudent(result) {
    const prev = getClassSession();
    const mode = result.kind === "parent" ? "parent" : "child";
    if (prev && prev.mode !== mode && prev.mode !== undefined && (prev.sids || []).length) {
      throw new Error("This device is already set up as a " + prev.mode + " device");
    }
    const sids = Array.from(new Set(((prev && prev.cid === result.cid && prev.sids) || []).concat(result.sid)));
    const session = {
      cid: result.cid, mode, sids,
      name: result.cls.name || "", school: result.cls.school || "", grade: result.cls.grade || "",
      catalogCode: result.cls.catalogCode || "", label: "",
    };
    setClassSession(session);
    if (session.catalogCode) localStorage.setItem(CATALOG_KEY, session.catalogCode);
    return session;
  }

  // Shared classroom device: report how much it was used (a device-level count;
  // it never knows which child). Debounced by the caller.
  async function reportKioskActivity(deltaAnswers) {
    const cs = getClassSession();
    if (!cs || cs.mode !== "kiosk" || !deltaAnswers) return;
    const uid = await authedUid();
    await db.collection("classes").doc(cs.cid).collection("kiosks").doc(uid).update({
      answers: firebase.firestore.FieldValue.increment(deltaAnswers),
      lastActiveDate: new Date().toISOString().slice(0, 10),
    }).catch(warnWriteFailed("kiosk activity"));
  }

  // Teacher: mint another teacher-device key or class-device key later (the
  // first pair is shown once at class creation; only hashes are stored).
  async function newKey(role) {
    const cs = getClassSession();
    if (!cs || cs.mode !== "staff") throw new Error("Not a teacher device");
    await authedUid();
    const key = randomCode(16);
    const h = await sha256hex(key);
    await db.collection("classKeys").doc(h).set({ classId: cs.cid, role: role === "teacher" ? "teacher" : "device", at: Date.now() });
    return key;
  }

  // "Not me": undo the binding a card scan just created on this device.
  async function unbindStudent(sid) {
    const uid = await authedUid();
    await db.collection("students").doc(sid).collection("devices").doc(uid).delete().catch(() => {});
  }

  // Has this device's access been revoked (card replaced, device removed)?
  // Returns { offline:true } when it can't tell, else { revoked:[sid...] } for
  // child/parent bindings or { removed:true } for a teacher/class device.
  async function checkSession() {
    const cs = getClassSession();
    if (!cs) return { ok: true };
    let uid;
    try { uid = await authedUid(); } catch (e) { return { offline: true }; }
    try {
      if (cs.mode === "child" || cs.mode === "parent") {
        const revoked = [];
        for (const sid of cs.sids || []) {
          const snap = await db.collection("students").doc(sid).collection("devices").doc(uid).get({ source: "server" });
          if (!snap.exists) revoked.push(sid);
        }
        return { revoked };
      }
      const sub = cs.mode === "staff" ? "staff" : "kiosks";
      const snap = await db.collection("classes").doc(cs.cid).collection(sub).doc(uid).get({ source: "server" });
      return snap.exists ? { ok: true } : { removed: true };
    } catch (e) {
      return { offline: true };
    }
  }

  async function fetchClassMeta(cid) {
    await authedUid();
    const snap = await db.collection("classes").doc(cid).get();
    return snap.exists ? snap.data() : null;
  }

  // Stop being a school device (a child's own device unbinds itself first).
  async function leaveClass() {
    const cs = getClassSession();
    try {
      const uid = await authedUid();
      if (cs && (cs.mode === "child" || cs.mode === "parent")) {
        for (const sid of cs.sids || []) await db.collection("students").doc(sid).collection("devices").doc(uid).delete().catch(() => {});
      } else if (cs && cs.mode === "kiosk") {
        await db.collection("classes").doc(cs.cid).collection("kiosks").doc(uid).delete().catch(() => {});
      } else if (cs && cs.mode === "staff") {
        await db.collection("classes").doc(cs.cid).collection("staff").doc(uid).delete().catch(() => {});
      }
    } catch (e) { /* offline: the local session is still cleared */ }
    setClassSession(null);
  }

  return {
    getClassSession, setClassSession, classMode, isConnected,
    createClass, redeemKey, enrolStudent, replaceCard, redeemCard, rememberBoundStudent,
    listStudentDevices, listClassDevices, removeClassDevice, reportKioskActivity, fetchClassMeta, leaveClass, newKey, unbindStudent, checkSession,
    randomCode, sha256hex, normalizeSecret,
    getHouseholdCode,
    createHousehold,
    joinHousehold,
    pushProfile, pushProfileIdentity,
    deleteParentProfile,
    fetchHouseholdCatalogCode,
    watchProfiles,
    watchProfile,
    getCatalogCode,
    cacheCatalogCode,
    connectCatalog,
    saveShopConfig,
    fetchShopConfig,
    ensureOwnerToken,
    fetchCatalogMeta,
    addCatalogEditor,
    saveCatalogWeeks,
    fetchCatalogWeeks,
    deleteCatalogWeek,
    pushProgress,
    fetchProgress,
    fetchAllProgress,
    watchProgress,
    pushActivity,
    fetchActivityRange,
    fetchHouseholdProfiles,
  };
})();
