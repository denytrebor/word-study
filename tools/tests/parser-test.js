// Run: node tools/tests/parser-test.js   — exercises parseCatalogText from js/app.js
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../../js/app.js", "utf8");
const start = src.indexOf("function parseCatalogText(text)");
const end = src.indexOf("function mergeWeeks");
if (start < 0 || end < 0) throw new Error("could not locate parseCatalogText");
let n = 0;
const uid = () => "id" + (++n);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const dateToLocalStr = (d) => d.toISOString().slice(0, 10);
const todayLocalStr = () => "2026-10-05";
const parseCatalogText = new Function("uid", "slugify", "dateToLocalStr", "todayLocalStr",
  src.slice(start, end) + "; return parseCatalogText;")(uid, slugify, dateToLocalStr, todayLocalStr);

let fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log("FAIL", name, "\n  got ", g, "\n  want", w); } else console.log("ok  ", name);
}
const slim = (weeks) => weeks.map((w) => ({ id: w.id, n: w.weekNumber, d: w.weekStartDate, words: w.words.map((x) => x.text + (x.definition ? "|" + x.definition : "")), verse: w.verse && w.verse.ref, noVerse: w.noVerse }));

// 1. legacy format, blank line = new week
eq("legacy multi-week", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\n\nfriend\nhabit, something you do often\n\nbecause\nlittle")),
  [{ id: "3-w1", n: 1, d: "2026-09-07", words: ["friend", "habit|something you do often"] },
   { id: "3-w2", n: 2, d: "2026-09-14", words: ["because", "little"] }]);
// 2. explicit WEEK, one blank line inside the week does not split
eq("WEEK block with spelling/vocab blank line", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\n\nWEEK 4\n\nfriend\nbecause\n\nhabit, a routine\nlittle")),
  [{ id: "3-w4", n: 4, d: "2026-09-28", words: ["friend", "because", "habit|a routine", "little"] }]);
// 3. two blank lines still end the explicit week
eq("two blanks end a WEEK block", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\nWEEK 1\na\nb\n\n\nWEEK 2\nc")).map((w) => w.words),
  [["a", "b"], ["c"]]);
// 4. AI output: fences, bullets, numbering, bold, headings, separators
eq("AI-style output", slim(parseCatalogText("```text\nGRADE 5 (starts 2026-09-07)\nWEEK 2\nVERSE Proverbs 3:5-6\n**Spelling Words:**\n1. necessary\n- calendar\n\nVocabulary:\n2) brilliant - very bright or intelligent\nhabit: something you do often\nword\tthe tab separated meaning\nwell-known\n```")),
  [{ id: "5-w2", n: 2, d: "2026-09-14", words: ["necessary", "calendar", "brilliant|very bright or intelligent", "habit|something you do often", "word|the tab separated meaning", "well-known"], verse: "Proverbs 3:5-6" }]);
// 5. definition containing commas / dashes keeps the first separator only
eq("first separator wins", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\nplace, a spot, or position - somewhere")).map((w) => w.words), [["place|a spot, or position - somewhere"]]);
// 6. VERSE none
eq("VERSE none flag", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\nWEEK 1\nVERSE none\nfriend")).map((w) => w.noVerse), [true]);
// 7. edit round trip text shape (weekToPasteText format)
eq("edit round trip", slim(parseCatalogText("GRADE 3 (starts 2026-09-07)\n\nWEEK 6\n\nVERSE John 3:16\nfriend\nhabit, something you do often")),
  [{ id: "3-w6", n: 6, d: "2026-10-12", words: ["friend", "habit|something you do often"], verse: "John 3:16" }]);
process.exit(fail ? 1 : 0);
