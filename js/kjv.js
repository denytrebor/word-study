// KJV verse lookup.
//
// The King James Version is public domain, which is the only reason the text
// can be bundled at all — NIV, ESV and friends are copyrighted and would need
// a licence. `data/kjv/` holds one JSON file per book (66 files, ~5MB total,
// 31,102 verses — the canonical count).
//
// Nothing here runs on a student's device. References are resolved once, when
// a teacher enters them in the catalog editor, and the resulting TEXT is
// stored on the week. So a book file is fetched only by whoever is typing
// references, one 30-90KB book at a time, and kids' devices never download
// any of it. That is also why `data/kjv/` must stay OUT of the service
// worker's precache list — precaching it would triple the PWA install for a
// file the vast majority of users never need.
window.KJV = (function () {
  "use strict";

  // Canonical book names, in order, exactly matching the filenames
  // (spaces removed): "1 John" -> 1John.json.
  const BOOKS = [
    "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
    "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
    "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
    "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
    "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
    "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
    "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians",
    "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon",
    "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude",
    "Revelation",
  ];

  // Aliases people actually type. The workbook this app was built around
  // prints "Prov." and "Eccles.", so abbreviations are the normal case here,
  // not an edge case. "Psalm 23" (singular) is how everyone refers to a single
  // psalm even though the book is "Psalms".
  const ALIASES = {
    gen: "Genesis", ge: "Genesis", ex: "Exodus", exo: "Exodus", lev: "Leviticus",
    num: "Numbers", deut: "Deuteronomy", deu: "Deuteronomy", dt: "Deuteronomy",
    josh: "Joshua", judg: "Judges", jdg: "Judges", rth: "Ruth",
    "1sam": "1 Samuel", "2sam": "2 Samuel", "1sa": "1 Samuel", "2sa": "2 Samuel",
    "1kgs": "1 Kings", "2kgs": "2 Kings", "1ki": "1 Kings", "2ki": "2 Kings",
    "1chron": "1 Chronicles", "2chron": "2 Chronicles", "1chr": "1 Chronicles",
    "2chr": "2 Chronicles", neh: "Nehemiah", est: "Esther",
    ps: "Psalms", psa: "Psalms", psalm: "Psalms", pss: "Psalms",
    prov: "Proverbs", pro: "Proverbs", prv: "Proverbs",
    eccl: "Ecclesiastes", eccles: "Ecclesiastes", ecc: "Ecclesiastes",
    song: "Song of Solomon", sos: "Song of Solomon", canticles: "Song of Solomon",
    isa: "Isaiah", jer: "Jeremiah", lam: "Lamentations", ezek: "Ezekiel", eze: "Ezekiel",
    dan: "Daniel", hos: "Hosea", obad: "Obadiah", jon: "Jonah", mic: "Micah",
    nah: "Nahum", hab: "Habakkuk", zeph: "Zephaniah", hag: "Haggai", zech: "Zechariah",
    mal: "Malachi",
    matt: "Matthew", mt: "Matthew", mk: "Mark", mrk: "Mark", lk: "Luke", luk: "Luke",
    jn: "John", joh: "John", act: "Acts", rom: "Romans",
    "1cor": "1 Corinthians", "2cor": "2 Corinthians", gal: "Galatians", eph: "Ephesians",
    phil: "Philippians", php: "Philippians", col: "Colossians",
    "1thess": "1 Thessalonians", "2thess": "2 Thessalonians", "1th": "1 Thessalonians",
    "2th": "2 Thessalonians", "1tim": "1 Timothy", "2tim": "2 Timothy",
    "1ti": "1 Timothy", "2ti": "2 Timothy", tit: "Titus", phlm: "Philemon",
    heb: "Hebrews", jas: "James", jam: "James",
    "1pet": "1 Peter", "2pet": "2 Peter", "1pe": "1 Peter", "2pe": "2 Peter",
    "1jn": "1 John", "2jn": "2 John", "3jn": "3 John",
    "1joh": "1 John", "2joh": "2 John", "3joh": "3 John",
    rev: "Revelation", revelations: "Revelation",
  };

  // "1 John" / "First John" / "I John" all reduce to the same key.
  function normalizeBookKey(s) {
    return s.toLowerCase()
      .replace(/^first\s+/, "1").replace(/^second\s+/, "2").replace(/^third\s+/, "3")
      .replace(/^i{3}\s+/, "3").replace(/^i{2}\s+/, "2").replace(/^i\s+/, "1")
      .replace(/[.\s]/g, "");
  }

  const BY_KEY = {};
  BOOKS.forEach((b) => { BY_KEY[normalizeBookKey(b)] = b; });
  Object.keys(ALIASES).forEach((a) => { BY_KEY[a] = ALIASES[a]; });

  function resolveBook(raw) {
    const key = normalizeBookKey(raw);
    if (BY_KEY[key]) return BY_KEY[key];
    // Unique prefix match, so "Philipp" or "Ecclesiast" still land. Ambiguous
    // prefixes (e.g. "j") deliberately fail rather than guess a book wrong.
    const hits = BOOKS.filter((b) => normalizeBookKey(b).indexOf(key) === 0);
    return hits.length === 1 ? hits[0] : null;
  }

  // Accepts: "John 3:16", "Romans 3:2-10", "1 John 4:7-8", "Psalm 23",
  // "Prov. 3:5-6", "Genesis 1:1–3" (en dash).
  function parseReference(input) {
    const s = String(input || "").trim().replace(/[–—]/g, "-");
    if (!s) return null;
    const m = s.match(/^(.+?)\s*(\d+)\s*(?::\s*(\d+)\s*(?:-\s*(\d+))?)?$/);
    if (!m) return null;
    const book = resolveBook(m[1]);
    if (!book) return null;
    const chapter = parseInt(m[2], 10);
    const from = m[3] ? parseInt(m[3], 10) : null;   // null = whole chapter
    const to = m[4] ? parseInt(m[4], 10) : from;
    if (from !== null && to < from) return null;
    return { book, chapter, from, to };
  }

  const cache = {};
  async function loadBook(book) {
    const file = book.replace(/ /g, "");
    if (!cache[file]) {
      cache[file] = fetch(`./data/kjv/${file}.json`).then((r) => {
        if (!r.ok) throw new Error(`could not load ${book}`);
        return r.json();
      }).catch((e) => { delete cache[file]; throw e; });
    }
    return cache[file];
  }

  // Returns { ref, text, verses:[{verse,text}] } or throws with a message
  // meant to be shown to a teacher as-is.
  async function lookup(input) {
    const parsed = parseReference(input);
    if (!parsed) throw new Error(`Couldn't read "${input}" as a verse reference. Try something like John 3:16 or Romans 3:2-10.`);
    const data = await loadBook(parsed.book);
    const chap = (data.chapters || []).find((c) => parseInt(c.chapter, 10) === parsed.chapter);
    if (!chap) throw new Error(`${parsed.book} doesn't have a chapter ${parsed.chapter}.`);
    let verses = chap.verses;
    if (parsed.from !== null) {
      verses = verses.filter((v) => {
        const n = parseInt(v.verse, 10);
        return n >= parsed.from && n <= parsed.to;
      });
      if (!verses.length) throw new Error(`${parsed.book} ${parsed.chapter} doesn't have a verse ${parsed.from}.`);
    }
    const label = parsed.from === null
      ? `${parsed.book} ${parsed.chapter}`
      : `${parsed.book} ${parsed.chapter}:${parsed.from}${parsed.to !== parsed.from ? "-" + parsed.to : ""}`;
    return {
      ref: label,
      text: verses.map((v) => v.text.trim()).join(" ").replace(/\s+/g, " "),
      verses: verses.map((v) => ({ verse: parseInt(v.verse, 10), text: v.text.trim() })),
    };
  }

  return { lookup, parseReference, resolveBook, BOOKS };
})();
