// Run: node tools/tests/quickadd-test.js — extractionToPaste output must survive parseCatalogText unchanged.
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../../js/app.js", "utf8");
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
let n = 0;
const uid = () => "id" + (++n);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const dateToLocalStr = (d) => d.toISOString().slice(0, 10);
const todayLocalStr = () => "2026-10-05";
const state = { catalogWeeks: [] };
const mondayOfThisWeek = () => "2026-10-05";
const impliedSeriesStart = (w) => w.weekStartDate;
const body = cut("function parseCatalogText(text)", "function mergeWeeks") + "\n" +
  cut("function termStartFor(", "document.getElementById(\"btn-qa-read\")") + "; return { parseCatalogText, extractionToPaste };";
const { parseCatalogText, extractionToPaste } = new Function("uid", "slugify", "dateToLocalStr", "todayLocalStr", "state", "mondayOfThisWeek", "impliedSeriesStart", body)(
  uid, slugify, dateToLocalStr, todayLocalStr, state, mondayOfThisWeek, impliedSeriesStart);

let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log("FAIL", name, "\n  got ", g, "\n  want", w); } else console.log("ok  ", name);
};

const result = { weeks: [{ week: null, verse: "Ecclesiastes 4:9",
  spelling: ["reapplying", "Joshua (Josh.)", "1 and 2 Samuel"],
  vocabulary: [{ word: "hues", definition: "the basic names of colors" }, { word: "inquiries", definition: "questions; searches for answers" }, { word: "similarities", definition: "" }] }], unsure: [] };
const built = extractionToPaste(result, "5", 6);
const weeks = parseCatalogText(built.text);
eq("one week parsed", weeks.length, 1);
eq("week number from the form", weeks[0].weekNumber, 6);
eq("first-ever week starts so that week 6 is this week", weeks[0].weekStartDate, "2026-10-05");
eq("words and definitions survive", weeks[0].words.map((w) => w.text + (w.definition ? "|" + w.definition : "")),
  ["reapplying", "Joshua (Josh.)", "1 and 2 Samuel", "hues|the basic names of colors", "inquiries|questions; searches for answers", "similarities"]);
eq("verse survives", weeks[0].verse && weeks[0].verse.ref, "Ecclesiastes 4:9");

state.catalogWeeks = [{ grade: "5", weekNumber: 3, weekStartDate: "2026-09-21" }];
eq("existing series start is reused", extractionToPaste(result, "5", 4).text.split("\n")[0], "GRADE 5 (starts 2026-09-21)");
const multi = extractionToPaste({ weeks: [{ week: 4, verse: "", spelling: ["a"], vocabulary: [] }, { week: 5, verse: "", spelling: ["b"], vocabulary: [] }], unsure: [] }, "5", 4);
eq("multi-week paste", parseCatalogText(multi.text).map((w) => [w.weekNumber, w.words[0].text]), [[4, "a"], [5, "b"]]);
console.log(fail ? "FAILED" : "all passed");
process.exit(fail ? 1 : 0);
