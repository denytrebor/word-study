// End-to-end test of the REAL js/sync.js school functions against the LOCAL
// Firestore emulator and the real rules. Each "device" is its own instance of
// sync.js with its own localStorage and its own Firebase uid.
// Run via:  npm run test:sync   (starts the emulator)
const fs = require("fs");
const path = require("path");
const { webcrypto } = require("crypto");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");
const fb = require("firebase/compat/app");
require("firebase/compat/firestore");

const PROJECT = "demo-wordstudy";
const syncSrc = fs.readFileSync(path.join(__dirname, "..", "..", "js", "sync.js"), "utf8");
let testEnv;
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; failures.push(name); console.log("  FAIL " + name + "\n       " + String((e && e.message) || e).split("\n")[0].slice(0, 220)); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || "mismatch"}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
async function rejects(p, msg) { let threw = false; try { await p; } catch (e) { threw = true; } if (!threw) throw new Error(msg || "expected a rejection"); }

// A fresh device = a new Sync instance + its own storage + its own auth uid.
function newDevice(uid) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const real = testEnv.authenticatedContext(uid).firestore();
  const db = new Proxy(real, { get(t0, p) { if (p === "enablePersistence") return () => Promise.resolve(); const v = t0[p]; return typeof v === "function" ? v.bind(t0) : v; } });
  const firebase = {
    initializeApp() {},
    firestore: Object.assign(() => db, { FieldValue: fb.firestore.FieldValue }),
    auth: () => ({ signInAnonymously: () => Promise.resolve(), currentUser: { uid } }),
  };
  const win = { FIREBASE_CONFIG: { projectId: PROJECT }, crypto: webcrypto };
  const Sync = new Function("window", "localStorage", "firebase", "crypto", "TextEncoder", syncSrc + "; return Sync;")(win, localStorage, firebase, webcrypto, TextEncoder);
  return { Sync, uid, db: real, store };
}

(async () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "firestore.rules"), "utf8");
  testEnv = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules, host: "127.0.0.1", port: 8085 } });
  await testEnv.clearFirestore();

  console.log("\nSCHOOL flows with the real sync.js + real rules");
  const owner = newDevice("owner-device");
  let made;
  await t("owner creates a class and gets a teacher key + class-device key", async () => {
    made = await owner.Sync.createClass({ name: "Mrs. Smith's 3rd Grade", school: "Zoe Live", grade: "3", label: "Mrs. Smith iPad" });
    eq(made.teacherKey.length, 16); eq(made.deviceKey.length, 16); eq(made.catalogCode.length, 10);
    eq(owner.Sync.classMode(), "staff");
    const meta = await owner.Sync.fetchClassMeta(made.cid);
    eq([meta.name, meta.school, meta.catalogCode], ["Mrs. Smith's 3rd Grade", "Zoe Live", made.catalogCode]);
  });
  await t("raw keys are never stored in the database (only hashes)", async () => {
    let dump = "";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const d = ctx.firestore();
      for (const p of [`classKeys`]) { const s = await d.collection(p).get(); s.forEach((x) => { dump += x.id + JSON.stringify(x.data()); }); }
      const st = await d.collection(`classes/${made.cid}/staff`).get(); st.forEach((x) => { dump += JSON.stringify(x.data()); });
    });
    if (dump.includes(made.teacherKey) || dump.includes(made.deviceKey)) throw new Error("a raw key leaked into the database");
  });

  const teacher2 = newDevice("teacher-device-2");
  await t("a second teacher device joins with the teacher key (typed with dashes/lowercase)", async () => {
    const fancy = made.teacherKey.slice(0, 5).toLowerCase() + "-" + made.teacherKey.slice(5, 10) + " " + made.teacherKey.slice(10);
    const s = await teacher2.Sync.redeemKey(fancy, "Aide iPad");
    eq(s.mode, "staff"); eq(s.name, "Mrs. Smith's 3rd Grade");
  });
  await t("a wrong key returns null and grants nothing", async () => {
    const stranger = newDevice("stranger-1");
    eq(await stranger.Sync.redeemKey("AAAAAAAAAAAAAAAA"), null);
    eq(stranger.Sync.getClassSession(), null);
  });

  // ---- roster ----
  let kidA, kidB;
  await t("teacher enrols two children and receives one-time codes", async () => {
    kidA = await owner.Sync.enrolStudent({ name: "Maya R.", grade: "3", avatar: "🦊" });
    kidB = await owner.Sync.enrolStudent({ name: "Noah T.", grade: "3", avatar: "🐨" });
    eq(kidA.childCode.length, 10); eq(kidA.parentCode.length, 10);
    if (kidA.childCode === kidA.parentCode) throw new Error("child and parent codes must differ");
  });
  await t("a stranger can not enrol students", async () => {
    const s = newDevice("stranger-2");
    s.Sync.setClassSession({ cid: made.cid, mode: "staff" }); // forged local session
    await rejects(s.Sync.enrolStudent({ name: "Evil", grade: "3" }), "forged staff session must not enrol");
  });
  await t("raw card codes are never stored in the database", async () => {
    let dump = "";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const d = ctx.firestore();
      const sc = await d.collection("studentCodes").get(); sc.forEach((x) => { dump += x.id + JSON.stringify(x.data()); });
      const cs = await d.collection(`classes/${made.cid}/cards`).get(); cs.forEach((x) => { dump += JSON.stringify(x.data()); });
    });
    for (const c of [kidA.childCode, kidA.parentCode, kidB.childCode]) if (dump.includes(c)) throw new Error("a raw code leaked");
  });

  // ---- child device ----
  const devA = newDevice("child-ipad-A");
  let resA;
  await t("child redeems their card: sees class + school + their name, device is bound", async () => {
    resA = await devA.Sync.redeemCard(kidA.childCode);
    eq([resA.sid, resA.kind, resA.student.name, resA.cls.name, resA.cls.school, resA.grade], [kidA.sid, "child", "Maya R.", "Mrs. Smith's 3rd Grade", "Zoe Live", "3"]);
    const s = devA.Sync.rememberBoundStudent(resA);
    eq([s.mode, s.sids], ["child", [kidA.sid]]);
  });
  await t("a wrong or malformed card returns null", async () => {
    const d = newDevice("child-x");
    eq(await d.Sync.redeemCard("ZZZZZZZZZZ"), null); eq(await d.Sync.redeemCard("short"), null);
  });
  await t("a bound child saves practice + rewards; teacher sees them", async () => {
    await devA.Sync.pushProgress(kidA.sid, "w1", { weekId: "w1", words: [{ id: "x", text: "friend" }] });
    await devA.Sync.pushActivity(kidA.sid, "2026-10-05", { answers: 4, correct: 3 });
    await devA.Sync.pushProfile({ id: kidA.sid, name: "HACK", avatar: "🦊", stars: 12, lifetimeStars: 12 });
    const seen = await owner.Sync.fetchProgress(kidA.sid, "w1");
    eq(seen.words[0].text, "friend");
    const act = await owner.Sync.fetchActivityRange(kidA.sid, ["2026-10-05"]);
    eq(act.length, 1);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const s = await ctx.firestore().doc(`students/${kidA.sid}`).get();
      eq([s.data().stars, s.data().name], [12, "Maya R."]); // stars updated, the name was NOT overwritten
    });
  });
  await t("child A can NOT read or write child B's practice", async () => {
    await devA.Sync.pushProgress(kidB.sid, "w1", { weekId: "w1", words: [{ id: "evil" }] }); // swallowed by warnWriteFailed
    eq(await owner.Sync.fetchProgress(kidB.sid, "w1"), null);
    await rejects(devA.Sync.fetchProgress(kidB.sid, "w1"), "child A read child B's progress");
  });
  await t("a child device can not list the roster", async () => {
    let got = false; devA.Sync.watchProfiles(() => { got = true; }); await new Promise((r) => setTimeout(r, 300)); if (got) throw new Error("child device received a roster");
  });

  // ---- parent device ----
  const par = newDevice("parent-phone-1");
  await t("a parent code binds read-only: can read the child's progress, can not write", async () => {
    const r = await par.Sync.redeemCard(kidA.parentCode);
    eq(r.kind, "parent"); par.Sync.rememberBoundStudent(r);
    eq((await par.Sync.fetchProgress(kidA.sid, "w1")).words[0].text, "friend");
    await par.Sync.pushProgress(kidA.sid, "w1", { weekId: "w1", words: [{ id: "tampered" }] });
    eq((await owner.Sync.fetchProgress(kidA.sid, "w1")).words[0].text, "friend");
    await rejects(par.Sync.fetchProgress(kidB.sid, "w1"), "parent read another child");
  });

  // ---- shared classroom device ----
  const kiosk = newDevice("class-tablet-1");
  await t("a shared class device enrols with the device key and reads the class word list", async () => {
    await owner.Sync.saveCatalogWeeks(made.catalogCode, [{ id: "3-w1", grade: "3", weekNumber: 1, label: "Grade 3 · Week 1", words: [{ id: "a", text: "friend" }] }]);
    const s = await kiosk.Sync.redeemKey(made.deviceKey, "Class iPad 1");
    eq([s.mode, s.catalogCode], ["kiosk", made.catalogCode]);
    const weeks = await kiosk.Sync.fetchCatalogWeeks(made.catalogCode);
    eq(weeks.map((w) => w.id), ["3-w1"]);
  });
  await t("the class device can NOT read any student, and a child card can not be used on it", async () => {
    await rejects(kiosk.Sync.fetchProgress(kidA.sid, "w1"), "kiosk read a student's progress");
    const roster = []; kiosk.Sync.watchProfiles((r) => roster.push(r)); await new Promise((r) => setTimeout(r, 300)); eq(roster.length, 0, "kiosk got a roster");
  });
  await t("the class device reports a device-level count; the teacher sees it", async () => {
    await kiosk.Sync.reportKioskActivity(5); await kiosk.Sync.reportKioskActivity(3);
    const list = await owner.Sync.listClassDevices();
    const k = list.kiosks.find((x) => x.label === "Class iPad 1");
    eq(k.answers, 8); eq(list.staff.length, 2);
  });
  await t("the class-device key can not make a teacher device", async () => {
    const d = newDevice("sneaky-1");
    await rejects(d.Sync.db ? Promise.resolve() : d.db.doc(`classes/${made.cid}/staff/sneaky-1`).set({ kh: await d.Sync.sha256hex(made.deviceKey), label: "x", at: 1 }), "device key became staff");
  });

  // ---- recovery ----
  await t("RECOVERY: teacher replaces Maya's card — old devices are cut off, old code dead, new code works", async () => {
    eq((await owner.Sync.listStudentDevices(kidA.sid)).length, 2); // child iPad + parent phone
    const fresh = await owner.Sync.replaceCard(kidA.sid);
    eq(fresh.revokedDevices, 2);
    if (fresh.childCode === kidA.childCode) throw new Error("code did not change");
    await devA.Sync.pushProgress(kidA.sid, "w1", { weekId: "w1", words: [{ id: "x", text: "STALE" }] });
    eq((await owner.Sync.fetchProgress(kidA.sid, "w1")).words[0].text, "friend"); // old device's write refused
    await rejects(par.Sync.fetchProgress(kidA.sid, "w1"), "old parent device still reads");
    eq(await newDevice("late").Sync.redeemCard(kidA.childCode), null); // old code is dead
    const dev2 = newDevice("child-ipad-new");
    const r = await dev2.Sync.redeemCard(fresh.childCode);
    eq(r.sid, kidA.sid); dev2.Sync.rememberBoundStudent(r);
    await dev2.Sync.pushProgress(kidA.sid, "w2", { weekId: "w2", words: [{ id: "n", text: "new" }] });
    eq((await owner.Sync.fetchProgress(kidA.sid, "w2")).words[0].text, "new");
    eq(r.student.stars, 12); // rewards survive recovery
  });
  await t("replacing one child's card does not touch another child", async () => {
    const devB = newDevice("child-ipad-B");
    const r = await devB.Sync.redeemCard(kidB.childCode); eq(r.sid, kidB.sid);
  });
  await t("a stranger's forged staff session can not replace cards", async () => {
    const s = newDevice("stranger-3"); s.Sync.setClassSession({ cid: made.cid, mode: "staff" });
    await rejects(s.Sync.replaceCard(kidB.sid), "forged staff replaced a card");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED:\n - " + failures.join("\n - "));
  await testEnv.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
