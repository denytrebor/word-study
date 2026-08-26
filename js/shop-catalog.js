// Static Star Shop catalog — avatars and themes. Pure data, no Firestore
// dependency, so it can be edited/extended without touching sync logic.
// Ids are namespaced ("avatar:id" / "theme:id") when stored in a profile's
// `unlocks` array (see app.js).
const ShopCatalog = (function () {
  // The first 10 are the free default rotation new profiles are assigned
  // from (app.js still owns that assignment) — price 0 here just means
  // "already owned by everyone," so the shop can show them as equippable
  // without a purchase step.
  const AVATARS = [
    { id: "fox", emoji: "🦊", price: 0 },
    { id: "koala", emoji: "🐨", price: 0 },
    { id: "frog", emoji: "🐸", price: 0 },
    { id: "lion", emoji: "🦁", price: 0 },
    { id: "tiger", emoji: "🐯", price: 0 },
    { id: "panda", emoji: "🐼", price: 0 },
    { id: "owl", emoji: "🦉", price: 0 },
    { id: "turtle", emoji: "🐢", price: 0 },
    { id: "penguin", emoji: "🐧", price: 0 },
    { id: "unicorn", emoji: "🦄", price: 0 },
    { id: "octopus", emoji: "🐙", price: 25 },
    { id: "trex", emoji: "🦖", price: 25 },
    { id: "dragon", emoji: "🐉", price: 25 },
    { id: "eagle", emoji: "🦅", price: 25 },
    { id: "wolf", emoji: "🐺", price: 25 },
    { id: "shark", emoji: "🦈", price: 25 },
    { id: "rocket", emoji: "🚀", price: 60 },
    { id: "wizard", emoji: "🧙", price: 60 },
    { id: "superhero", emoji: "🦸", price: 60 },
    { id: "robot", emoji: "🤖", price: 60 },
    { id: "crown", emoji: "👑", price: 60 },
    { id: "rainbow", emoji: "🌈", price: 150, legendary: true },
    { id: "lightning", emoji: "⚡", price: 150, legendary: true },
    { id: "fire", emoji: "🔥", price: 150, legendary: true },
  ];

  // Character avatars — real illustrated art in `assets/avatars/<id>.webp`,
  // sliced (with real per-pixel alpha, no background-removal guesswork) from
  // three reference sheets the user supplied 2026-08-25/26. Unlike AVATARS
  // (whose stored value IS the emoji character), an equipped character is
  // stored as the string "char:<id>" so the two kinds can coexist in the same
  // `equippedAvatar` field — see avatarHtml() in app.js.
  //
  // Every field here is a DEFAULT. What's actually active and what it costs
  // right now is decided by the parent in the Manage Avatars screen and
  // stored separately (see ShopConfig in app.js) — this array is only the
  // catalog of what exists and where it starts out, never what's live.
  //
  //   tier: "standard" — the everyday storefront. Always purchasable once
  //         active, no rotation semantics.
  //   tier: "chase"     — expensive, meant to be rotated in/out on purpose
  //         (see docs/HANDOFF.md "Chase avatars"). `defaultActive: true`
  //         marks the one or two the parent keeps up always; the rest start
  //         off and wait in the pool until the parent rotates them in.
  //
  // Pricing model (set 2026-08-26 per explicit user direction): illustrated
  // characters are the premium option, emoji avatars are the cheap everyday
  // option — NOT the other way around, and not comparable. Only 4 standard
  // characters are active by default (a "baseline" row: one boy and one girl
  // at each of two skin tones, so the affordable option is diverse from the
  // start) at 50⭐, roughly on par with the emoji tier. Every other standard
  // character starts inactive at 100-220⭐ — well above the emoji ceiling of
  // 150 — so if a parent rotates one in via Manage Avatars it reads as a
  // genuine step up, not a lateral move. All 68 non-baseline standard
  // characters stay in the catalog either way; only their `defaultActive`
  // changed, so a parent who already turned extras on keeps them (Manage
  // Avatars overrides persist independently of these defaults).
  const CHARACTERS = [
    // --- chase tier: rotate most of these, keep a couple always up -------
    { id: "angel-knight-boy", label: "Angel Knight", tier: "chase", defaultPrice: 350, defaultActive: true },
    { id: "phoenix-rider-girl", label: "Phoenix Rider", tier: "chase", defaultPrice: 350, defaultActive: true },
    { id: "angel-priestess-girl", label: "Angel Priestess", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "shadow-reaper", label: "Shadow Reaper", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "ice-queen-girl", label: "Ice Queen", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "fire-dragon-rider-boy", label: "Fire Dragon Rider", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "mecha-cyber-girl", label: "Mecha Cyber", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "elf-druid-girl", label: "Elf Druid", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "space-paladin-boy", label: "Space Paladin", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "lion-knight-girl", label: "Lion Knight", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "dark-dragon-rider-girl", label: "Dark Dragon Rider", tier: "chase", defaultPrice: 350, defaultActive: false },
    { id: "cyber-ninja-boy", label: "Cyber Ninja", tier: "chase", defaultPrice: 350, defaultActive: false },

    // --- standard tier: the baseline row (only 4 active by default) -------
    // One boy + one girl at each of two skin tones — the deliberately
    // diverse, deliberately small "starter" set. Everything else in
    // "standard" below starts off; a parent expands the row via Manage
    // Avatars, not by having 50+ options dumped in the shop on day one.
    { id: "basketball-boy", label: "Baller", tier: "standard", defaultPrice: 50, defaultActive: true },
    { id: "karate-boy", label: "Karate Kid", tier: "standard", defaultPrice: 50, defaultActive: true },
    { id: "cheerleader-girl", label: "Cheerleader", tier: "standard", defaultPrice: 50, defaultActive: true },
    { id: "doctor-girl", label: "Doctor", tier: "standard", defaultPrice: 50, defaultActive: true },

    // --- standard tier: everything else, inactive until rotated in -------
    { id: "skater-girl", label: "Skater", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "baker-girl", label: "Baker", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "musician-boy", label: "Musician", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "painter-girl", label: "Painter", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "artist-girl", label: "Artist", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "scientist-boy", label: "Scientist", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "scientist-girl", label: "Chemist", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "construction-boy", label: "Builder", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "football-boy", label: "Football Star", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "soccer-boy", label: "Striker", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "soccer-girl", label: "Midfielder", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "police-boy", label: "Police Officer", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "police-girl", label: "Police Chief", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "firefighter-boy", label: "Firefighter", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "firefighter-boy-2", label: "Fire Captain", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "safari-boy", label: "Safari Guide", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "safari-girl", label: "Ranger", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "explorer-boy", label: "Explorer", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "gamer-boy", label: "Gamer", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "gamer-headphones-boy", label: "Streamer", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "wheelchair-girl", label: "Racer", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "unicorn-onesie-girl", label: "Unicorn Onesie", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "martial-artist-girl", label: "Martial Artist", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "hoverboard-boy", label: "Hoverboarder", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "robot-heart", label: "Care Bot", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "robot-thumbsup", label: "Buddy Bot", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "robot-buddy", label: "Wave Bot", tier: "standard", defaultPrice: 100, defaultActive: false },
    { id: "nurse-robot", label: "Nurse Bot", tier: "standard", defaultPrice: 100, defaultActive: false },

    { id: "ninja-boy", label: "Ninja", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "ninja-girl", label: "Kunoichi", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "pirate-boy", label: "Pirate Captain", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "pirate-girl", label: "Pirate Queen", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "pirate-girl-2", label: "First Mate", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "viking-boy", label: "Viking", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "viking-girl", label: "Shieldmaiden", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "samurai-boy", label: "Samurai", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "samurai-girl", label: "Samurai Blade", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "archer-elf-boy", label: "Elf Archer", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "archer-elf-girl", label: "Elf Ranger", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "astronaut-boy", label: "Astronaut", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "astronaut-girl", label: "Cosmonaut", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "astronaut-girl-2", label: "Space Cadet", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "prince-boy", label: "Prince", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "knight-shield-boy", label: "Knight", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "paladin-boy", label: "Paladin", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "paladin-girl", label: "Paladin Guard", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "green-wizard-boy", label: "Sage", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "wizard-boy", label: "Wizard", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "witch-girl", label: "Witch", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "forest-girl", label: "Forest Guardian", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "baby-dragon-green", label: "Dragon Hatchling", tier: "standard", defaultPrice: 150, defaultActive: false },
    { id: "skater-boy", label: "Skateboarder", tier: "standard", defaultPrice: 150, defaultActive: false },

    { id: "cyber-cat-girl", label: "Cyber Cat", tier: "standard", defaultPrice: 220, defaultActive: false },
    { id: "cyber-fairy-girl", label: "Cyber Fairy", tier: "standard", defaultPrice: 220, defaultActive: false },
    { id: "frost-warrior", label: "Frost Warrior", tier: "standard", defaultPrice: 220, defaultActive: false },
    { id: "dragon-rider-blue-boy", label: "Dragon Rider", tier: "standard", defaultPrice: 220, defaultActive: false },
  ];

  // vars are CSS custom-property overrides applied via [data-theme="<id>"]
  // on <html> (see css/style.css) — the default (indigo) theme needs no
  // entry here since it IS :root's baseline and needs no data-theme attr.
  // Every theme but Galaxy only touches --primary/--primary-dark/--accent/
  // --bg, leaving --text/--card/--border/--muted shared so contrast stays
  // safe by construction. Galaxy's near-black --bg would leave the default
  // dark --text and light --border/--muted illegible, so it overrides those
  // too — a deliberate, spec-called-out exception, not scope creep.
  const THEMES = [
    { id: "ocean", label: "Ocean", price: 40, swatch: "#0e7490" },
    { id: "forest", label: "Forest", price: 40, swatch: "#15803d" },
    { id: "sunset", label: "Sunset", price: 40, swatch: "#ea580c" },
    { id: "galaxy", label: "Galaxy", price: 40, swatch: "#7c3aed" },
    { id: "bubblegum", label: "Bubblegum", price: 40, swatch: "#db2777" },
    { id: "gold", label: "Gold", price: 120, swatch: "#b45309" },
  ];

  return { AVATARS, CHARACTERS, THEMES };
})();
