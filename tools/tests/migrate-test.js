// Run: node tools/tests/migrate-test.js — checks migrateLocalIntoClass rules with a mocked Sync
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../../js/app.js", "utf8");
const a = src.indexOf("async function migrateLocalIntoClass");
const b = src.indexOf('document.getElementById("btn-toggle-household-code")', a);
const body = src.slice(a, b);
const mk = (remoteProfiles, opts = {}) => {
  const calls = { pushed: [], connected: [], saved: [] };
  const Sync = {
    getHouseholdCode: () => "CLASS1",
    fetchHouseholdProfiles: async () => remoteProfiles,
    pushProfile: async (p) => calls.pushed.push(p.id),
    getCatalogCode: () => opts.catalog || null,
    fetchHouseholdCatalogCode: async () => opts.remoteCatalog || null,
    cacheCatalogCode: () => {},
    connectCatalog: async (c) => calls.connected.push(c),
    saveCatalogWeeks: async (c, w) => calls.saved.push(w.length),
  };
  const fn = new Function("Sync", "generateCode", "save", "catalogWeeksKey",
    body + "; return migrateLocalIntoClass;")(Sync, () => "RANDOM1234", () => {}, (c) => "k" + c);
  return { fn, calls };
};
let fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : JSON.stringify(g) + " != " + JSON.stringify(w)); };
(async () => {
  const kids = [{ id: "s1", name: "A" }, { id: "s2", name: "B" }, { id: "t1", role: "parent", name: "T", pin: "1" }];
  let m = mk([]); eq("empty class gets roster + words", [await m.fn(kids, [{ id: "w" }]), m.calls.pushed, m.calls.connected, m.calls.saved], ["2 students and 1 word-list week", ["s1", "s2", "t1"], ["RANDOM1234"], [1]]);
  m = mk([{ id: "x", role: "" }]); eq("class with students is never merged into", [await m.fn(kids, [{ id: "w" }]), m.calls.pushed], ["", []]);
  m = mk(null); eq("fetch failure moves nothing", [await m.fn(kids, []), m.calls.pushed], ["", []]);
  m = mk([], { remoteCatalog: "EXISTING" }); eq("existing class catalog is not overwritten", [await m.fn(kids, [{ id: "w" }]), m.calls.connected, m.calls.saved], ["2 students", [], []]);
  m = mk([{ id: "t1", role: "parent" }]); eq("teacher-only class still gets students", [await m.fn(kids, []), m.calls.pushed], ["2 students", ["s1", "s2"]]);
  process.exit(fail ? 1 : 0);
})();
