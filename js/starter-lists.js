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
      // Real curriculum content, not synthetic filler like the other grades'
      // packs — transcribed and independently fact-checked from a physical
      // Abeka-style spelling workbook (Lists 3-8 and 10; List 9 was that
      // workbook's own review unit and was skipped since it only recombines
      // words already covered here). Each week keeps the workbook's full word
      // count instead of being trimmed to the ~8+4 convention the other packs
      // use, since cutting real content down to match placeholder-pack sizing
      // would throw away words the child's actual curriculum expects them to
      // learn. Bible-book spelling words (e.g. "Deuteronomy") are kept as
      // plain spelling entries with their printed abbreviation dropped, since
      // the abbreviation is a workbook reference note, not part of the word.
      description: "A real Abeka-style spelling curriculum, transcribed from a physical workbook.",
      weeks: [
        {
          // Spelling List 3
          spelling: ["reapplying", "refrigerator", "rehearsal", "relapse", "relinquish", "resign", "boastful", "harmful", "neglectful", "plentiful", "purposeful", "suspenseful", "dedicate", "dictation", "dictator", "diction", "indicate", "indictment", "verdict", "vindicate", "Deuteronomy", "Joshua"],
          vocab: [
            ["consequences", "the results of some previous action"],
            ["conveniences", "things that add comfort or save trouble"],
            ["hues", "the basic names of colors"],
            ["inquiries", "questions; searches for answers"],
            ["missionaries", "those sent with the purpose of spreading the Gospel"],
            ["opportunities", "favorable circumstances; chances for advancements"],
            ["prophecies", "revelations about the future"],
            ["similarities", "likenesses"],
          ],
        },
        {
          // Spelling List 4
          spelling: ["incomplete", "inconvenient", "inefficient", "infrequent", "injustice", "involuntary", "emphatic", "microscopic", "Olympics", "optimistic", "pessimistic", "therapeutic", "fundraiser", "profound", "unfounded", "forceful", "fortification", "fortified", "reinforcement", "uncomfortable", "Judges", "Ruth"],
          vocab: [
            ["agrarian", "having to do with farming"],
            ["conservation", "management or preservation of natural resources"],
            ["cultivate", "to plow and prepare land for planting crops"],
            ["erosion", "the wearing and carrying away of soil or rock by water or wind"],
            ["foliage", "the leaves of a plant"],
            ["hybrid", "a cross between two different species"],
            ["irrigation", "a system designed to supply land with water"],
            ["vegetation", "plant life"],
          ],
        },
        {
          // Spelling List 5
          spelling: ["misaligned", "miscalculate", "misconceive", "misdiagnose", "misjudge", "mismanage", "churchgoers", "comforter", "gardener", "minister", "plumber", "recliner", "evacuate", "evacuee", "vacancy", "conjure", "injurious", "jurisdiction", "juror", "jury", "1 and 2 Samuel", "1 and 2 Kings"],
          vocab: [
            ["alumni", "graduates of a school or college"],
            ["bacteria", "microscopic, single-celled organisms"],
            ["crises", "uncertain or challenging times often resulting from change or trouble"],
            ["criteria", "standards or rules by which things can be judged"],
            ["fungi", "plants which do not contain chlorophyll and cannot make their own food"],
            ["larvae", "immature insects that do not look like adult insects"],
            ["media", "newspapers, television, and other such means of mass communication"],
            ["phenomena", "facts, events, or circumstances that can be observed"],
          ],
        },
        {
          // Spelling List 6
          spelling: ["pre-algebra", "preamble", "prearranged", "predetermined", "predicate", "preoccupied", "assignment", "commandment", "equipment", "fragment", "parliament", "sediment", "consent", "dissent", "nonsensical", "resent", "sensitize", "sensor", "sentimental", "sentinel", "1 and 2 Chronicles", "Ezra"],
          vocab: [
            ["barbecue", "meat roasted over an open fire; a party or picnic where such meat is served"],
            ["carbohydrates", "food nutrients that provide cells with energy"],
            ["delicatessen", "a store that sells prepared food such as sandwiches, salads, cheese, or pickles"],
            ["gourmet", "relating to food of fine quality"],
            ["herbs", "leaves of certain plants used in cooking to add flavor to food"],
            ["nutritious", "useful to the body as food"],
            ["protein", "a nutrient which helps the body grow, repair, and replace cells and that helps build muscle tissue"],
            ["sauté", "to fry lightly and quickly"],
          ],
        },
        {
          // Spelling List 7
          spelling: ["debris", "deciduous", "declarative", "decrease", "despondent", "devalue", "eagerness", "effectiveness", "fitness", "godliness", "gratefulness", "worldliness", "evident", "provide", "providence", "supervise", "television", "video", "visionary", "visual", "Nehemiah", "Esther"],
          vocab: [
            ["encore", "an extra song or appearance in response to applause"],
            ["octave", "the eight notes in a musical scale"],
            ["opera", "a play in which most of the lines are sung"],
            ["orchestra", "a large group of musicians playing string, woodwind, brass, and percussion instruments"],
            ["quartet", "a group of four singers or musicians who perform together"],
            ["soloist", "a musician who performs alone"],
            ["sonata", "a long piece of music for one or two instruments"],
            ["tempo", "the speed of a musical composition"],
          ],
        },
        {
          // Spelling List 8
          spelling: ["foreboding", "foreground", "forerunner", "foresee", "foreshadow", "forewarn", "championship", "citizenship", "kinship", "leadership", "relationship", "sponsorship", "aquamarine", "aquatic", "aqueduct", "aqueous", "aquifer", "reviving", "survived", "viable", "Job", "Psalms"],
          vocab: [
            ["aerobics", "exercises that help the body use oxygen efficiently"],
            ["calisthenics", "exercises to develop muscle tone, usually done without equipment"],
            ["diversion", "something that relaxes and entertains"],
            ["gymnastics", "an acrobatic sport that uses special equipment to display balance and strength"],
            ["regimen", "a routine, as of diet or exercise, that is strictly followed"],
            ["rivalry", "competition"],
            ["sportsmanship", "conduct in sports that demonstrates fairness in winning and losing"],
            ["tournament", "a series of contests in some sport"],
          ],
        },
        {
          // Spelling List 10 (List 9 was a review unit, deliberately skipped)
          spelling: ["submarine", "substandard", "subtitle", "subtrahend", "subtropical", "suburban", "subzero", "brilliantly", "conveniently", "daily", "erroneously", "mightily", "nobly", "relentlessly", "audible", "audio", "audiologist", "audition", "auditory", "abbreviate", "abridge", "brevity", "briefly", "Proverbs", "Ecclesiastes"],
          vocab: [
            ["archipelago", "a group of many islands"],
            ["delta", "the fertile land that collects at the mouth of some rivers"],
            ["equator", "the imaginary line around the earth equally distant from the poles"],
            ["estuary", "the place where the river meets the sea and fresh water mixes with salt water"],
            ["isthmus", "a narrow strip of land connecting two larger bodies of land"],
            ["legend", "the key that explains the pictures and symbols on a map"],
            ["plateau", "a plain in the mountains; tableland"],
            ["torrid", "extremely hot"],
            ["tributary", "a stream that flows into a larger body of water"],
            ["tropics", "the regions north and south near the equator"],
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
