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

  return { AVATARS, THEMES };
})();
