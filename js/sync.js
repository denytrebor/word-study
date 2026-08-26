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
    if (data.catalogCode) localStorage.setItem(CATALOG_KEY, data.catalogCode);
    return true;
  }

  function profilesRef() {
    const code = getHouseholdCode();
    if (!db || !code) return null;
    return db.collection("households").doc(code).collection("profiles");
  }
  function profileRef(profileId) {
    const col = profilesRef();
    return col ? col.doc(profileId) : null;
  }

  async function pushProfile(profile) {
    const ref = profileRef(profile.id);
    if (!ref || !(await ready)) return;
    ref.set({
      name: profile.name,
      avatar: profile.avatar || "",
      stars: profile.stars || 0,
      grade: profile.grade || "",
      currentStreak: profile.currentStreak || 0,
      bestStreak: profile.bestStreak || 0,
      lastActiveDate: profile.lastActiveDate || "",
      recentTests: profile.recentTests || [],
      unlocks: profile.unlocks || [],
      equippedAvatar: profile.equippedAvatar || "",
      equippedTheme: profile.equippedTheme || "",
      lifetimeStars: profile.lifetimeStars || 0,
      role: profile.role || "",
      pin: profile.pin || "",
    }, { merge: true }).catch(warnWriteFailed("profile " + profile.id));
  }

  async function fetchHouseholdCatalogCode() {
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return null;
    const snap = await db.collection("households").doc(hCode).get();
    return snap.exists ? (snap.data().catalogCode || null) : null;
  }

  function cacheCatalogCode(code) {
    localStorage.setItem(CATALOG_KEY, code);
  }

  function watchProfiles(onChange) {
    if (profilesUnsub) { profilesUnsub(); profilesUnsub = null; }
    const col = profilesRef();
    if (!col) return;
    profilesUnsub = col.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      const list = snap.docs.map((d) => ({
        id: d.id,
        name: d.data().name,
        avatar: d.data().avatar,
        stars: d.data().stars || 0,
        grade: d.data().grade || "",
        currentStreak: d.data().currentStreak || 0,
        bestStreak: d.data().bestStreak || 0,
        lastActiveDate: d.data().lastActiveDate || "",
        recentTests: d.data().recentTests || [],
        unlocks: d.data().unlocks || [],
        equippedAvatar: d.data().equippedAvatar || "",
        equippedTheme: d.data().equippedTheme || "",
        lifetimeStars: d.data().lifetimeStars || 0,
        role: d.data().role || "",
        pin: d.data().pin || "",
      }));
      onChange(list);
    }, () => {});
  }

  function watchProfile(profileId, onChange) {
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    const ref = profileRef(profileId);
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
    // (e.g. "zoelive/weeks/7-w1") doesn't create a catalog with a slash in
    // its name, it resolves straight into an existing nested document
    // (catalogs/zoelive/weeks/7-w1, a real week doc). Found in the
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
    const hCode = getHouseholdCode();
    if (!hCode || !db || !(await ready)) return;
    await db.collection("households").doc(hCode).set({ shopConfig: config }, { merge: true });
  }

  async function fetchShopConfig() {
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

  async function pushProgress(profileId, weekId, progressDoc) {
    const ref = progressRef(profileId, weekId);
    if (!ref || !(await ready)) return;
    ref.set(stripUndefined(progressDoc), { merge: true }).catch(warnWriteFailed("progress " + weekId));
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

  /* ------------------------------ Activity ------------------------------ */
  // One doc per (profile, local-calendar-date) — the source of truth for
  // streaks and the parent dashboard. Never watched live; read on demand.

  function activityRef(profileId, date) {
    const p = profileRef(profileId);
    return p ? p.collection("activity").doc(date) : null;
  }

  async function pushActivity(profileId, date, activityDoc) {
    const ref = activityRef(profileId, date);
    if (!ref || !(await ready)) return;
    ref.set(stripUndefined(activityDoc), { merge: true }).catch(warnWriteFailed("activity " + date));
  }

  async function fetchActivityRange(profileId, dateStrings) {
    const p = profileRef(profileId);
    if (!p || !(await ready)) return [];
    const results = await Promise.all(
      dateStrings.map((d) => p.collection("activity").doc(d).get().catch(() => null))
    );
    return results.filter((snap) => snap && snap.exists).map((snap) => snap.data());
  }

  return {
    getHouseholdCode,
    createHousehold,
    joinHousehold,
    pushProfile,
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
    saveCatalogWeeks,
    fetchCatalogWeeks,
    pushProgress,
    fetchProgress,
    fetchAllProgress,
    watchProgress,
    pushActivity,
    fetchActivityRange,
  };
})();
