const CACHE_NAME = "word-study-v24";
// Character avatars are precached so an equipped character still shows up
// offline, active-in-shop or not (a kid's already-equipped avatar must keep
// rendering even after a parent deactivates it in Manage Avatars). addAll()
// rejects the whole install if ANY entry 404s — keep this list in sync with
// js/shop-catalog.js CHARACTERS and assets/avatars/.
const CHARACTER_AVATARS = [
  "angel-knight-boy", "angel-priestess-girl", "archer-elf-boy", "archer-elf-girl",
  "artist-girl", "astronaut-boy", "astronaut-girl", "astronaut-girl-2",
  "baby-dragon-green", "baker-girl", "basketball-boy", "cheerleader-girl",
  "construction-boy", "cyber-cat-girl", "cyber-fairy-girl", "cyber-ninja-boy",
  "dark-dragon-rider-girl", "doctor-girl", "dragon-rider-blue-boy", "elf-druid-girl",
  "explorer-boy", "fire-dragon-rider-boy", "firefighter-boy", "firefighter-boy-2",
  "football-boy", "forest-girl", "frost-warrior", "gamer-boy", "gamer-headphones-boy",
  "green-wizard-boy", "hoverboard-boy", "ice-queen-girl", "karate-boy",
  "knight-shield-boy", "lion-knight-girl", "martial-artist-girl", "mecha-cyber-girl",
  "musician-boy", "ninja-boy", "ninja-girl", "nurse-robot", "painter-girl",
  "paladin-boy", "paladin-girl", "phoenix-rider-girl", "pirate-boy", "pirate-girl",
  "pirate-girl-2", "police-boy", "police-girl", "prince-boy", "robot-buddy",
  "robot-heart", "robot-thumbsup", "safari-boy", "safari-girl", "samurai-boy",
  "samurai-girl", "scientist-boy", "scientist-girl", "shadow-reaper", "skater-boy",
  "skater-girl", "soccer-boy", "soccer-girl", "space-paladin-boy", "unicorn-onesie-girl",
  "viking-boy", "viking-girl", "wheelchair-girl", "witch-girl", "wizard-boy",
].map((id) => `./assets/avatars/${id}.webp`);
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/sync.js",
  "./js/shop-catalog.js",
  "./js/starter-lists.js",
  "./js/vendor/qrcode.js",
  "./js/firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
].concat(CHARACTER_AVATARS);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: always try to fetch the latest version when online, so app
// updates show up on the next load instead of waiting an extra reload cycle.
// Falls back to the cache when offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Only this origin's own assets are ours to cache. Cross-origin traffic
  // (the Firebase SDK from gstatic, Firestore/Auth API calls) is left to the
  // network and the browser's own HTTP cache — caching opaque cross-origin
  // responses here would serve them back offline with no way to validate them.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Never cache a non-2xx: a transient 404/500 during a deploy would
        // otherwise be stored and then served as the "offline" answer later.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
