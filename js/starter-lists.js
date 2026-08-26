// Bundled starter word lists — the "instant start" content that lets a brand
// new family practice within seconds of opening the app instead of having to
// type a whole word list before anything works at all.
//
// Shape note: these are stored in a compact authoring format (spelling words
// as bare strings, vocab words as [word, definition] pairs) rather than the
// app's own week/word shape. StarterLists.toWeeks() converts them, assigning
// ids and dates at import time. That keeps this file readable as content —
// it is edited like a word list, not like code — and keeps id generation in
// exactly one place (the importer), so a starter list can never ship with
// hardcoded ids that collide across two households importing the same pack.
//
// Each week is deliberately mixed: ~8 spelling-only words plus ~4 vocab words
// with definitions, matching the existing Abeka-style convention the real
// family catalogs already use (see docs/HANDOFF.md), so every study mode
// including Vocab Practice has something to work with on day one.
const StarterLists = (function () {
  const PACKS = [
    {
      grade: "1",
      label: "Grade 1 · First Words",
      description: "Short vowels, sight words, and simple blends.",
      weeks: [
        {
          spelling: ["cat", "hat", "sit", "run", "big", "red", "top", "bed"],
          vocab: [
            ["jump", "to push yourself up off the ground with your legs"],
            ["happy", "feeling glad or cheerful"],
            ["friend", "someone you like and enjoy being with"],
            ["little", "small in size"],
          ],
        },
        {
          spelling: ["dog", "sun", "map", "pen", "cup", "box", "log", "fan"],
          vocab: [
            ["fast", "moving quickly"],
            ["under", "below something else"],
            ["help", "to do something useful for someone"],
            ["warm", "a little bit hot, in a nice way"],
          ],
        },
        {
          spelling: ["stop", "flag", "clap", "swim", "drum", "trip", "spin", "grab"],
          vocab: [
            ["begin", "to start something"],
            ["quiet", "making little or no sound"],
            ["gentle", "soft and careful, not rough"],
            ["together", "with each other"],
          ],
        },
      ],
    },
    {
      grade: "2",
      label: "Grade 2 · Building Blocks",
      description: "Digraphs, long vowels, and everyday vocabulary.",
      weeks: [
        {
          spelling: ["ship", "chin", "that", "when", "thick", "shape", "chase", "wheel"],
          vocab: [
            ["brave", "willing to face something scary"],
            ["clever", "quick to understand or learn things"],
            ["explore", "to travel around a place to learn about it"],
            ["nature", "the world of plants, animals, and weather"],
          ],
        },
        {
          spelling: ["rain", "boat", "seed", "light", "night", "found", "cloud", "point"],
          vocab: [
            ["journey", "a trip from one place to another"],
            ["discover", "to find something for the first time"],
            ["protect", "to keep someone or something safe"],
            ["curious", "wanting to know more about something"],
          ],
        },
        {
          spelling: ["happy", "funny", "puppy", "carry", "berry", "sunny", "penny", "hurry"],
          vocab: [
            ["neighbor", "a person who lives near you"],
            ["polite", "having good manners"],
            ["decide", "to make up your mind about something"],
            ["patient", "able to wait calmly without getting upset"],
          ],
        },
      ],
    },
    {
      grade: "3",
      label: "Grade 3 · Growing Readers",
      description: "Common spelling patterns and richer word meanings.",
      weeks: [
        {
          spelling: ["because", "friend", "people", "school", "little", "always", "before", "morning"],
          vocab: [
            ["describe", "to tell what something is like"],
            ["opinion", "what a person thinks or believes"],
            ["compare", "to look at how things are alike or different"],
            ["observe", "to watch something carefully"],
          ],
        },
        {
          spelling: ["knight", "wrote", "climb", "thumb", "wrist", "knee", "gnaw", "listen"],
          vocab: [
            ["ancient", "very old; from long ago"],
            ["fragile", "easily broken"],
            ["enormous", "extremely large"],
            ["gather", "to bring things together in one place"],
          ],
        },
        {
          spelling: ["careful", "hopeful", "sadness", "kindness", "quickly", "slowly", "helpful", "playful"],
          vocab: [
            ["courage", "the strength to do something difficult or scary"],
            ["honest", "telling the truth"],
            ["generous", "willing to share with others"],
            ["responsible", "able to be trusted to do what is right"],
          ],
        },
      ],
    },
    {
      grade: "4",
      label: "Grade 4 · Word Builders",
      description: "Prefixes, suffixes, and academic vocabulary.",
      weeks: [
        {
          spelling: ["rebuild", "unhappy", "preview", "disagree", "mislead", "recount", "unfair", "prepay"],
          vocab: [
            ["predict", "to say what you think will happen next"],
            ["evidence", "facts that help show what is true"],
            ["conclude", "to decide something after thinking it through"],
            ["essential", "absolutely necessary"],
          ],
        },
        {
          spelling: ["freedom", "movement", "argument", "treatment", "agreement", "shipment", "payment", "statement"],
          vocab: [
            ["persuade", "to convince someone to agree with you"],
            ["reluctant", "not wanting to do something"],
            ["sincere", "honest and truly meant"],
            ["resourceful", "good at finding clever ways to solve problems"],
          ],
        },
        {
          spelling: ["science", "citizen", "century", "certain", "circle", "success", "receive", "concert"],
          vocab: [
            ["ancient", "belonging to a time long past"],
            ["contribute", "to give something to help a shared effort"],
            ["consequence", "something that happens as a result of an action"],
            ["deliberate", "done on purpose"],
          ],
        },
      ],
    },
    {
      grade: "5",
      label: "Grade 5 · Word Power",
      description: "Multisyllable spelling and precise vocabulary.",
      weeks: [
        {
          spelling: ["necessary", "separate", "definitely", "familiar", "calendar", "medicine", "sincerely", "beginning"],
          vocab: [
            ["analyze", "to study something carefully to understand it"],
            ["significant", "important enough to be worth noticing"],
            ["reluctant", "unwilling; hesitant to act"],
            ["perspective", "the way a person sees or thinks about something"],
          ],
        },
        {
          spelling: ["achieve", "receive", "believe", "neighbor", "weight", "foreign", "either", "ceiling"],
          vocab: [
            ["determine", "to figure out or decide firmly"],
            ["abundant", "existing in large amounts; plentiful"],
            ["adapt", "to change in order to fit a new situation"],
            ["motive", "the reason someone does something"],
          ],
        },
        {
          spelling: ["responsible", "opportunity", "environment", "experience", "government", "temperature", "immediately", "independent"],
          vocab: [
            ["objective", "a goal you are working toward"],
            ["hesitate", "to pause because you are unsure"],
            ["distinct", "clearly different from other things"],
            ["assume", "to believe something is true without proof"],
          ],
        },
      ],
    },
    {
      grade: "6",
      label: "Grade 6 · Sharp Words",
      description: "Roots, tricky spellings, and middle-school vocabulary.",
      weeks: [
        {
          spelling: ["conscience", "rhythm", "acquire", "occurrence", "privilege", "maintenance", "questionnaire", "embarrass"],
          vocab: [
            ["inevitable", "certain to happen; unavoidable"],
            ["ambiguous", "having more than one possible meaning"],
            ["diligent", "working carefully and steadily"],
            ["prominent", "important and easily noticed"],
          ],
        },
        {
          spelling: ["transport", "construct", "predict", "eject", "inspect", "reject", "export", "structure"],
          vocab: [
            ["advocate", "to publicly support an idea or cause"],
            ["skeptical", "doubting that something is true"],
            ["profound", "very deep or intense in meaning"],
            ["versatile", "able to be used in many different ways"],
          ],
        },
        {
          spelling: ["parallel", "committee", "guarantee", "restaurant", "vacuum", "bureau", "leisure", "colleague"],
          vocab: [
            ["scrutinize", "to examine very closely and critically"],
            ["tentative", "not certain or final; done as a trial"],
            ["candid", "honest and direct, even when awkward"],
            ["resilient", "able to recover quickly from difficulty"],
          ],
        },
      ],
    },
    {
      grade: "7",
      label: "Grade 7 · Precision",
      description: "Latin roots and nuanced academic vocabulary.",
      weeks: [
        {
          spelling: ["altruistic", "malicious", "spurious", "audible", "visible", "tangible", "prescient", "legible"],
          vocab: [
            ["benevolent", "kind and generous toward others"],
            ["credible", "believable and worthy of trust"],
            ["plausible", "seeming reasonable or probably true"],
            ["arbitrary", "based on personal whim rather than reason"],
          ],
        },
        {
          spelling: ["conscientious", "perseverance", "acknowledgment", "indispensable", "conscious", "surveillance", "reminiscent", "unprecedented"],
          vocab: [
            ["meticulous", "showing extreme care about small details"],
            ["ambivalent", "having mixed feelings about something"],
            ["pragmatic", "dealing with things in a practical way"],
            ["superfluous", "more than is needed; unnecessary"],
          ],
        },
        {
          spelling: ["hypothesis", "synthesis", "analysis", "chronological", "geography", "biography", "photograph", "telegraph"],
          vocab: [
            ["substantiate", "to provide evidence that supports a claim"],
            ["inherent", "existing as a natural, permanent part of something"],
            ["nuance", "a very small difference in meaning or feeling"],
            ["obsolete", "no longer used because something better exists"],
          ],
        },
      ],
    },
    {
      grade: "8",
      label: "Grade 8 · High School Ready",
      description: "Advanced vocabulary and commonly misspelled words.",
      weeks: [
        {
          spelling: ["accommodate", "occasionally", "recommendation", "correspondence", "acquaintance", "millennium", "harassment", "supersede"],
          vocab: [
            ["ubiquitous", "seeming to be everywhere at once"],
            ["reticent", "unwilling to speak freely; reserved"],
            ["exacerbate", "to make a bad situation worse"],
            ["astute", "very good at noticing and understanding things"],
          ],
        },
        {
          spelling: ["bureaucracy", "entrepreneur", "silhouette", "camouflage", "connoisseur", "rendezvous", "liaison", "aesthetic"],
          vocab: [
            ["juxtapose", "to place things side by side to show contrast"],
            ["paradox", "a statement that seems contradictory but may be true"],
            ["empirical", "based on observation or experiment, not theory"],
            ["indignant", "angry because something seems unfair"],
          ],
        },
        {
          spelling: ["perseverance", "incomprehensible", "characteristic", "responsibility", "circumstances", "sophisticated", "extraordinary", "simultaneously"],
          vocab: [
            ["ephemeral", "lasting for only a very short time"],
            ["scrupulous", "very careful to do what is right and correct"],
            ["innocuous", "harmless; unlikely to offend or injure"],
            ["tenacious", "holding on firmly; not giving up"],
          ],
        },
      ],
    },
  ];

  function packFor(grade) {
    return PACKS.find((p) => p.grade === grade) || null;
  }

  // Converts one pack into the app's own week shape.
  //
  // Week ids use a `starter-` prefix and are NOT the same `{grade}-w{n}` shape
  // the paste parser produces. That is deliberate: a starter pack must never
  // silently overwrite a week a family typed in themselves (see the "bulk
  // re-pastes must be cumulative" bug pattern in docs/HANDOFF.md — same
  // collision hazard, opposite direction).
  //
  // WORD ids are deterministic (`starter-{grade}-w{n}-{index}`) rather than
  // randomly generated, and that is load-bearing, not a style choice.
  // loadProgressForWeek() reconciles a stored progress doc against the
  // catalog BY WORD ID. With random ids, re-importing the same starter pack
  // (or a second device importing it independently) would mint brand new ids
  // for the same words, so every stored stat would fail to match and the
  // child's entire history for those weeks would silently reset to zero.
  // Deterministic ids make import idempotent and safe to repeat.
  //
  // startDate anchors week 1 to the Monday of the current week so the app's
  // existing computeAutoWeek() "nearest past start date" logic lands a new
  // student on week 1 immediately rather than on a week that hasn't started.
  function toWeeks(grade, mondayOfThisWeek, dateToStr) {
    const pack = packFor(grade);
    if (!pack) return [];
    return pack.weeks.map((week, i) => {
      const start = new Date(mondayOfThisWeek + "T00:00:00");
      start.setDate(start.getDate() + i * 7);
      const weekId = `starter-${pack.grade}-w${i + 1}`;
      const words = [];
      week.vocab.forEach(([text, definition], j) => {
        words.push({ id: `${weekId}-v${j}`, text, definition });
      });
      week.spelling.forEach((text, j) => {
        words.push({ id: `${weekId}-s${j}`, text, definition: "" });
      });
      return {
        id: weekId,
        grade: pack.grade,
        weekNumber: i + 1,
        weekStartDate: dateToStr(start),
        label: `${pack.label} · Week ${i + 1}`,
        words,
      };
    });
  }

  return { PACKS, packFor, toWeeks };
})();
