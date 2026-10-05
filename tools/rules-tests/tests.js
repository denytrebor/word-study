// Firestore rules tests (run through run.js, which starts the local emulator).
// Never touches production: the emulator uses the demo project id.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const PROJECT = "demo-wordstudy";
const CID = "a1b2c3d4e5f6g7h8i9j0"; // 20 chars [a-z0-9]
const CID2 = "z9y8x7w6v5u4t3s2r1q0";

let testEnv;
let pass = 0, fail = 0;
const failures = [];

async function t(name, fn) {
  try { await testEnv.clearFirestore(); await seedClass(); await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; failures.push(name); console.log("  FAIL " + name + "\n       " + String(e.message || e).split("\n")[0].slice(0, 200)); }
}
const ok = (p) => assertSucceeds(p);
const no = (p) => assertFails(p);

const db = (uid) => testEnv.authenticatedContext(uid).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();
const seed = (fn) => testEnv.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));

// ---- fixtures -----------------------------------------------------------
const TEACHER_KEY = "TEACHERKEY000001";
const DEVICE_KEY = "DEVICEKEY0000001";
const KID1 = { sid: "student-one-0001", child: "CHILDCODE1", parent: "PARENTCODE1" };
const KID2 = { sid: "student-two-0002", child: "CHILDCODE2", parent: "PARENTCODE2" };

async function seedClass() {
  await seed(async (d) => {
    for (const [c, name] of [[CID, "Mrs. Smith's 3rd Grade"], [CID2, "Mr. Jones' 4th Grade"]]) {
      await d.doc(`classes/${c}`).set({ name, school: "Zoe Live", grade: "3", catalogCode: "CAT" + c.slice(0, 6), createdBy: "owner", createdAt: 1, v: 1 });
    }
    await d.doc(`classes/${CID}/staff/teacher1`).set({ kh: sha(TEACHER_KEY), label: "t", at: 1 });
    await d.doc(`classes/${CID2}/staff/teacher2`).set({ kh: sha(TEACHER_KEY + "2"), label: "t", at: 1 });
    await d.doc(`classKeys/${sha(TEACHER_KEY)}`).set({ classId: CID, role: "teacher", at: 1 });
    await d.doc(`classKeys/${sha(DEVICE_KEY)}`).set({ classId: CID, role: "device", at: 1 });
    await d.doc(`classKeys/${sha(TEACHER_KEY + "2")}`).set({ classId: CID2, role: "teacher", at: 1 });
    for (const k of [KID1, KID2]) {
      await d.doc(`students/${k.sid}`).set({ name: "Kid " + k.sid, classId: CID, stars: 5, avatar: "x", unlocks: [] });
      await d.doc(`classes/${CID}/profiles/${k.sid}`).set({ grade: "3", displayName: "Kid", status: "active", joinedAt: 1 });
      await d.doc(`classes/${CID}/profiles/${k.sid}/progress/w1`).set({ words: [] });
      await d.doc(`studentCodes/${sha(k.child)}`).set({ studentId: k.sid, classId: CID, kind: "child", at: 1 });
      await d.doc(`studentCodes/${sha(k.parent)}`).set({ studentId: k.sid, classId: CID, kind: "parent", at: 1 });
      await d.doc(`classes/${CID}/cards/${k.sid}`).set({ childHash: sha(k.child), parentHash: sha(k.parent), issuedAt: 1 });
    }
    await d.doc("catalogs/CLASSCAT").set({ classId: CID, createdAt: 1 });
    await d.doc("catalogs/CLASSCAT/weeks/w1").set({ id: "w1", words: [] });
    await d.doc("catalogs/LEGACY1").set({ createdAt: 1 });
    await d.doc("catalogs/LEGACY1/weeks/w1").set({ id: "w1", words: [] });
    await d.doc("households/FAM123").set({ createdAt: 1, catalogCode: "LEGACY1" });
    await d.doc("households/FAM123/profiles/p1").set({ grade: "3", role: "" });
    await d.doc("students/fam-student-1").set({ name: "Fam Kid", stars: 3 });
  });
}
async function bind(uid, k, kind) {
  const code = kind === "parent" ? k.parent : k.child;
  await ok(db(uid).doc(`students/${k.sid}/devices/${uid}`).set({ kind, h: sha(code), at: 1 }));
}
async function addStaff(uid) {
  await ok(db(uid).doc(`classes/${CID}/staff/${uid}`).set({ kh: sha(TEACHER_KEY), label: "x", at: 1 }));
}
async function addKiosk(uid) {
  await ok(db(uid).doc(`classes/${CID}/kiosks/${uid}`).set({ kh: sha(DEVICE_KEY), label: "Class iPad 1", at: 1 }));
}

(async () => {
  const rulesFile = process.env.RULES_FILE ? path.resolve(process.env.RULES_FILE) : path.join(__dirname, "..", "..", "docs", "firestore.rules");
  const rules = fs.readFileSync(rulesFile, "utf8");
  const onlyFamily = process.env.ONLY === "family";
  testEnv = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules, host: "127.0.0.1", port: 8085 } });

  // ================= FAMILIES: unchanged behaviour =================
  console.log("\nFAMILY regression (must behave exactly as the live rules do)");
  await t("signed-in: get household by code", () => ok(db("u1").doc("households/FAM123").get()));
  await t("signed-in: LIST households denied", () => no(db("u1").collection("households").get()));
  await t("unauthenticated: get household denied", () => no(anon().doc("households/FAM123").get()));
  await t("signed-in: create + update household", async () => { await ok(db("u1").doc("households/NEW123").set({ a: 1 })); await ok(db("u1").doc("households/NEW123").set({ b: 2 }, { merge: true })); });
  await t("delete household denied", () => no(db("u1").doc("households/FAM123").delete()));
  await t("profiles: list/create/update/delete allowed", async () => {
    await ok(db("u1").collection("households/FAM123/profiles").get());
    await ok(db("u1").doc("households/FAM123/profiles/p2").set({ grade: "4" }));
    await ok(db("u1").doc("households/FAM123/profiles/p2").delete());
  });
  await t("household progress/activity: write ok, delete denied", async () => {
    await ok(db("u1").doc("households/FAM123/profiles/p1/progress/w1").set({ x: 1 }));
    await ok(db("u1").doc("households/FAM123/profiles/p1/activity/2026-10-05").set({ x: 1 }));
    await no(db("u1").doc("households/FAM123/profiles/p1/progress/w1").delete());
    await no(db("u1").doc("households/FAM123/profiles/p1/activity/2026-10-05").delete());
  });
  await t("family student: get, create, update ok; list and delete denied", async () => {
    await ok(db("u1").doc("students/fam-student-1").get());
    await ok(db("u1").doc("students/fam-new-0001").set({ name: "N", stars: 1 }));
    await ok(db("u1").doc("students/fam-student-1").set({ stars: 9 }, { merge: true }));
    await no(db("u1").collection("students").get());
    await no(db("u1").doc("students/fam-student-1").delete());
  });
  await t("family student: get of a nonexistent doc is allowed (app checks existence)", () => ok(db("u1").doc("students/does-not-exist-1").get()));
  await t("legacy catalog: get ok, list denied, create/update ok, delete denied", async () => {
    await ok(db("u1").doc("catalogs/LEGACY1").get());
    await no(db("u1").collection("catalogs").get());
    await ok(db("u1").doc("catalogs/NEWCAT1").set({ createdAt: 1 }));
    await ok(db("u1").doc("catalogs/LEGACY1").set({ ownerToken: "t" }, { merge: true }));
    await no(db("u1").doc("catalogs/LEGACY1").delete());
  });
  await t("legacy catalog weeks: read/write/delete ok (incl. nonexistent catalog)", async () => {
    await ok(db("u1").collection("catalogs/LEGACY1/weeks").get());
    await ok(db("u1").doc("catalogs/LEGACY1/weeks/w2").set({ id: "w2" }));
    await ok(db("u1").doc("catalogs/LEGACY1/weeks/w2").delete());
    await ok(db("u1").doc("catalogs/NOPE9999/weeks/w1").delete());
  });
  await t("a family student can NOT be captured into a class (adding classId)", () => no(db("evil").doc("students/fam-student-1").set({ classId: CID }, { merge: true })));
  await t("a legacy catalog can NOT be captured by adding classId", () => no(db("evil").doc("catalogs/LEGACY1").set({ classId: CID }, { merge: true })));

  if (onlyFamily) { console.log(`
${pass} passed, ${fail} failed (family-only run against ${rulesFile})`); await testEnv.cleanup(); process.exit(fail ? 1 : 0); }

  // ================= CLASS CREATION / STAFF =================
  console.log("\nCLASS bootstrap and staff");
  const NEWC = "n1e2w3c4l5a6s7s8i9d0";
  await t("any signed-in device can create a class it owns (class + staff + 2 keys in one batch)", async () => {
    const d = db("owner1"); const b = d.batch();
    b.set(d.doc(`classes/${NEWC}`), { name: "Test", school: "Zoe Live", grade: "3", catalogCode: "", createdBy: "owner1", createdAt: 1, v: 1 });
    b.set(d.doc(`classes/${NEWC}/staff/owner1`), { kh: sha("TK-NEW"), label: "owner", at: 1 });
    b.set(d.doc(`classKeys/${sha("TK-NEW")}`), { classId: NEWC, role: "teacher", at: 1 });
    b.set(d.doc(`classKeys/${sha("DK-NEW")}`), { classId: NEWC, role: "device", at: 1 });
    await ok(b.commit());
  });
  await t("class create with createdBy = someone else denied", () => no(db("evil").doc(`classes/${"q1w2e3r4t5y6u7i8o9p0"}`).set({ name: "x", school: "y", grade: "3", catalogCode: "", createdBy: "someone-else", createdAt: 1, v: 1 })));
  await t("class create with extra fields denied", () => no(db("evil").doc(`classes/${"q1w2e3r4t5y6u7i8o9p1"}`).set({ name: "x", school: "y", grade: "3", catalogCode: "", createdBy: "evil", createdAt: 1, v: 1, admin: true })));
  await t("class id that is not 20 chars of [a-z0-9] denied", () => no(db("evil").doc("classes/Bad..Class").set({ name: "x", school: "y", grade: "3", catalogCode: "", createdBy: "evil", createdAt: 1, v: 1 })));
  await t("a stranger can NOT add themself as staff of an existing class (no key)", () => no(db("evil").doc(`classes/${CID}/staff/evil`).set({ kh: sha("guess"), label: "x", at: 1 })));
  await t("a stranger can NOT become staff with the DEVICE key (wrong role)", () => no(db("evil").doc(`classes/${CID}/staff/evil`).set({ kh: sha(DEVICE_KEY), label: "x", at: 1 })));
  await t("a stranger can NOT become staff of class A using class B's teacher key", () => no(db("evil").doc(`classes/${CID}/staff/evil`).set({ kh: sha(TEACHER_KEY + "2"), label: "x", at: 1 })));
  await t("a second teacher device joins with the teacher key", () => addStaff("teacher-device-2"));
  await t("staff doc must be for the caller's own uid", () => no(db("evil").doc(`classes/${CID}/staff/someone-else`).set({ kh: sha(TEACHER_KEY), label: "x", at: 1 })));
  await t("staff can list staff; strangers cannot", async () => {
    await addStaff("t3"); await ok(db("t3").collection(`classes/${CID}/staff`).get()); await no(db("stranger").collection(`classes/${CID}/staff`).get());
  });
  await t("class doc readable by any signed-in device; update only by staff", async () => {
    await ok(db("stranger").doc(`classes/${CID}`).get());
    await no(db("stranger").doc(`classes/${CID}`).set({ name: "Hacked" }, { merge: true }));
    await addStaff("t4"); await ok(db("t4").doc(`classes/${CID}`).set({ name: "Mrs. Smith's Class" }, { merge: true }));
  });
  await t("staff can not change createdBy", async () => { await addStaff("t5"); await no(db("t5").doc(`classes/${CID}`).set({ createdBy: "t5" }, { merge: true })); });
  await t("LIST denied on classes, classKeys, studentCodes, students", async () => {
    await no(db("t5").collection("classes").get()); await no(db("t5").collection("classKeys").get());
    await no(db("t5").collection("studentCodes").get()); await no(db("t5").collection("students").get());
  });
  await t("unauthenticated cannot read a class", () => no(anon().doc(`classes/${CID}`).get()));

  // ================= SHARED CLASS DEVICES (kiosks) =================
  console.log("\nSHARED CLASS DEVICES");
  await t("a class device enrols with the device key", () => addKiosk("kiosk1"));
  await t("a class device can NOT enrol with the teacher key", () => no(db("k2").doc(`classes/${CID}/kiosks/k2`).set({ kh: sha(TEACHER_KEY), label: "x", at: 1 })));
  await t("a class device can read the class doc and the class word list", async () => {
    await addKiosk("kiosk1");
    await ok(db("kiosk1").doc(`classes/${CID}`).get());
    await ok(db("kiosk1").collection("catalogs/CLASSCAT/weeks").get());
  });
  await t("a class device can NOT read any student, profile, progress or the roster", async () => {
    await addKiosk("kiosk1");
    await no(db("kiosk1").doc(`students/${KID1.sid}`).get());
    await no(db("kiosk1").doc(`classes/${CID}/profiles/${KID1.sid}`).get());
    await no(db("kiosk1").collection(`classes/${CID}/profiles`).get());
    await no(db("kiosk1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
    await no(db("kiosk1").doc(`classes/${CID}/cards/${KID1.sid}`).get());
  });
  await t("a class device can report its own activity count, nothing else", async () => {
    await addKiosk("kiosk1");
    await ok(db("kiosk1").doc(`classes/${CID}/kiosks/kiosk1`).set({ answers: 12, lastActiveDate: "2026-10-05" }, { merge: true }));
    await no(db("kiosk1").doc(`classes/${CID}/kiosks/kiosk1`).set({ label: "renamed" }, { merge: true }));
    await no(db("kiosk1").doc(`classes/${CID}/kiosks/kiosk1`).set({ kh: sha(TEACHER_KEY) }, { merge: true }));
  });
  await t("a class device can NOT write progress for a student", async () => {
    await addKiosk("kiosk1"); await no(db("kiosk1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w9`).set({ words: [] }));
  });
  await t("only staff can list/remove class devices", async () => {
    await addKiosk("kiosk1"); await addStaff("t1");
    await ok(db("t1").collection(`classes/${CID}/kiosks`).get());
    await no(db("stranger").collection(`classes/${CID}/kiosks`).get());
    await ok(db("t1").doc(`classes/${CID}/kiosks/kiosk1`).delete());
  });

  // ================= ROSTER + CARDS (staff) =================
  console.log("\nROSTER and CARDS (staff)");
  const NEWK = { sid: "student-new-0003", child: "NEWCHILD01", parent: "NEWPARENT1" };
  async function createStudentBatch(uid, k, cid) {
    const d = db(uid); const b = d.batch();
    b.set(d.doc(`students/${k.sid}`), { name: "New Kid", classId: cid, stars: 0, avatar: "fox" });
    b.set(d.doc(`classes/${cid}/profiles/${k.sid}`), { grade: "3", displayName: "New Kid", status: "active", joinedAt: 1 });
    b.set(d.doc(`studentCodes/${sha(k.child)}`), { studentId: k.sid, classId: cid, kind: "child", at: 1 });
    b.set(d.doc(`studentCodes/${sha(k.parent)}`), { studentId: k.sid, classId: cid, kind: "parent", at: 1 });
    b.set(d.doc(`classes/${cid}/cards/${k.sid}`), { childHash: sha(k.child), parentHash: sha(k.parent), issuedAt: 1 });
    return b.commit();
  }
  await t("staff can enrol a student with child+parent codes in one batch", async () => { await addStaff("t1"); await ok(createStudentBatch("t1", NEWK, CID)); });
  await t("a stranger can NOT create a student in a class", () => no(createStudentBatch("evil", { sid: "student-evil-0004", child: "EVILCHILD1", parent: "EVILPARENT" }, CID)));
  await t("staff of class B can NOT create a student in class A", async () => {
    await ok(db("tB").doc(`classes/${CID2}/staff/tB`).set({ kh: sha(TEACHER_KEY + "2"), label: "x", at: 1 }));
    await no(createStudentBatch("tB", { sid: "student-cross-005", child: "CROSSCHILD", parent: "CROSSPAREN" }, CID));
  });
  await t("a stranger can NOT mint a card for an existing student", () => no(db("evil").doc(`studentCodes/${sha("EVILCARD")}`).set({ studentId: KID1.sid, classId: CID, kind: "child", at: 1 })));
  await t("a card cannot be overwritten (update denied) or listed", async () => {
    await addStaff("t1");
    await no(db("t1").doc(`studentCodes/${sha(KID1.child)}`).set({ studentId: KID2.sid, classId: CID, kind: "child", at: 2 }));
    await no(db("t1").collection("studentCodes").get());
  });
  await t("card hashes are staff-only", async () => {
    await addStaff("t1"); await ok(db("t1").doc(`classes/${CID}/cards/${KID1.sid}`).get());
    await no(db("stranger").doc(`classes/${CID}/cards/${KID1.sid}`).get());
  });
  await t("staff can list the whole roster; strangers cannot", async () => {
    await addStaff("t1"); await ok(db("t1").collection(`classes/${CID}/profiles`).get()); await no(db("stranger").collection(`classes/${CID}/profiles`).get());
  });
  await t("staff can read any class student's progress; staff of ANOTHER class cannot", async () => {
    await addStaff("t1"); await ok(db("t1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
    await ok(db("tB").doc(`classes/${CID2}/staff/tB`).set({ kh: sha(TEACHER_KEY + "2"), label: "x", at: 1 }));
    await no(db("tB").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
    await no(db("tB").doc(`students/${KID1.sid}`).get());
  });
  await t("staff can rename a student but never move them to another class", async () => {
    await addStaff("t1");
    await ok(db("t1").doc(`students/${KID1.sid}`).set({ name: "Renamed" }, { merge: true }));
    await no(db("t1").doc(`students/${KID1.sid}`).set({ classId: CID2 }, { merge: true }));
  });

  // ================= CHILD DEVICE =================
  console.log("\nCHILD DEVICE (card holder)");
  await t("a device binds with a valid child card", () => bind("kid-dev-1", KID1, "child"));
  await t("binding with a wrong card hash fails", () => no(db("evil").doc(`students/${KID1.sid}/devices/evil`).set({ kind: "child", h: sha("WRONGCODE1"), at: 1 })));
  await t("binding with another student's card fails", () => no(db("evil").doc(`students/${KID1.sid}/devices/evil`).set({ kind: "child", h: sha(KID2.child), at: 1 })));
  await t("a PARENT code cannot be used to bind as a child (kind mismatch)", () => no(db("evil").doc(`students/${KID1.sid}/devices/evil`).set({ kind: "child", h: sha(KID1.parent), at: 1 })));
  await t("a device can only bind itself (uid in path must match)", () => no(db("evil").doc(`students/${KID1.sid}/devices/other-uid`).set({ kind: "child", h: sha(KID1.child), at: 1 })));
  await t("binding doc may not carry extra fields", () => no(db("evil").doc(`students/${KID1.sid}/devices/evil`).set({ kind: "child", h: sha(KID1.child), at: 1, admin: true })));
  await t("a bound child reads own student/profile/progress, writes own practice", async () => {
    await bind("kid1", KID1, "child");
    await ok(db("kid1").doc(`students/${KID1.sid}`).get());
    await ok(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}`).get());
    await ok(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
    await ok(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w2`).set({ words: [1] }));
    await ok(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}/activity/2026-10-05`).set({ answers: 3 }));
  });
  await t("a bound child can update reward fields only", async () => {
    await bind("kid1", KID1, "child");
    await ok(db("kid1").doc(`students/${KID1.sid}`).set({ stars: 99, unlocks: ["a"] }, { merge: true }));
    await no(db("kid1").doc(`students/${KID1.sid}`).set({ name: "Hacker" }, { merge: true }));
    await no(db("kid1").doc(`students/${KID1.sid}`).set({ classId: CID2 }, { merge: true }));
    await no(db("kid1").doc(`students/${KID1.sid}`).set({ classId: null }, { merge: true }));
  });
  await t("a bound child can NOT see another child (student, profile, progress, activity)", async () => {
    await bind("kid1", KID1, "child");
    await no(db("kid1").doc(`students/${KID2.sid}`).get());
    await no(db("kid1").doc(`classes/${CID}/profiles/${KID2.sid}`).get());
    await no(db("kid1").doc(`classes/${CID}/profiles/${KID2.sid}/progress/w1`).get());
  });
  await t("a bound child can NOT write another child's practice or rewards", async () => {
    await bind("kid1", KID1, "child");
    await no(db("kid1").doc(`classes/${CID}/profiles/${KID2.sid}/progress/w1`).set({ words: [] }));
    await no(db("kid1").doc(`students/${KID2.sid}`).set({ stars: 9999 }, { merge: true }));
  });
  await t("a bound child can NOT list the roster, cards, devices or other staff data", async () => {
    await bind("kid1", KID1, "child");
    await no(db("kid1").collection(`classes/${CID}/profiles`).get());
    await no(db("kid1").doc(`classes/${CID}/cards/${KID1.sid}`).get());
    await no(db("kid1").collection(`students/${KID1.sid}/devices`).get());
    await no(db("kid1").collection(`classes/${CID}/staff`).get());
  });
  await t("a bound child can NOT delete practice records or write the roster/profile doc", async () => {
    await bind("kid1", KID1, "child");
    await no(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).delete());
    await no(db("kid1").doc(`classes/${CID}/profiles/${KID1.sid}`).set({ grade: "5" }, { merge: true }));
  });
  await t("a bound child can NOT edit the class word list", async () => {
    await bind("kid1", KID1, "child");
    await ok(db("kid1").doc("catalogs/CLASSCAT/weeks/w1").get());
    await no(db("kid1").doc("catalogs/CLASSCAT/weeks/w1").set({ words: [{ id: "x", text: "prank" }] }));
    await no(db("kid1").doc("catalogs/CLASSCAT/weeks/w1").delete());
  });
  await t("a bound child can unbind their own device", async () => { await bind("kid1", KID1, "child"); await ok(db("kid1").doc(`students/${KID1.sid}/devices/kid1`).delete()); });
  await t("an unbound device cannot read any class student", async () => {
    await no(db("stranger").doc(`students/${KID1.sid}`).get());
    await no(db("stranger").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
  });

  // ================= PARENT DEVICE =================
  console.log("\nPARENT DEVICE (read-only)");
  await t("a parent code binds as kind 'parent'", () => bind("par1", KID1, "parent"));
  await t("a parent can read the child's data", async () => {
    await bind("par1", KID1, "parent");
    await ok(db("par1").doc(`students/${KID1.sid}`).get());
    await ok(db("par1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w1`).get());
    await ok(db("par1").collection(`classes/${CID}/profiles/${KID1.sid}/activity`).get());
  });
  await t("a parent can NOT write practice, rewards, or the word list", async () => {
    await bind("par1", KID1, "parent");
    await no(db("par1").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w9`).set({ words: [] }));
    await no(db("par1").doc(`classes/${CID}/profiles/${KID1.sid}/activity/2026-10-05`).set({ answers: 99 }));
    await no(db("par1").doc(`students/${KID1.sid}`).set({ stars: 9999 }, { merge: true }));
    await no(db("par1").doc("catalogs/CLASSCAT/weeks/w1").set({ words: [] }));
  });
  await t("a parent can NOT see another child or the roster", async () => {
    await bind("par1", KID1, "parent");
    await no(db("par1").doc(`students/${KID2.sid}`).get());
    await no(db("par1").collection(`classes/${CID}/profiles`).get());
  });
  await t("a child card cannot bind as a parent either (kind must match the code)", () => no(db("evil").doc(`students/${KID1.sid}/devices/evil`).set({ kind: "parent", h: sha(KID1.child), at: 1 })));

  // ================= REPLACE CARD (recovery) =================
  console.log("\nRECOVERY (replace card)");
  await t("staff replaces a card: old devices lose access, old code stops working, new code works", async () => {
    await addStaff("t1"); await bind("old-kid-dev", KID1, "child"); await bind("old-par-dev", KID1, "parent");
    await ok(db("old-kid-dev").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w2`).set({ words: [1] }));
    const d = db("t1");
    // 1. mint new codes
    const b = d.batch();
    b.set(d.doc(`studentCodes/${sha("REPLACED01")}`), { studentId: KID1.sid, classId: CID, kind: "child", at: 2 });
    b.set(d.doc(`studentCodes/${sha("REPLACEDP1")}`), { studentId: KID1.sid, classId: CID, kind: "parent", at: 2 });
    b.set(d.doc(`classes/${CID}/cards/${KID1.sid}`), { childHash: sha("REPLACED01"), parentHash: sha("REPLACEDP1"), issuedAt: 2 });
    await ok(b.commit());
    // 2. revoke the old codes and every device binding
    await ok(d.doc(`studentCodes/${sha(KID1.child)}`).delete());
    await ok(d.doc(`studentCodes/${sha(KID1.parent)}`).delete());
    const devs = await ok(d.collection(`students/${KID1.sid}/devices`).get());
    for (const x of devs.docs) await ok(x.ref.delete());
    // old child device is cut off
    await no(db("old-kid-dev").doc(`classes/${CID}/profiles/${KID1.sid}/progress/w2`).set({ words: [2] }));
    await no(db("old-kid-dev").doc(`students/${KID1.sid}`).get());
    await no(db("old-par-dev").doc(`students/${KID1.sid}`).get());
    // the old code can no longer bind a new device; the new one can
    await no(db("rebind").doc(`students/${KID1.sid}/devices/rebind`).set({ kind: "child", h: sha(KID1.child), at: 3 }));
    await ok(db("rebind2").doc(`students/${KID1.sid}/devices/rebind2`).set({ kind: "child", h: sha("REPLACED01"), at: 3 }));
  });
  await t("a stranger can NOT list or delete another child's device bindings", async () => {
    await bind("kid1", KID1, "child");
    await no(db("stranger").collection(`students/${KID1.sid}/devices`).get());
    await no(db("stranger").doc(`students/${KID1.sid}/devices/kid1`).delete());
  });
  await t("a child device can NOT delete another device's binding", async () => {
    await bind("kid1", KID1, "child"); await bind("kid1b", KID1, "child");
    await no(db("kid1").doc(`students/${KID1.sid}/devices/kid1b`).delete());
  });

  // ================= CLASS WORD LISTS =================
  console.log("\nCLASS WORD LISTS");
  await t("class staff can create a class-owned catalog and edit its weeks", async () => {
    await addStaff("t1");
    await ok(db("t1").doc("catalogs/NEWCLASSCAT").set({ classId: CID, createdAt: 1 }));
    await ok(db("t1").doc("catalogs/NEWCLASSCAT/weeks/w1").set({ id: "w1", words: [] }));
    await ok(db("t1").doc("catalogs/CLASSCAT/weeks/w1").set({ id: "w1", words: [{ id: "a", text: "friend" }] }));
    await ok(db("t1").doc("catalogs/CLASSCAT/weeks/w1").delete());
  });
  await t("a stranger can NOT create a catalog that claims a class", () => no(db("evil").doc("catalogs/EVILCAT").set({ classId: CID, createdAt: 1 })));
  await t("a stranger can NOT edit or delete a class catalog's weeks", async () => {
    await no(db("evil").doc("catalogs/CLASSCAT/weeks/w1").set({ id: "w1", words: [{ id: "x", text: "prank" }] }));
    await no(db("evil").doc("catalogs/CLASSCAT/weeks/w1").delete());
  });
  await t("a class catalog can not be re-pointed to a different class or released", async () => {
    await addStaff("t1");
    await no(db("t1").doc("catalogs/CLASSCAT").set({ classId: CID2 }, { merge: true }));
    await no(db("t1").doc("catalogs/CLASSCAT").set({ classId: null }, { merge: true }));
    await no(db("evil").doc("catalogs/CLASSCAT").set({ createdAt: 5 }, { merge: true }));
  });
  await t("anyone signed in can still READ a class catalog (curriculum, not student data)", () => ok(db("stranger").collection("catalogs/CLASSCAT/weeks").get()));

  // ================= CROSS-CLASS =================
  console.log("\nCROSS-CLASS isolation");
  await t("class B staff can not touch class A's cards, devices, kiosks, profiles", async () => {
    await ok(db("tB").doc(`classes/${CID2}/staff/tB`).set({ kh: sha(TEACHER_KEY + "2"), label: "x", at: 1 }));
    await bind("kid1", KID1, "child");
    await no(db("tB").collection(`students/${KID1.sid}/devices`).get());
    await no(db("tB").doc(`classes/${CID}/cards/${KID1.sid}`).get());
    await no(db("tB").collection(`classes/${CID}/kiosks`).get());
    await no(db("tB").doc(`classes/${CID}/profiles/${KID1.sid}`).set({ grade: "9" }, { merge: true }));
    await no(db("tB").doc(`studentCodes/${sha(KID1.child)}`).delete());
    await no(db("tB").doc(`classKeys/${sha(TEACHER_KEY)}`).delete());
  });
  await t("unauthenticated users can not do any school operation", async () => {
    await no(anon().doc(`classes/${CID}/profiles/${KID1.sid}`).get());
    await no(anon().doc(`studentCodes/${sha(KID1.child)}`).get());
    await no(anon().doc(`students/${KID1.sid}/devices/x`).set({ kind: "child", h: sha(KID1.child), at: 1 }));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n - " + failures.join("\n - ")); }
  await testEnv.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(2); });
