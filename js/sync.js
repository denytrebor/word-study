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
    await db.collection("households").doc(code).set({ createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    setHouseholdCode(code);
    return code;
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
    }, { merge: true }).catch(() => {});
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
    const ref = catalogRef(clean);
    const snap = await ref.get();
    if (!snap.exists) {
      // ownerHousehold is a soft guardrail, not a security boundary — same
      // posture as the household/catalog codes themselves (rules only check
      // "is this client authenticated"). It exists so the UI can warn
      // someone before they overwrite another household's shared word list;
      // it can't stop a determined technical user from writing directly.
      const hCode = getHouseholdCode();
      await ref.set({
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        ownerHousehold: hCode || "",
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
    ref.set(progressDoc, { merge: true }).catch(() => {});
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
    ref.set(activityDoc, { merge: true }).catch(() => {});
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
