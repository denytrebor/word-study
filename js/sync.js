// Cross-device sync via Firebase (Firestore + Anonymous Auth).
// Every device that knows the same "household code" reads/writes the same
// data. If Firebase fails to load or init (offline on first-ever load, ad
// blocker, etc.) the app still works exactly as before, purely local.
const Sync = (function () {
  const HOUSEHOLD_KEY = "ws_household_code";
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

  let db = null;
  let ready = Promise.resolve(false);
  let profilesUnsub = null;
  let profileUnsub = null;

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

  async function isReady() {
    return (await ready) && !!getHouseholdCode();
  }

  async function pushProfile(profile) {
    const ref = profileRef(profile.id);
    if (!ref || !(await ready)) return;
    ref.set({ name: profile.name, avatar: profile.avatar, stars: profile.stars || 0 }, { merge: true }).catch(() => {});
  }

  async function pushWeek(profileId, week) {
    const ref = profileRef(profileId);
    if (!ref || !(await ready)) return;
    ref.set({ currentWeek: week }, { merge: true }).catch(() => {});
  }

  async function pushHistoryEntry(profileId, entry) {
    const col = profilesRef();
    if (!col || !(await ready)) return;
    col.doc(profileId).collection("history").add(entry).catch(() => {});
  }

  async function fetchProfile(profileId) {
    const ref = profileRef(profileId);
    if (!ref || !(await ready)) return null;
    const snap = await ref.get();
    return snap.exists ? snap.data() : null;
  }

  function watchProfiles(onChange) {
    if (profilesUnsub) { profilesUnsub(); profilesUnsub = null; }
    const col = profilesRef();
    if (!col) return;
    // Skip snapshots that are just the local echo of our own pending write
    // (hasPendingWrites) — otherwise a write in progress on this device can
    // race with its own echo and clobber data an active session is mutating.
    profilesUnsub = col.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      const list = snap.docs.map((d) => ({ id: d.id, name: d.data().name, avatar: d.data().avatar, stars: d.data().stars || 0 }));
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

  return {
    getHouseholdCode,
    createHousehold,
    joinHousehold,
    isReady,
    pushProfile,
    fetchProfile,
    pushWeek,
    pushHistoryEntry,
    watchProfiles,
    watchProfile,
  };
})();
