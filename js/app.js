(function () {
  "use strict";

  /* ---------------------------------------------------------------------
   * Storage helpers
   * ------------------------------------------------------------------- */
  const PROFILES_KEY = "ws_profiles";
  const ACTIVE_KEY = "ws_active_profile";
  const LOCAL_CATALOG = "__local__";

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getProfiles() { return load(PROFILES_KEY, []); }
  function saveProfiles(list) { save(PROFILES_KEY, list); }
  function getActiveProfileId() { return localStorage.getItem(ACTIVE_KEY); }
  function setActiveProfileId(id) { localStorage.setItem(ACTIVE_KEY, id); }

  function firestoreReady() {
    return typeof Sync !== "undefined" && !!Sync.getHouseholdCode();
  }

  // The catalog code this household is using — a fully offline/local-only
  // device (no household connected) gets one implicit private catalog with
  // no code to manage at all.
  function getCatalogCode() {
    if (firestoreReady() && typeof Sync !== "undefined") return Sync.getCatalogCode();
    return LOCAL_CATALOG;
  }

  function catalogWeeksKey(code) { return `ws_catalog_weeks_${code}`; }
  function progressKey(profileId, weekId) { return `ws_progress_${profileId}_${weekId}`; }
  function progressIndexKey(profileId) { return `ws_progress_index_${profileId}`; }
  function selectedWeekKey(profileId) { return `ws_selected_week_${profileId}`; }
  function activityKey(profileId, date) { return `ws_activity_${profileId}_${date}`; }

  function saveProgressLocal(profileId, weekId, progress) {
    save(progressKey(profileId, weekId), progress);
    const idx = load(progressIndexKey(profileId), []);
    if (!idx.includes(weekId)) { idx.push(weekId); save(progressIndexKey(profileId), idx); }
  }
  function saveProgress(profileId, weekId, progress) {
    saveProgressLocal(profileId, weekId, progress);
    if (firestoreReady()) scheduleProgressPush(profileId, weekId, progress);
  }

  function updateLocalProfileFields(id, fields) {
    const profiles = getProfiles();
    const p = profiles.find((x) => x.id === id);
    if (p) { Object.assign(p, fields); saveProfiles(profiles); }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function slugify(s) {
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "g";
  }

  // Real curriculum content includes multi-word entries ("1 and 2 Samuel") —
  // collapsing any run of whitespace to one space (not just trimming the
  // ends) before comparing keeps a word typed with a stray double space or
  // trailing newline (mobile autocomplete does this) from grading wrong for
  // a reason that has nothing to do with spelling.
  function normalizeSpelling(s) {
    return String(s).trim().replace(/\s+/g, " ").toLowerCase();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Local-calendar-date strings (not UTC) — using toISOString() here would
  // shift the date for anyone east of UTC, and could roll "today" over
  // hours early/late for anyone west of it.
  function dateToLocalStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function todayLocalStr() { return dateToLocalStr(new Date()); }

  function generateCode(len) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function localDateMinusDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - n);
    return dateToLocalStr(d);
  }

  // Monday-Sunday dates for the calendar week containing dateStr.
  function weekDatesMonToSun(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(monday.getDate() + mondayOffset);
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const cur = new Date(monday);
      cur.setDate(cur.getDate() + i);
      dates.push(dateToLocalStr(cur));
    }
    return dates;
  }

  // Sunday-Saturday dates for the calendar week containing dateStr. The parent
  // dashboard uses this one rather than weekDatesMonToSun() because its week
  // strip is the only week in the app that is actually LABELED for a human
  // ("S M Tu W Th F Sa"), and a Sunday-first row is what a parent reads a
  // calendar as. Home's streak dots stay Monday-first: they carry no labels, so
  // the difference is invisible there, and mondayOfThisWeek() (starter-list
  // import) depends on that helper meaning exactly what its name says.
  function weekDatesSunToSat(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const sunday = new Date(d);
    sunday.setDate(sunday.getDate() - d.getDay()); // getDay(): 0=Sun..6=Sat
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const cur = new Date(sunday);
      cur.setDate(cur.getDate() + i);
      dates.push(dateToLocalStr(cur));
    }
    return dates;
  }

  /* ---------------------------------------------------------------------
   * App state
   * ------------------------------------------------------------------- */
  const state = {
    profile: null,       // active profile {id, name, avatar, stars, grade}
    catalogWeeks: [],     // every week in the connected catalog, all grades
    selectedWeek: null,   // the catalog week currently being studied
    progress: null,       // this profile's per-word stats for selectedWeek
    activity: null,       // today's activity doc for this profile (see §3)
    parentProfile: null,  // the parent profile currently viewing the dashboard, if any
  };

  /* ---------------------------------------------------------------------
   * Speech: text-to-speech + speech-to-text
   * ------------------------------------------------------------------- */
  const VOICE_KEY = "ws_voice_uri";
  function getSavedVoiceURI() { return localStorage.getItem(VOICE_KEY) || ""; }
  function setSavedVoiceURI(uri) { localStorage.setItem(VOICE_KEY, uri); }

  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.85;
      u.pitch = 1;
      u.lang = "en-US";
      const savedURI = getSavedVoiceURI();
      if (savedURI) {
        const match = window.speechSynthesis.getVoices().find((v) => v.voiceURI === savedURI);
        if (match) u.voice = match;
      }
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  // A device-level setting (not per-profile) — voice availability depends on
  // the browser/OS, not on who's using the app. Chrome often returns an
  // empty voice list on first call and fires "voiceschanged" once it's
  // actually loaded, so this populates both eagerly and on that event.
  function populateVoiceSelect() {
    if (!("speechSynthesis" in window)) return;
    const select = document.getElementById("voice-select");
    const wrap = document.getElementById("voice-picker");
    if (!select || !wrap) return;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    const sorted = voices.slice().sort((a, b) => {
      const aEn = a.lang.toLowerCase().startsWith("en") ? 0 : 1;
      const bEn = b.lang.toLowerCase().startsWith("en") ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      return a.name.localeCompare(b.name);
    });
    const saved = getSavedVoiceURI();
    const options = ['<option value="">Default</option>']
      .concat(sorted.map((v) => `<option value="${escapeAttr(v.voiceURI)}">${escapeAttr(v.name)} (${escapeAttr(v.lang)})</option>`));
    select.innerHTML = options.join("");
    select.value = saved && sorted.some((v) => v.voiceURI === saved) ? saved : "";
    wrap.classList.remove("hidden");
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = populateVoiceSelect;
    populateVoiceSelect();
  }
  document.getElementById("voice-select").addEventListener("change", (e) => {
    setSavedVoiceURI(e.target.value);
    speak("This is your reading voice.");
  });

  const SpeechRecCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const micSupported = !!SpeechRecCtor;

  function attachMic(btnEl, inputEl) {
    if (!micSupported || !btnEl) return;
    btnEl.classList.remove("hidden");
    let recognizing = false;
    let recognizer = null;

    btnEl.addEventListener("click", () => {
      if (recognizing) return;
      recognizer = new SpeechRecCtor();
      recognizer.lang = "en-US";
      recognizer.continuous = false;
      recognizer.interimResults = false;
      recognizer.maxAlternatives = 1;

      recognizer.onstart = () => {
        recognizing = true;
        btnEl.classList.add("recording");
      };
      recognizer.onresult = (e) => {
        const transcript = e.results[0][0].transcript || "";
        const clean = transcript.trim().replace(/[.,!?]+$/, "");
        inputEl.value = clean;
        // Safari/WebKit sometimes won't repaint a programmatic value change
        // on an unfocused input until focus + selection are forced.
        inputEl.focus();
        try { inputEl.setSelectionRange(clean.length, clean.length); } catch (err) { /* ignore */ }
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      };
      recognizer.onerror = () => { /* ignore, let them type instead */ };
      recognizer.onend = () => {
        recognizing = false;
        btnEl.classList.remove("recording");
      };
      try { recognizer.start(); } catch (e) { recognizing = false; }
    });
  }

  /* ---------------------------------------------------------------------
   * Toast + navigation
   * ------------------------------------------------------------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.classList.add("hidden"), 250);
    }, 1800);
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById("screen-" + id).classList.add("active");
    const header = document.getElementById("app-header");
    header.classList.toggle("hidden", id === "profiles" || id === "household" || id === "parent-dashboard" || id === "manage-avatars" || id === "legal" || id === "class-roster" || id === "class-info" || id === "school-overview");
    endRetype();
    clearBuddy();
    window.scrollTo(0, 0);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  // equippedAvatar replaces the legacy `avatar` field at display time —
  // profiles that never opened the shop (e.g. Micah's existing doc) keep
  // working untouched since this just falls back to `avatar`.
  function avatarFor(profile) {
    return (profile && (profile.equippedAvatar || profile.avatar)) || "🙂";
  }

  // An avatar value is either an emoji character (the original shop) or
  // "char:<id>" pointing at illustrated art in assets/avatars (the character
  // shop). Every place that shows an avatar goes through this so the two
  // kinds render side by side — never assume the value is safe text, an
  // unknown "char:" id must not become a broken <img> with a raw src.
  function avatarHtml(profile) {
    const value = avatarFor(profile);
    if (typeof value === "string" && value.indexOf("char:") === 0) {
      const id = value.slice(5);
      const item = ShopCatalog.CHARACTERS.find((c) => c.id === id);
      if (item) {
        return `<img class="avatar-img" src="assets/avatars/${item.id}.webp" alt="${escapeAttr(item.label)}">`;
      }
      return "🙂"; // catalog entry gone (or synced from a newer build) — don't emit a dead image
    }
    return escapeAttr(value);
  }

  function refreshHeader() {
    if (!state.profile) return;
    document.getElementById("header-avatar").innerHTML = avatarHtml(state.profile) + " ";
    document.getElementById("header-name-text").textContent = state.profile.name;
    document.getElementById("header-stars-count").textContent = state.profile.stars || 0;
    refreshSyncStatus();
  }

  // A3: debounced, not immediate — persistProfile() runs on EVERY correct
  // answer (via addStars), and an unbatched Firestore write per answer was
  // roughly 3x the write volume the school-scale capacity math assumed. The
  // local save above is still synchronous and unconditional, so nothing the
  // kid sees ever waits on this; only the network write is delayed, and only
  // up to SYNC_DEBOUNCE_MS — flushPendingSyncPushes() (called from
  // flushActivity, which already fires at session end, every 10th answer,
  // and tab-hidden) force-flushes it sooner whenever one of those moments
  // that must not lose data happens first.
  const SYNC_DEBOUNCE_MS = 2000;
  let pendingProfilePush = null;
  let profilePushTimer = null;
  function scheduleProfilePush(profile) {
    pendingProfilePush = profile;
    clearTimeout(profilePushTimer);
    profilePushTimer = setTimeout(flushPendingSyncPushes, SYNC_DEBOUNCE_MS);
  }

  let pendingProgressPush = null; // { profileId, weekId, progress }
  let progressPushTimer = null;
  function scheduleProgressPush(profileId, weekId, progress) {
    pendingProgressPush = { profileId, weekId, progress };
    clearTimeout(progressPushTimer);
    progressPushTimer = setTimeout(flushPendingSyncPushes, SYNC_DEBOUNCE_MS);
  }

  // The one place both debounced pushes actually reach Firestore. Safe to
  // call often (session-exit handlers all over the app already call
  // flushActivity() unconditionally) — a no-op when nothing is pending.
  function flushPendingSyncPushes() {
    clearTimeout(profilePushTimer);
    profilePushTimer = null;
    if (pendingProfilePush) { trackSyncWrite(Sync.pushProfile(pendingProfilePush)); pendingProfilePush = null; }
    clearTimeout(progressPushTimer);
    progressPushTimer = null;
    if (pendingProgressPush) {
      trackSyncWrite(Sync.pushProgress(pendingProgressPush.profileId, pendingProgressPush.weekId, pendingProgressPush.progress));
      pendingProgressPush = null;
    }
  }

  // B6: a synced/pending/offline dot in the header — everything currently
  // syncs fire-and-forget with failures reaching only console.warn, so on
  // flaky school wifi a kid's stars visibly go up locally while the parent
  // dashboard, reading from Firestore, still says "never practiced," with no
  // on-screen hint why. Only tracks the hot per-answer writes funneled
  // through flushPendingSyncPushes above (now that pushProfile/pushProgress
  // return their settled write promise instead of firing and forgetting) —
  // rare one-off admin writes (a rename, a catalog save) already surface
  // their own toast and don't need an ambient indicator.
  let pendingSyncWrites = 0;
  function trackSyncWrite(promise) {
    pendingSyncWrites++;
    refreshSyncStatus();
    Promise.resolve(promise).finally(() => {
      pendingSyncWrites = Math.max(0, pendingSyncWrites - 1);
      refreshSyncStatus();
    });
  }
  function refreshSyncStatus() {
    const dot = document.getElementById("sync-status-dot");
    if (!dot) return;
    if (!firestoreReady()) { dot.classList.add("hidden"); return; }
    dot.classList.remove("hidden", "sync-online", "sync-pending", "sync-offline");
    if (!navigator.onLine) { dot.classList.add("sync-offline"); dot.title = "Offline — saved on this device, will sync later"; }
    else if (pendingSyncWrites > 0) { dot.classList.add("sync-pending"); dot.title = "Syncing…"; }
    else { dot.classList.add("sync-online"); dot.title = "Synced"; }
  }
  window.addEventListener("online", refreshSyncStatus);
  window.addEventListener("offline", refreshSyncStatus);

  function persistProfile() {
    if (!state.profile) return;
    const profiles = getProfiles();
    const idx = profiles.findIndex((p) => p.id === state.profile.id);
    if (idx !== -1) profiles[idx] = state.profile;
    saveProfiles(profiles);
    if (firestoreReady()) scheduleProfilePush(state.profile);
  }

  // `stars` is the spendable balance (shop purchases decrement it);
  // `lifetimeStars` is monotonically increasing, so future levels/badges
  // never conflict with what's been spent.
  function addStars(n) {
    state.profile.stars = (state.profile.stars || 0) + n;
    state.profile.lifetimeStars = (state.profile.lifetimeStars || 0) + n;
    persistProfile();
    animateStarGain(n);
  }

  // Mechanic 2 ("star fly-in + count-up"): every award used to just snap the
  // header number to its new value via refreshHeader(), so a +5 bonus and a
  // +1 answer looked identical and were gone before the eye moved. addStars()
  // is the one choke point every star mutation already goes through, so
  // animating here reaches every award site for free — no per-mode wiring.
  // Deliberately does NOT call refreshHeader(): that also repaints
  // avatar/name, neither of which addStars ever changes, and re-running it
  // mid count-up would stomp the tick below back to the final value early.
  function animateStarGain(n) {
    const el = document.getElementById("header-stars");
    const countEl = document.getElementById("header-stars-count");
    if (!el || !countEl) return;
    refreshSyncStatus();
    const to = state.profile.stars || 0;
    const from = to - n;
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (n <= 0 || reduceMotion) { countEl.textContent = to; return; }
    const particle = document.createElement("span");
    particle.className = "star-particle";
    particle.textContent = "+" + n;
    el.appendChild(particle);
    setTimeout(() => particle.remove(), 900);
    const start = performance.now();
    const DURATION = 400;
    function tick(now) {
      const t = Math.min(1, (now - start) / DURATION);
      countEl.textContent = Math.round(from + (to - from) * t);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function applyTheme(themeId) {
    if (themeId) document.documentElement.setAttribute("data-theme", themeId);
    else document.documentElement.removeAttribute("data-theme");
  }

  // Escapes for both HTML text-node and double-quoted-attribute contexts —
  // every call site in this file uses one of those two. `>` and `'` were
  // historically left out (harmless in a text node or a double-quoted
  // attribute, which is everywhere this was actually used), but that made
  // the function correct only by way of every future call site happening to
  // avoid single-quoted attributes — flagged as fragile-not-broken in the
  // 2026-08-26 security review. Escaping all five now removes that
  // assumption instead of documenting it. `&` must be escaped first, or
  // escaping the others would double-escape their own `&`.
  function escapeAttr(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("Copied!")).catch(() => toast(text));
    } else {
      toast(text);
    }
  }

  // "household" or "catalog" — a link that pre-fills the matching join/
  // connect field so the recipient just has to tap a button instead of
  // typing a code by hand.
  function inviteURL(kind, code) {
    return `${location.origin}${location.pathname}?${kind}=${encodeURIComponent(code)}`;
  }

  /* ---------------------------------------------------------------------
   * CELEBRATIONS (confetti + WebAudio chimes, no external assets/CDN)
   * ------------------------------------------------------------------- */
  const MUTE_KEY = "ws_muted";
  function isMuted() { return localStorage.getItem(MUTE_KEY) === "1"; }
  function setMuted(m) { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); }

  // Self-contained canvas confetti: a fixed full-viewport canvas, particles
  // fall with gravity + drift + rotation, auto-removed after ~2.5s. No
  // external library (CSP posture here is no-CDN).
  function celebrate(intensity) {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:200;";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const colors = ["#4338ca", "#fb923c", "#16a34a", "#dc2626", "#eab308", "#ec4899"];
    const count = intensity === "big" ? 90 : 40;
    const particles = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.3,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 3,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    const duration = 2500;
    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.06;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      });
      if (elapsed < duration) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  // Lazily created (and resumed) inside a user-gesture handler — iOS Safari
  // won't let an AudioContext produce sound if it's created/started outside
  // a direct gesture handler.
  let audioCtx = null;
  function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { audioCtx = new Ctor(); } catch (e) { return null; }
    return audioCtx;
  }
  document.addEventListener("pointerdown", function unlockAudioOnce() {
    const ctx = ensureAudioContext();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    document.removeEventListener("pointerdown", unlockAudioOnce);
  }, { once: true });

  // kind: "correct" | "medal" | "purchase" | "streak" | "perfect" | "lockin" |
  // "hotstreak" | "bonusword" — a subtle single tone for plain correct
  // answers, a two-note ascending chime for medal/purchase moments, a
  // brighter three-note arpeggio for the big streak/perfect moments.
  // step (mechanic 4, "correct" only): the in-session streak count, capped at
  // 8 — nudges the correct-answer tone up a little per step so a run of hits
  // audibly climbs instead of every answer sounding identical, without ever
  // going shrill.
  function playSound(kind, step) {
    if (isMuted()) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    function tone(freq, startOffset, dur, peak, type) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + startOffset);
      gain.gain.linearRampToValueAtTime(peak, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + dur + 0.02);
    }
    if (kind === "correct") {
      tone(660 * Math.pow(2, Math.min(step || 0, 8) / 24), 0, 0.12, 0.12);
    } else if (kind === "hotstreak") {
      tone(783.99, 0, 0.1, 0.18, "triangle");
      tone(987.77, 0.08, 0.14, 0.18, "triangle");
    } else if (kind === "bonusword") {
      tone(659.25, 0, 0.1, 0.16, "triangle");
      tone(880, 0.08, 0.12, 0.16, "triangle");
      tone(1174.66, 0.16, 0.2, 0.18, "triangle");
    } else if (kind === "lockin") {
      // Deliberately warmer and lower than "correct": a retype is a repair, not a
      // hit, and giving it the same tone as a first-try correct answer would make
      // the two indistinguishable to a kid who is only listening.
      tone(493.88, 0, 0.12, 0.13);
      tone(659.25, 0.1, 0.18, 0.13);
    } else if (kind === "medal") {
      tone(523.25, 0, 0.14, 0.2);
      tone(783.99, 0.1, 0.18, 0.2);
    } else if (kind === "purchase") {
      tone(587.33, 0, 0.12, 0.2);
      tone(880, 0.09, 0.16, 0.2);
    } else if (kind === "streak") {
      tone(523.25, 0, 0.12, 0.22, "triangle");
      tone(659.25, 0.09, 0.12, 0.22, "triangle");
      tone(880, 0.18, 0.22, 0.22, "triangle");
    } else if (kind === "perfect") {
      tone(659.25, 0, 0.12, 0.22, "triangle");
      tone(830.61, 0.09, 0.12, 0.22, "triangle");
      tone(1046.5, 0.18, 0.24, 0.22, "triangle");
    }
  }

  // PRACTICE BUDDY — the equipped avatar reacts in the header to the moments the
  // reward system is already firing for. Every call site sits NEXT TO an existing
  // celebrate()/playSound() call rather than replacing one, so this stays additive
  // instrumentation on a trigger point that is already correct instead of a second
  // decision tree that could disagree with the first one about what just happened.
  // Purely visual, so deliberately NOT gated by isMuted(): mute is an audio
  // setting, and freezing the avatar because the room needs quiet would be a
  // surprise. Motion preferences are handled in CSS instead.
  const BUDDY_CLASSES = { correct: "buddy-nod", cheer: "buddy-cheer", miss: "buddy-wobble" };
  const BUDDY_CLEAR_MS = 1000; // longer than the longest keyframe (buddy-cheer, 0.9s)
  let buddyTimer = null;

  function reactBuddy(kind) {
    const el = document.getElementById("header-avatar");
    const cls = BUDDY_CLASSES[kind];
    if (!el || !cls) return;
    clearBuddy();
    // Re-adding a class the element just had does not restart a CSS animation
    // until the browser has actually recalculated layout without it, so a run of
    // fast correct answers would bounce once and then go still.
    void el.offsetWidth;
    el.classList.add(cls);
    buddyTimer = setTimeout(() => el.classList.remove(cls), BUDDY_CLEAR_MS);
  }

  // Called from showScreen() too: an animation still running when the child
  // leaves a session would otherwise ride into the next screen on a header that
  // never re-renders on navigation.
  function clearBuddy() {
    const el = document.getElementById("header-avatar");
    clearTimeout(buddyTimer);
    if (el) el.classList.remove("buddy-nod", "buddy-cheer", "buddy-wobble");
  }

  /* ---------------------------------------------------------------------
   * Word status + medals (medals are derived, never stored — see spec §2)
   * ------------------------------------------------------------------- */
  function wordStatus(w) {
    const totalAttempts = w.spelling.attempts + w.vocab.attempts;
    const totalCorrect = w.spelling.correct + w.vocab.known;
    if (totalAttempts === 0) return "new";
    return totalCorrect / totalAttempts >= 0.8 ? "solid" : "shaky";
  }

  const MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3 };
  const MEDAL_ICON = { none: "⚪", bronze: "🥉", silver: "🥈", gold: "🥇" };

  function wordMedal(w) {
    const totalCorrect = w.spelling.correct + w.vocab.known;
    const totalAttempts = w.spelling.attempts + w.vocab.attempts;
    const accuracy = totalAttempts ? totalCorrect / totalAttempts : 0;
    if (totalCorrect >= 8 && accuracy >= 0.9) return "gold";
    if (totalCorrect >= 5 && accuracy >= 0.8) return "silver";
    if (totalCorrect >= 2) return "bronze";
    return "none";
  }

  // Gamification mechanic 3 ("next-medal nudge"): the medal ladder is
  // otherwise invisible until a threshold is actually crossed, so a kid never
  // feels "one more for Silver." Mirrors wordMedal's own thresholds exactly —
  // one table, read two ways. accuracyGated: raw correct-count target is
  // already met, but the accuracy gate (silver/gold) isn't, so the NEXT
  // correct answer isn't guaranteed to move the needle — callers should word
  // that softly ("keep it up") rather than promise a number.
  const MEDAL_THRESHOLDS = { none: { next: "Bronze", correct: 2, accuracy: 0 }, bronze: { next: "Silver", correct: 5, accuracy: 0.8 }, silver: { next: "Gold", correct: 8, accuracy: 0.9 } };
  function medalProgress(w) {
    const medal = wordMedal(w);
    if (medal === "gold") return { nextMedal: null };
    const t = MEDAL_THRESHOLDS[medal];
    const totalCorrect = w.spelling.correct + w.vocab.known;
    const totalAttempts = w.spelling.attempts + w.vocab.attempts;
    const accuracy = totalAttempts ? totalCorrect / totalAttempts : 0;
    return {
      nextMedal: t.next,
      correctNeeded: Math.max(0, t.correct - totalCorrect),
      accuracyGated: totalAttempts > 0 && accuracy < t.accuracy,
    };
  }
  function medalProgressText(w) {
    const p = medalProgress(w);
    if (!p.nextMedal) return null;
    if (p.correctNeeded > 0) return `${p.correctNeeded} more for ${p.nextMedal}`;
    if (p.accuracyGated) return `Keep it up for ${p.nextMedal}`;
    return null;
  }
  // Appends the nudge to a correct-feedback element, if there's anything
  // worth saying — one helper so every practice mode's feedback block reads
  // it the same way instead of five near-duplicate string-builds.
  function appendMedalNudge(feedbackEl, w) {
    const text = medalProgressText(w);
    if (!text) return;
    const span = document.createElement("span");
    span.className = "medal-nudge";
    span.textContent = text;
    feedbackEl.appendChild(span);
  }

  // null = never practiced (so callers can sort it separately from a low-
  // but-nonzero accuracy word).
  function wordAccuracy(w) {
    const correct = w.spelling.correct + w.vocab.known;
    const attempts = w.spelling.attempts + w.vocab.attempts;
    return attempts ? correct / attempts : null;
  }

  // Every current-week word that isn't "solid," worst accuracy first,
  // never-practiced words last — the parent dashboard's "what to drill"
  // panel (spec §6).
  function wordsNeedingWork(progress) {
    if (!progress) return [];
    return progress.words
      .filter((w) => wordStatus(w) !== "solid")
      .sort((a, b) => {
        const aa = wordAccuracy(a), ba = wordAccuracy(b);
        if (aa === null && ba === null) return 0;
        if (aa === null) return 1;
        if (ba === null) return -1;
        return aa - ba;
      });
  }

  // Vocab Practice is a MEANING exercise, so it draws only from words the
  // parent actually annotated with a definition. Before this, it ran over
  // every word and showed "(No definition added for this word)" on the rest —
  // which made it a slower, more confusing copy of Look & Say. Look & Say
  // keeps every word and shows no definition at all; that's now the clean
  // split between the two modes.
  function wordsWithDefinition(progress) {
    if (!progress || !Array.isArray(progress.words)) return [];
    return progress.words.filter((w) => w && typeof w.definition === "string" && w.definition.trim());
  }

  function relativeDateLabel(dateStr) {
    if (!dateStr) return "never";
    const today = todayLocalStr();
    if (dateStr === today) return "today";
    if (dateStr === localDateMinusDays(today, 1)) return "yesterday";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  /* ---------------------------------------------------------------------
   * Activity tracking + daily streak (spec §3) — one doc per local date,
   * flush-batched (not per-answer) to stay quota-safe at classroom scale.
   * Also the star-economy anti-farming backbone for medals (spec §2).
   * ------------------------------------------------------------------- */
  const STREAK_MILESTONES = { 3: 5, 7: 10, 14: 15, 30: 25, 60: 40, 100: 75 };

  function freshActivity(date) {
    return {
      date,
      answers: 0,
      correct: 0,
      starsEarned: 0,
      starEarns: {},
      bonusRoundsToday: 0,
      bonusWordsToday: 0,
      modes: { spelling: 0, vocab: 0, scramble: 0, test: 0, speed: 0, flashcard: 0 },
      weekIds: [],
    };
  }

  // Lazily (re)loads today's activity doc into state.activity — safe to call
  // often; only reloads when the profile changes or the local date rolls over.
  function getOrInitActivity() {
    const date = todayLocalStr();
    if (!state.profile) return null;
    if (!state.activity || state.activity.date !== date || state.activity._profileId !== state.profile.id) {
      const loaded = load(activityKey(state.profile.id, date), null);
      state.activity = loaded || freshActivity(date);
      state.activity._profileId = state.profile.id;
    }
    return state.activity;
  }

  // A4: getOrInitActivity() only ever reads localStorage, so a second device
  // starts today's activity doc from zero — every cap (per-word, bonus-round,
  // daily-goal, first-practice) resets, and pushActivity's merge:true would
  // then let that smaller doc silently overwrite a bigger one server-side.
  // Called once per profile-select (see selectProfile): fold today's remote
  // doc into the local one by taking the max of every counter/map entry and
  // OR-ing every boolean flag, so nothing already earned on another device
  // can be lost or reset just by opening the app somewhere else.
  function mergeActivityDocs(local, remote) {
    if (!remote) return local;
    const merged = Object.assign({}, local);
    merged.answers = Math.max(local.answers || 0, remote.answers || 0);
    merged.correct = Math.max(local.correct || 0, remote.correct || 0);
    merged.starsEarned = Math.max(local.starsEarned || 0, remote.starsEarned || 0);
    merged.bonusRoundsToday = Math.max(local.bonusRoundsToday || 0, remote.bonusRoundsToday || 0);
    merged.bonusWordsToday = Math.max(local.bonusWordsToday || 0, remote.bonusWordsToday || 0);
    merged.goalAwarded = !!local.goalAwarded || !!remote.goalAwarded;
    merged.starEarns = Object.assign({}, remote.starEarns, local.starEarns);
    Object.keys(remote.starEarns || {}).forEach((id) => {
      merged.starEarns[id] = Math.max((local.starEarns || {})[id] || 0, remote.starEarns[id] || 0);
    });
    merged.modes = Object.assign({}, local.modes);
    Object.keys(remote.modes || {}).forEach((m) => {
      merged.modes[m] = Math.max((local.modes || {})[m] || 0, (remote.modes || {})[m] || 0);
    });
    merged.weekIds = Array.from(new Set([].concat(local.weekIds || [], remote.weekIds || [])));
    return merged;
  }

  function flushActivity() {
    // Already the app's one shared "this moment must not lose data" signal
    // (session end, every 10th answer, tab hidden — every call site above and
    // below) — riding on it to force-flush the debounced profile/progress
    // pushes too (see persistProfile/saveProgress) means A3's write-batching
    // needed no new call sites of its own.
    flushPendingSyncPushes();
    if (!state.activity || !state.profile) return;
    save(activityKey(state.profile.id, state.activity.date), state.activity);
    if (firestoreReady()) trackSyncWrite(Sync.pushActivity(state.profile.id, state.activity.date, state.activity));
  }

  function recordModeStart(mode) {
    if (!state.profile) return;
    const a = getOrInitActivity();
    if (!a) return;
    a.modes[mode] = (a.modes[mode] || 0) + 1;
    if (state.progress && !a.weekIds.includes(state.progress.weekId)) a.weekIds.push(state.progress.weekId);
    flushActivity();
  }

  // Streak update happens exactly once, at the first answer of a local day.
  // Mechanic 8 ("Earned Streak Shield"): a banked shield — earned by
  // studying, never bought, never managed — auto-spends on exactly one
  // missed day so the streak continues as if uninterrupted. Only ever
  // surfaces at the moment it SAVES something; never a warning about
  // running low, never a countdown toward losing the streak.
  function ensureStreakForToday() {
    const p = state.profile;
    const today = todayLocalStr();
    if (p.lastActiveDate === today) return;
    const yesterday = localDateMinusDays(today, 1);
    const twoDaysAgo = localDateMinusDays(today, 2);
    let newStreak;
    if (p.lastActiveDate === yesterday) {
      newStreak = (p.currentStreak || 0) + 1;
    } else if (p.lastActiveDate === twoDaysAgo && (p.streakShields || 0) > 0) {
      p.streakShields--;
      newStreak = (p.currentStreak || 0) + 1;
      toast("🛡️ Your shield kept your streak going!");
    } else {
      newStreak = 1;
    }
    p.currentStreak = newStreak;
    p.bestStreak = Math.max(p.bestStreak || 0, newStreak);
    p.lastActiveDate = today;
    // Banks one shield every 7 days of an active streak, capped at holding 1
    // — a 14-day streak reached while already holding one doesn't stack a
    // second. Checked after the shield-spend branch above so the very day a
    // shield saves a streak can't also bank a fresh one in the same breath.
    if (newStreak % 7 === 0 && (p.streakShields || 0) < 1) p.streakShields = (p.streakShields || 0) + 1;
    const bonus = STREAK_MILESTONES[newStreak];
    if (bonus) {
      addStars(bonus);
      toast(`🔥 ${newStreak}-day streak! +${bonus} ⭐`);
      celebrate("big");
      playSound("streak");
      reactBuddy("cheer");
    }
  }

  // Anti-farming star economy (spec §2): gold words earn nothing, and every
  // word caps at 3 stars/day regardless of medal, tracked in today's activity doc.
  function starsForCorrectAnswer(w, wasGoldBefore, activity) {
    if (wasGoldBefore) return 0;
    const earnedSoFar = activity.starEarns[w.id] || 0;
    if (earnedSoFar >= 3) return 0;
    return 1;
  }

  // The single place every study mode reports an answer through — updates
  // per-word stats, activity counters, the star economy, and medal-up
  // detection all together so no call site can drift out of sync with another.
  // opts.silent suppresses the medal-up toast/celebration for this call only
  // (Test Mode's whole design is "no feedback until the final score screen" —
  // a mid-test medal-up toast would leak whether that answer was correct).
  // Stats, stars, activity, and streak bookkeeping still happen either way.
  // opts.noStars: self-graded modes (Flip & Rate's "I Knew It", Speed Quiz's
  // "Got It", Vocab Test's "I Knew It") and off-grade weeks (see offGradeWeek
  // below) have no verified answer or no grade-appropriate difficulty, so
  // neither may touch a counter that mints currency: no per-word star, no
  // first-practice bonus, no daily-goal credit, no streak advance (streak
  // milestones pay real stars too). Word stats/medals still update either
  // way — the Progress screen and per-word medals stay an honest reflection
  // of practice — only the anti-farming surface is cut off.
  // opts.streakStep (mechanic 4): recordAnswer has no idea what a caller's
  // in-session streak counter is — that lives on each mode's own session
  // object, incremented AFTER this call returns — so a caller that wants the
  // correct-answer tone to reflect the streak passes the value it's ABOUT to
  // become (session.streak + 1). Omit it and the tone plays flat, as before.
  function recordAnswer(w, correct, statKind, opts) {
    const silent = !!(opts && opts.silent);
    const noStars = !!(opts && opts.noStars);
    const streakStep = opts && opts.streakStep;
    const beforeMedal = wordMedal(w);
    const wasGoldBefore = beforeMedal === "gold";

    if (statKind === "spelling") {
      w.spelling.attempts++;
      if (correct) w.spelling.correct++;
    } else {
      w.vocab.attempts++;
      if (correct) w.vocab.known++;
    }
    const afterMedal = wordMedal(w);

    let starsAwarded = 0;
    let activity = null;
    let isFirstAnswerToday = false;
    if (!noStars) {
      activity = getOrInitActivity();
      isFirstAnswerToday = activity.answers === 0;
      activity.answers++;
      if (correct) activity.correct++;
      if (correct) {
        starsAwarded = starsForCorrectAnswer(w, wasGoldBefore, activity);
        if (starsAwarded > 0) {
          addStars(starsAwarded);
          activity.starsEarned += starsAwarded;
          activity.starEarns[w.id] = (activity.starEarns[w.id] || 0) + starsAwarded;
        }
      }
    }

    if (correct) { if (!silent) { playSound("correct", streakStep); reactBuddy("correct"); } }
    else if (!silent) reactBuddy("miss");

    const medalUp = MEDAL_RANK[afterMedal] > MEDAL_RANK[beforeMedal];
    if (medalUp && !silent) {
      const label = afterMedal.charAt(0).toUpperCase() + afterMedal.slice(1);
      toast(`${MEDAL_ICON[afterMedal]} "${w.text}" leveled up to ${label}!`);
      celebrate("small");
      playSound("medal");
      reactBuddy("cheer");
    }

    if (!noStars) {
      if (isFirstAnswerToday) {
        ensureStreakForToday();
        addStars(3);
        toast("🌞 First practice today! +3 ⭐");
      }
      checkDailyGoal(activity);
      if (activity.answers % 10 === 0) flushActivity();
    }

    return { starsAwarded, medalUp };
  }

  // A kid can browse another grade's list from the week picker (its own hint
  // text suggests it) — fine for review or getting ahead, but paying full
  // stars on a grade well below their own would make that the easiest way to
  // farm currency. Stats/medals still record for any grade; only stars are
  // gated. Smart Review is deliberately NOT run through this: it surfaces
  // weak words from the child's OWN past weeks (which may be a past grade),
  // not a grade being browsed into, and doesn't touch state.selectedWeek.
  function offGradeWeek() {
    return !!(state.selectedWeek && state.profile && state.selectedWeek.grade && state.profile.grade && state.selectedWeek.grade !== state.profile.grade);
  }

  // Anti-farming cap on ROUND bonuses (perfect round / retry-clear / perfect
  // test, below): unlike starsForCorrectAnswer's per-word cap, these bonuses
  // aren't tied to any one word, so a short list replayed on repeat (exit,
  // re-enter, answer the same 4 known words) would otherwise mint unlimited
  // stars per day. Tracked as a same-day count, not a star total, so a mix of
  // +5/+2 bonuses shares one budget. Returns whether the bonus was actually
  // paid; callers still show the "big" toast/celebration either way so
  // reaching the cap reads as "no more stars today," not as a broken feature.
  const MAX_BONUS_ROUNDS_PER_DAY = 8;

  function awardCappedBonus(amount, activity) {
    if ((activity.bonusRoundsToday || 0) >= MAX_BONUS_ROUNDS_PER_DAY) return false;
    activity.bonusRoundsToday = (activity.bonusRoundsToday || 0) + 1;
    addStars(amount);
    activity.starsEarned = (activity.starsEarned || 0) + amount;
    return true;
  }

  // Shared by Spelling/Vocab/Scramble, which all use a {queue, retry, round,
  // missedThisRound} session shape: rewards a clean round 1 (no misses, real-
  // sized list) or a fully-cleared retry round. missedThisRound (NOT
  // retry.length — that array is only ever populated during round 1, so it's
  // always empty by the time round 2 finishes regardless of how round 2 went)
  // is what actually proves the round just completed had zero misses.
  // Returns whether a bonus fired so the caller can skip its own "complete"
  // toast in favor of this louder one.
  // canPay: false for a session that can never mint stars (self-graded Flip &
  // Rate, or any mode run against an off-grade week — see offGradeWeek). The
  // round still completes and celebrates the same either way; it just never
  // names a star amount when it can't back it up, same posture as the daily
  // cap in awardCappedBonus above.
  function awardRoundCompletionBonus(session, canPay) {
    const activity = getOrInitActivity();
    if (session.round === 1 && !session.missedThisRound && session.queue.length >= 4) {
      const paid = canPay && awardCappedBonus(5, activity);
      if (paid) session.starsThisSession = (session.starsThisSession || 0) + 5;
      toast(paid ? "🌟 Perfect round! +5 ⭐" : "🌟 Perfect round!");
      celebrate("big");
      playSound("perfect");
      reactBuddy("cheer");
      return true;
    }
    if (session.round === 2 && !session.missedThisRound) {
      const paid = canPay && awardCappedBonus(2, activity);
      if (paid) session.starsThisSession = (session.starsThisSession || 0) + 2;
      toast(paid ? "💪 Cleared the retries! +2 ⭐" : "💪 Cleared the retries!");
      celebrate("small");
      playSound("perfect");
      reactBuddy("cheer");
      return true;
    }
    return false;
  }

  // Mechanic 1 ("Session Wrap-Up") bookkeeping — called once right after
  // every recordAnswer() in the five round-based modes so their session
  // objects accumulate exactly what the wrap-up screen needs, without any
  // mode needing a second pass over its own history at the end.
  // starsThisSession accumulates from EVERY source that pays into a session
  // this way, not just this function — awardRoundCompletionBonus,
  // handleHotStreak, and checkBonusWord below all add to it too when their
  // own bonus pays out, since none of those go through recordAnswer()'s
  // return value. Missing any of them would make the wrap-up screen's
  // number quietly wrong — smaller than what the header actually gained.
  function trackSessionResult(session, w, result) {
    session.starsThisSession = (session.starsThisSession || 0) + (result.starsAwarded || 0);
    if (result.medalUp) (session.medalUps = session.medalUps || []).push({ word: w.text, medal: wordMedal(w) });
    // bestStreak deliberately NOT touched here: this runs before the caller's
    // own `session.streak++`, so reading session.streak now would always be
    // one answer behind — each mode updates bestStreak itself, right after
    // incrementing, so a session that goes correct-the-whole-way-through
    // reports its TRUE final streak instead of one short of it.
  }

  // Mechanic 1: the payoff moment for Spelling/Vocab/Match/Scramble/Review
  // used to be a 1.8s toast dumped straight back to Home — this is where it
  // lands instead. showStars: false whenever the session paid no stars by
  // POLICY (self-graded or off-grade), not just because none happened to be
  // due — a session like that gets framed around medals/correctness, never a
  // stars tally that would just read as "0" and look broken. wordSet: the
  // full word list the session was built from (not the queue, which may be
  // mid-consumed or down to a retry subset) — used to find the single word
  // closest to its next medal for the "next time" line. replay: fn that
  // relaunches the same mode on the same word set; omit to hide the button
  // (Smart Review's pool is recomputed fresh each time, so "again" there is
  // just "open Smart Review," not a literal replay of this exact set).
  let wrapUpReplay = null;
  function showSessionWrapUp(session, { title, showStars, wordSet, replay, extraNudge }) {
    wrapUpReplay = replay || null;
    document.getElementById("wrapup-title").textContent = title;

    const starsRow = document.getElementById("wrapup-stars-row");
    if (showStars) {
      document.getElementById("wrapup-stars-count").textContent = session.starsThisSession || 0;
      starsRow.classList.remove("hidden");
    } else starsRow.classList.add("hidden");

    const medals = session.medalUps || [];
    const medalWrap = document.getElementById("wrapup-medals");
    if (medals.length) {
      medalWrap.innerHTML = medals
        .map((m) => `<div class="wrapup-medal-row">${MEDAL_ICON[m.medal]} "${escapeAttr(m.word)}" leveled up to ${m.medal.charAt(0).toUpperCase() + m.medal.slice(1)}!</div>`)
        .join("");
      medalWrap.classList.remove("hidden");
    } else medalWrap.classList.add("hidden");

    const streakEl = document.getElementById("wrapup-streak");
    if ((session.bestStreak || 0) >= 3) {
      streakEl.textContent = `🔥 Best streak this round: ${session.bestStreak}`;
      streakEl.classList.remove("hidden");
    } else streakEl.classList.add("hidden");

    // The single word closest to its next medal, across the whole set this
    // session drew from — not just the words seen this round, so the nudge
    // still points somewhere useful on a short retry-only pass.
    let nudgeText = "";
    if (Array.isArray(wordSet) && wordSet.length) {
      let best = null;
      wordSet.forEach((w) => {
        const p = medalProgress(w);
        if (p.nextMedal && p.correctNeeded > 0 && (!best || p.correctNeeded < best.correctNeeded)) best = { word: w.text, correctNeeded: p.correctNeeded, nextMedal: p.nextMedal };
      });
      if (best) nudgeText = `"${best.word}" is ${best.correctNeeded} correct answer${best.correctNeeded === 1 ? "" : "s"} from ${best.nextMedal} next time.`;
    }
    if (extraNudge) nudgeText = nudgeText ? extraNudge + " " + nudgeText : extraNudge;
    const nudgeEl = document.getElementById("wrapup-nudge");
    nudgeEl.textContent = nudgeText;
    nudgeEl.classList.toggle("hidden", !nudgeText);

    document.getElementById("wrapup-play-again").classList.toggle("hidden", !replay);
    showScreen("session-wrapup");
  }
  document.getElementById("wrapup-play-again").addEventListener("click", () => { if (wrapUpReplay) wrapUpReplay(); });
  document.getElementById("wrapup-home").addEventListener("click", () => { renderHome(); showScreen("home"); });

  // Names what a streak of 5+ actually achieved the moment it ends (a miss —
  // the only place session.streak is ever reset to 0), instead of the streak
  // badge just silently vanishing. Never says the streak "ended" or was
  // "lost" — only ever surfaces what was reached. Every streak-reset site
  // below calls this instead of setting `session.streak = 0` directly.
  function endStreak(session) {
    if ((session.streak || 0) >= 5) toast(`That was a ${session.streak}-streak — nice!`);
    session.streak = 0;
  }

  // Mechanic 4 ("hot-streak escalation") — a small named burst at streak
  // milestones, on top of the per-answer pitch-rise already in playSound().
  // Routed through the shared 8/day round-bonus budget so it can't mint
  // currency independently of every other bonus in this file. canPay: false
  // (self-graded/off-grade) skips the bonus AND the burst sound entirely —
  // a session that can't back up a payout shouldn't sound like it just
  // earned one; the plain per-answer pitch-rise still plays regardless.
  const HOT_STREAK_BONUSES = { 5: 2, 10: 3, 15: 4 };
  function handleHotStreak(session, canPay) {
    const bonus = HOT_STREAK_BONUSES[session.streak];
    if (!bonus || !canPay) return;
    const paid = awardCappedBonus(bonus, getOrInitActivity());
    if (paid) session.starsThisSession = (session.starsThisSession || 0) + bonus;
    toast(paid ? `🔥 On fire! ${session.streak} in a row! +${bonus} ⭐` : `🔥 On fire! ${session.streak} in a row!`);
    celebrate("small");
    playSound("hotstreak");
  }

  // Mechanic 5 ("Bonus Word") — one word per session is secretly worth more,
  // weighted toward the profile's own weaker words (via wordsNeedingWork's
  // existing worst-accuracy-first ranking) rather than a flat random pick, so
  // the surprise also happens to aim at what's worth studying. Biased toward
  // the weaker HALF rather than always the single weakest word, so it stays
  // a surprise even for a kid who already knows which word they're worst at.
  function pickBonusWord(list) {
    if (!Array.isArray(list) || list.length < 2) return null;
    const weak = wordsNeedingWork({ words: list });
    const pool = weak.length ? weak.slice(0, Math.max(1, Math.ceil(weak.length / 2))) : list;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const MAX_BONUS_WORDS_PER_DAY = 5;
  function awardBonusWord(amount, activity) {
    if ((activity.bonusWordsToday || 0) >= MAX_BONUS_WORDS_PER_DAY) return false;
    activity.bonusWordsToday = (activity.bonusWordsToday || 0) + 1;
    addStars(amount);
    activity.starsEarned = (activity.starsEarned || 0) + amount;
    return true;
  }
  // Called from a mode's correct branch only — a miss on the bonus word is
  // just a normal miss, no reveal, no "you missed it" framing. canPay: false
  // (self-graded/off-grade) means no reveal at all, since a self-report
  // can't prove the word was actually known. Guards against re-firing if the
  // same session somehow revisits the word (a retry round, say).
  function checkBonusWord(session, w, canPay) {
    if (!canPay || !session.bonusWordId || session.bonusWordId !== w.id || session.bonusWordAwarded) return;
    session.bonusWordAwarded = true;
    const paid = awardBonusWord(3, getOrInitActivity());
    if (paid) session.starsThisSession = (session.starsThisSession || 0) + 3;
    toast(paid ? "🎁 Bonus word! +3 ⭐" : "🎁 Bonus word!");
    celebrate("small");
    playSound("bonusword");
  }
  // For the wrap-up screen's "get it next time" line when the bonus word was
  // set but never reached correctly this session.
  function bonusWordMissedNudge(session, wordSet) {
    if (!session.bonusWordId || session.bonusWordAwarded) return "";
    const w = (wordSet || []).find((x) => x.id === session.bonusWordId);
    return w ? `The bonus word was "${w.text}" — get it next time!` : "";
  }

  // Mechanic 6 ("Gold the List") — a permanent, one-time trophy per week
  // when every word in it reaches Gold. Checked against the FULL current
  // week (state.progress.words), never a session's own subset (e.g.
  // "practice the ones I missed") — completing the list is about the whole
  // week, not whichever slice a round happened to cover. off-grade weeks are
  // excluded via offGradeWeek() so browsing an easier grade can't mint a
  // false trophy; a true one-time-per-week event (not a daily budget), so it
  // checks the trophy map directly instead of routing through
  // awardCappedBonus. Called after any round finishes in the three
  // real-answer modes (Spelling/Match/Scramble) — not Vocab Flip & Rate
  // (self-graded, can't verify Gold honestly) or Smart Review (its words
  // aren't state.progress.words, they're scattered across other weeks').
  const GOLD_LIST_BONUS = 15;
  function checkGoldTheList() {
    if (!state.profile || !state.progress || offGradeWeek()) return;
    const words = state.progress.words;
    if (!words.length || !words.every((w) => wordMedal(w) === "gold")) return;
    const weekId = state.progress.weekId;
    state.profile.weekTrophies = state.profile.weekTrophies || {};
    if (state.profile.weekTrophies[weekId]) return;
    state.profile.weekTrophies[weekId] = todayLocalStr();
    addStars(GOLD_LIST_BONUS);
    toast(`🏆 "${state.progress.label || weekId}" is all Gold!`);
    celebrate("big");
    playSound("perfect");
    reactBuddy("cheer");
    persistProfile();
  }

  /* ---------------------------------------------------------------------
   * PROFILES SCREEN
   * ------------------------------------------------------------------- */
  const AVATARS = ["🦊", "🐨", "🐸", "🦁", "🐯", "🐼", "🦉", "🐢", "🐧", "🦄"];

  // Above this many students, the plain creation-order grid (fine for a
  // family of 2-4) stops being findable — render a search box and switch to
  // alphabetical order instead. Not configurable on purpose (see
  // docs/school-scale-plan.md §1.3): a threshold nobody will ever need to
  // tune isn't worth a settings UI.
  const PROFILE_SEARCH_THRESHOLD = 8;

  function renderProfiles() {
    const list = getProfiles();
    const students = list.filter((p) => p.role !== "parent");
    const parents = list.filter((p) => p.role === "parent");

    const searchWrap = document.getElementById("profile-search-wrap");
    const showSearch = students.length > PROFILE_SEARCH_THRESHOLD;
    searchWrap.classList.toggle("hidden", !showSearch);
    let visibleStudents = students;
    if (showSearch) {
      const q = document.getElementById("profile-search-input").value.trim().toLowerCase();
      visibleStudents = students
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    const wrap = document.getElementById("profile-list");
    wrap.innerHTML = "";
    visibleStudents.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "profile-card";
      const gradeLine = p.grade ? `<br><span style="font-weight:400;font-size:.75rem;color:var(--muted)">Grade ${escapeAttr(p.grade)}</span>` : "";
      btn.innerHTML = `<span class="avatar">${avatarHtml(p)}</span>${escapeAttr(p.name)}${gradeLine}`;
      btn.addEventListener("click", () => handleProfileTap(p));
      wrap.appendChild(btn);
    });

    const parentWrap = document.getElementById("parent-list");
    parentWrap.innerHTML = "";
    parentWrap.classList.toggle("hidden", parents.length === 0);
    parents.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "parent-card";
      btn.innerHTML = `🔒 ${escapeAttr(p.name)}`;
      btn.addEventListener("click", () => openParentPinEntry(p));
      parentWrap.appendChild(btn);
    });

    closeParentPinEntry();
    document.getElementById("add-parent-form").classList.add("hidden");
    document.getElementById("add-parent-hint").classList.add("hidden");
    hideProfileConfirm();

    const code = typeof Sync !== "undefined" ? Sync.getHouseholdCode() : null;
    const info = document.getElementById("household-info");
    info.classList.remove("hidden");
    if (code) {
      // The actual code/QR/copy-link display moved to its own "Class Info"
      // screen (docs/school-scale-plan.md §1.2) — a teacher needs to print
      // this and put it on a wall, not read a one-line strip. This button is
      // the persistent, ungated entry point to it: anyone viewing this screen
      // already has the code's full access by definition, so gating the
      // *display* of it specifically would add friction with no real
      // security benefit.
      info.innerHTML = '<button id="btn-open-class-info" class="btn btn-ghost household-copy-btn">🏫 Class Info</button>';
      document.getElementById("btn-open-class-info").addEventListener("click", () => openClassInfo());
    } else if (typeof Sync !== "undefined") {
      info.innerHTML = '<button id="btn-open-household" class="btn btn-ghost household-copy-btn">🔗 Sync across devices</button>';
      document.getElementById("btn-open-household").addEventListener("click", () => showScreen("household"));
    } else {
      info.classList.add("hidden");
    }
  }
  document.getElementById("profile-search-input").addEventListener("input", () => renderProfiles());

  // Mis-tap guard for a shared cart of classroom devices, not a security
  // boundary — there is no secret to protect here, only an accident to
  // prevent (docs/school-scale-plan.md §1.3). Only shown when the tapped
  // profile differs from this device's cached ws_active_profile. On a 1:1
  // device this never fires after the very first login: enterApp() auto-
  // resumes straight past the picker screen once ws_active_profile is set,
  // so this handler never even runs on later visits.
  let pendingProfileConfirm = null;
  function handleProfileTap(p) {
    if (getActiveProfileId() === p.id) { selectProfile(p.id); return; }
    pendingProfileConfirm = p;
    document.getElementById("profile-confirm-avatar").innerHTML = avatarHtml(p);
    document.getElementById("profile-confirm-name").textContent = p.name;
    document.getElementById("profile-confirm").classList.remove("hidden");
  }
  function hideProfileConfirm() {
    pendingProfileConfirm = null;
    document.getElementById("profile-confirm").classList.add("hidden");
  }
  document.getElementById("btn-profile-confirm-yes").addEventListener("click", () => {
    const p = pendingProfileConfirm;
    hideProfileConfirm();
    if (p) selectProfile(p.id);
  });
  document.getElementById("btn-profile-confirm-back").addEventListener("click", () => hideProfileConfirm());

  function watchProfilesList() {
    if (!firestoreReady()) return;
    Sync.watchProfiles((remoteList) => {
      saveProfiles(remoteList);
      renderProfiles();
    });
  }

  function applyRemoteProfileUpdate(data) {
    if (!state.profile) return;
    const fields = {};
    if (typeof data.stars === "number" && data.stars !== state.profile.stars) fields.stars = data.stars;
    if (typeof data.currentStreak === "number" && data.currentStreak !== state.profile.currentStreak) fields.currentStreak = data.currentStreak;
    if (typeof data.bestStreak === "number" && data.bestStreak !== state.profile.bestStreak) fields.bestStreak = data.bestStreak;
    if (typeof data.lastActiveDate === "string" && data.lastActiveDate !== state.profile.lastActiveDate) fields.lastActiveDate = data.lastActiveDate;
    if (Array.isArray(data.recentTests) && JSON.stringify(data.recentTests) !== JSON.stringify(state.profile.recentTests)) fields.recentTests = data.recentTests;
    if (Array.isArray(data.unlocks) && JSON.stringify(data.unlocks) !== JSON.stringify(state.profile.unlocks)) fields.unlocks = data.unlocks;
    if (data.unlockDates && typeof data.unlockDates === "object" && JSON.stringify(data.unlockDates) !== JSON.stringify(state.profile.unlockDates)) fields.unlockDates = data.unlockDates;
    if (typeof data.equippedAvatar === "string" && data.equippedAvatar !== state.profile.equippedAvatar) fields.equippedAvatar = data.equippedAvatar;
    if (typeof data.equippedTheme === "string" && data.equippedTheme !== state.profile.equippedTheme) fields.equippedTheme = data.equippedTheme;
    if (typeof data.lifetimeStars === "number" && data.lifetimeStars !== state.profile.lifetimeStars) fields.lifetimeStars = data.lifetimeStars;
    if (data.weekTrophies && typeof data.weekTrophies === "object" && JSON.stringify(data.weekTrophies) !== JSON.stringify(state.profile.weekTrophies)) fields.weekTrophies = data.weekTrophies;
    if (typeof data.streakShields === "number" && data.streakShields !== state.profile.streakShields) fields.streakShields = data.streakShields;
    if (Object.keys(fields).length === 0) return;
    Object.assign(state.profile, fields);
    updateLocalProfileFields(state.profile.id, fields);
    if ("equippedTheme" in fields) applyTheme(fields.equippedTheme);
    refreshHeader();
  }

  function applyRemoteProgressUpdate(data) {
    const activeId = (document.querySelector(".screen.active") || {}).id;
    const safeToApply = activeId === "screen-home" || activeId === "screen-progress";
    if (!safeToApply) return;
    if (!state.progress || !data || data.weekId !== state.progress.weekId) return;
    if (JSON.stringify(data) === JSON.stringify(state.progress)) return;
    state.progress = data;
    saveProgressLocal(state.profile.id, data.weekId, data);
    if (activeId === "screen-home") renderHome();
    else openProgress();
  }

  async function selectProfile(id) {
    // pendingProfilePush/pendingProgressPush (see persistProfile/saveProgress)
    // are single global slots, not per-profile — switching profiles (the
    // header's 🔀 button reaches this mid-session, without going through any
    // mode's exit handler) before a debounced write for the OUTGOING profile
    // has fired would otherwise let the incoming profile's next write
    // silently clobber it before it ever reaches Firestore.
    flushPendingSyncPushes();
    const profiles = getProfiles();
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    // Migration: a profile that predates the shop has no lifetimeStars yet —
    // seed it from the current spendable balance so nothing is lost/gained.
    if (typeof p.lifetimeStars !== "number") {
      p.lifetimeStars = p.stars || 0;
      saveProfiles(profiles);
    }
    state.profile = p;
    setActiveProfileId(id);
    refreshHeader();
    applyTheme(p.equippedTheme);
    getOrInitActivity();
    if (firestoreReady()) {
      Sync.watchProfile(id, applyRemoteProfileUpdate);
      try {
        const remote = await Sync.fetchActivityRange(id, [state.activity.date]);
        if (remote.length) {
          state.activity = mergeActivityDocs(state.activity, remote[0]);
          save(activityKey(id, state.activity.date), state.activity);
          trackSyncWrite(Sync.pushActivity(id, state.activity.date, state.activity));
        }
      } catch (e) { /* local doc already in place — fine offline */ }
      // Smart Review's pool is normally local-only (see loadAllProgressDocs),
      // so a brand-new or iOS-wiped device starts with an empty review queue
      // even though the student has real practiced weeks sitting in
      // Firestore. Seed the local cache once, only when it's actually empty,
      // so this never overwrites a fuller local index with a stale remote one.
      if (!load(progressIndexKey(id), []).length) {
        try {
          const docs = await Sync.fetchAllProgress(id);
          docs.forEach((doc) => { if (doc && doc.weekId) saveProgressLocal(id, doc.weekId, doc); });
        } catch (e) { /* ignore — review just stays empty until this device practices */ }
      }
    }
    await loadCatalogAndWeek();
  }

  // Extracted so a bulk roster import (§1.1 of docs/school-scale-plan.md) can
  // create many students in a loop without re-running the single-add click
  // handler's "enter the app as this kid" side effect 20 times over.
  // studentCount is recomputed fresh from getProfiles() on every call — not
  // hoisted above a loop — so a bulk import still gets a nicely varied avatar
  // rotation across all new students instead of the same one repeated.
  function createStudentProfile(name, grade) {
    const profiles = getProfiles();
    const studentCount = profiles.filter((x) => x.role !== "parent").length;
    const p = { id: uid(), name, avatar: AVATARS[studentCount % AVATARS.length], stars: 0, grade: grade || "" };
    profiles.push(p);
    saveProfiles(profiles);
    if (firestoreReady()) Sync.pushProfile(p);
    return p;
  }

  document.getElementById("btn-add-profile").addEventListener("click", () => {
    const input = document.getElementById("new-profile-name");
    const gradeInput = document.getElementById("new-profile-grade");
    const name = input.value.trim();
    if (!name) { toast("Type a name first"); return; }
    const grade = gradeInput.value.trim();
    const p = createStudentProfile(name, grade);
    input.value = "";
    gradeInput.value = "";
    renderProfiles();
    selectProfile(p.id);
  });
  function addProfileOnEnter(e) { if (e.key === "Enter") document.getElementById("btn-add-profile").click(); }
  document.getElementById("new-profile-name").addEventListener("keydown", addProfileOnEnter);
  document.getElementById("new-profile-grade").addEventListener("keydown", addProfileOnEnter);

  /* ---------------------------------------------------------------------
   * BULK CLASS ROSTER IMPORT (docs/school-scale-plan.md §1.1)
   * Mirrors the catalog editor's paste → preview → confirm shape for UX
   * consistency with a workflow users of this app have already learned.
   * ------------------------------------------------------------------- */
  const ROSTER_NAME_MAX = 60;
  const ROSTER_MAX_STUDENTS = 200;

  function parseRosterText(text, defaultGrade) {
    const rows = [];
    text.split("\n").forEach((raw) => {
      if (rows.length >= ROSTER_MAX_STUDENTS) return;
      const line = raw.trim();
      if (!line) return;
      const idx = line.indexOf(",");
      const name = (idx === -1 ? line : line.slice(0, idx)).trim().slice(0, ROSTER_NAME_MAX);
      const grade = (idx === -1 ? "" : line.slice(idx + 1).trim()) || defaultGrade || "";
      if (name) rows.push({ name, grade });
    });
    return rows;
  }

  let rosterParsePreview = [];

  function openClassRoster() {
    document.getElementById("roster-default-grade").value = "";
    document.getElementById("roster-paste-input").value = "";
    document.getElementById("roster-preview").classList.add("hidden");
    document.getElementById("btn-save-roster").classList.add("hidden");
    showScreen("class-roster");
  }
  document.getElementById("btn-add-class-roster").addEventListener("click", openClassRoster);
  document.getElementById("class-roster-exit").addEventListener("click", () => { renderProfiles(); showScreen("profiles"); });

  document.getElementById("btn-preview-roster").addEventListener("click", () => {
    const text = document.getElementById("roster-paste-input").value;
    const defaultGrade = document.getElementById("roster-default-grade").value.trim();
    rosterParsePreview = parseRosterText(text, defaultGrade);
    const box = document.getElementById("roster-preview");
    if (!rosterParsePreview.length) {
      box.innerHTML = '<p class="hint">Nothing parsed yet — paste one name per line.</p>';
      box.classList.remove("hidden");
      document.getElementById("btn-save-roster").classList.add("hidden");
      return;
    }
    box.innerHTML = `<p class="hint">Will add ${rosterParsePreview.length} student${rosterParsePreview.length === 1 ? "" : "s"}:</p>` +
      rosterParsePreview.map((r) => `<div class="result-row"><span>${escapeAttr(r.name)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${r.grade ? "Grade " + escapeAttr(r.grade) : "no grade"}</span></div>`).join("");
    box.classList.remove("hidden");
    document.getElementById("btn-save-roster").classList.remove("hidden");
  });

  // Loops createStudentProfile() (never the single click handler above) so
  // this never tries to "enter the app" as each of N new students in
  // sequence — one renderProfiles() + one toast at the end, then back to the
  // profile grid so the teacher can see the class was created.
  document.getElementById("btn-save-roster").addEventListener("click", () => {
    const btn = document.getElementById("btn-save-roster");
    btn.disabled = true;
    const count = rosterParsePreview.length;
    rosterParsePreview.forEach((r) => createStudentProfile(r.name, r.grade));
    rosterParsePreview = [];
    toast(`Added ${count} student${count === 1 ? "" : "s"}!`);
    btn.disabled = false;
    renderProfiles();
    showScreen("profiles");
  });

  /* ---------------------------------------------------------------------
   * CLASS INFO SCREEN (docs/school-scale-plan.md §1.2)
   * The code/QR/copy-link display that used to live inline in the
   * household-info strip on #screen-profiles now has its own screen — a
   * teacher needs to print this and put it on the wall, not glance at a
   * one-line hint. Reachable both from the profile picker's persistent
   * "Class Info" button (see renderProfiles) and immediately after creating
   * a household (see btn-create-household below).
   * ------------------------------------------------------------------- */
  let classInfoReturnTo = "profiles";

  function renderClassInfoQR(url) {
    const wrap = document.getElementById("class-info-qr");
    wrap.innerHTML = "";
    if (typeof QRCode === "undefined") { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    try {
      new QRCode(wrap, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
    } catch (e) { wrap.classList.add("hidden"); }
  }

  function openClassInfo() {
    const code = typeof Sync !== "undefined" ? Sync.getHouseholdCode() : null;
    if (!code) { toast("Create or join a household first"); return; }
    // Right after creating a household, screen-household is still active (the
    // teacher hasn't tapped "Join" yet — see btn-create-household) — send
    // "Back" there instead of to the profile picker so that password-save
    // flow isn't short-circuited by a detour through this screen.
    classInfoReturnTo = (document.querySelector(".screen.active") || {}).id === "screen-household" ? "household" : "profiles";
    document.getElementById("class-info-code-display").textContent = code;
    renderClassInfoQR(inviteURL("household", code));
    showScreen("class-info");
  }
  document.getElementById("btn-copy-class-info-code").addEventListener("click", () => {
    const code = typeof Sync !== "undefined" ? Sync.getHouseholdCode() : null;
    if (code) copyToClipboard(code);
  });
  document.getElementById("btn-copy-class-info-link").addEventListener("click", () => {
    const code = typeof Sync !== "undefined" ? Sync.getHouseholdCode() : null;
    if (code) copyToClipboard(inviteURL("household", code));
  });
  document.getElementById("class-info-exit").addEventListener("click", () => {
    if (classInfoReturnTo === "profiles") renderProfiles();
    showScreen(classInfoReturnTo);
  });

  /* ---------------------------------------------------------------------
   * PARENT PROFILES (role:"parent" — child-proofing PIN, not security;
   * see spec §6. No grade/stars/streak/progress for these profiles.)
   * ------------------------------------------------------------------- */
  // Reachable pre-login (no profile picked yet), so it can't rely on
  // renderHome()/renderProfiles() state — it just shows/hides its own screen
  // and always returns to the profile picker, the only place it's linked from.
  document.getElementById("btn-open-legal").addEventListener("click", () => showScreen("legal"));
  document.getElementById("btn-legal-back").addEventListener("click", () => showScreen("profiles"));

  document.getElementById("btn-show-add-parent").addEventListener("click", () => {
    document.getElementById("add-parent-form").classList.remove("hidden");
    document.getElementById("add-parent-hint").classList.remove("hidden");
  });

  document.getElementById("btn-add-parent").addEventListener("click", () => {
    const nameInput = document.getElementById("new-parent-name");
    const pinInput = document.getElementById("new-parent-pin");
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    if (!name) { toast("Type a name first"); return; }
    if (!/^\d{4}$/.test(pin)) { toast("PIN must be 4 digits"); return; }
    const profiles = getProfiles();
    const p = { id: uid(), name, role: "parent", pin };
    profiles.push(p);
    saveProfiles(profiles);
    nameInput.value = "";
    pinInput.value = "";
    renderProfiles();
    if (firestoreReady()) Sync.pushProfile(p);
    toast(`Parent profile "${name}" created`);
  });

  let parentPinAttempts = 0;
  let parentPinTarget = null;

  function openParentPinEntry(parentProfile) {
    parentPinTarget = parentProfile;
    parentPinAttempts = 0;
    document.getElementById("parent-pin-name").textContent = parentProfile.name;
    document.getElementById("parent-pin-input").value = "";
    document.getElementById("parent-pin-entry").classList.remove("hidden");
    document.getElementById("parent-pin-input").focus();
  }
  function closeParentPinEntry() {
    parentPinTarget = null;
    document.getElementById("parent-pin-entry").classList.add("hidden");
  }
  document.getElementById("btn-parent-pin-cancel").addEventListener("click", closeParentPinEntry);
  document.getElementById("parent-pin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-parent-pin-submit").click();
  });
  document.getElementById("btn-parent-pin-submit").addEventListener("click", () => {
    if (!parentPinTarget) return;
    const entered = document.getElementById("parent-pin-input").value.trim();
    if (entered === parentPinTarget.pin) {
      const p = parentPinTarget;
      closeParentPinEntry();
      enterParentMode(p);
    } else {
      parentPinAttempts++;
      document.getElementById("parent-pin-input").value = "";
      if (parentPinAttempts >= 3) {
        toast("Too many wrong attempts");
        closeParentPinEntry();
      } else {
        toast("Wrong PIN");
      }
    }
  });

  // Deliberately bypasses selectProfile entirely — no catalog/week/progress
  // load, no ACTIVE_KEY persistence. Parents re-enter their PIN every visit;
  // the app must never auto-resume into parent mode on reload.
  function enterParentMode(parentProfile) {
    state.parentProfile = parentProfile;
    openParentDashboard();
  }

  function openParentDashboard() {
    document.getElementById("parent-dash-title").textContent = `👋 ${state.parentProfile.name}`;
    renderParentSelfManage();
    showScreen("parent-dashboard");
    loadParentDashboard();
  }

  document.getElementById("parent-dash-refresh").addEventListener("click", () => loadParentDashboard());
  document.getElementById("parent-dash-exit").addEventListener("click", () => {
    state.parentProfile = null;
    renderProfiles();
    showScreen("profiles");
    watchProfilesList();
  });

  /* ---------------------------------------------------------------------
   * PARENT SELF-MANAGE (rename / delete your own parent profile)
   * The only profile editing anywhere in the app, and deliberately narrow:
   * the parent viewing this screen already proved they hold this profile's
   * PIN, and a parent profile is a name + a PIN and nothing else, so
   * renaming it is free and deleting it destroys no practice data. Student
   * profiles are NOT editable here — a student owns progress docs, activity
   * docs, stars and unlocks across two collections, and Firestore doesn't
   * delete subcollections with their parent document.
   * ------------------------------------------------------------------- */
  const PARENT_NAME_MAX = 60;

  function renderParentSelfManage() {
    if (!state.parentProfile) return;
    document.getElementById("parent-self-name").value = state.parentProfile.name || "";
    document.getElementById("parent-self-delete-confirm").classList.add("hidden");
  }

  document.getElementById("btn-parent-self-rename").addEventListener("click", () => {
    if (!state.parentProfile) return;
    const name = document.getElementById("parent-self-name").value.trim().slice(0, PARENT_NAME_MAX);
    if (!name) { toast("Type a name first"); return; }
    if (name === state.parentProfile.name) return;
    // state.parentProfile is a detached copy — getProfiles() JSON.parses a
    // fresh array on every call — so mutating it persists nothing on its own.
    state.parentProfile.name = name;
    updateLocalProfileFields(state.parentProfile.id, { name });
    if (firestoreReady()) Sync.pushProfile(state.parentProfile);
    document.getElementById("parent-dash-title").textContent = `👋 ${name}`;
    toast("Name updated");
  });

  document.getElementById("btn-parent-self-delete").addEventListener("click", () => {
    if (!state.parentProfile) return;
    document.getElementById("parent-self-delete-name").textContent = state.parentProfile.name || "this profile";
    document.getElementById("parent-self-delete-confirm").classList.remove("hidden");
  });
  document.getElementById("btn-parent-self-delete-cancel").addEventListener("click", () => {
    document.getElementById("parent-self-delete-confirm").classList.add("hidden");
  });

  // Firestore first, local second — the reverse order has a real bug in it:
  // watchProfiles() may already be listening (enterApp/switch-profile start
  // it and it is never stopped), and it overwrites the whole local profile
  // list from every snapshot. A local-first delete would be silently undone
  // by any snapshot arriving before the remote delete landed. Deleting
  // locally regardless of the remote result keeps the offline/local-only
  // household — a fully supported mode here — working exactly as expected.
  async function deleteOwnParentProfile() {
    const p = state.parentProfile;
    if (!p) return;
    const btn = document.getElementById("btn-parent-self-delete-yes");
    btn.disabled = true;
    let synced = true;
    if (firestoreReady()) {
      try { synced = await Sync.deleteParentProfile(p.id); } catch (e) { synced = false; }
    }
    saveProfiles(getProfiles().filter((x) => x.id !== p.id));
    btn.disabled = false;
    document.getElementById("parent-self-delete-confirm").classList.add("hidden");
    state.parentProfile = null;
    renderProfiles();
    showScreen("profiles");
    watchProfilesList();
    toast(synced ? "Parent profile deleted" : "Deleted on this device — sync didn't accept it, so it may come back.");
  }
  document.getElementById("btn-parent-self-delete-yes").addEventListener("click", deleteOwnParentProfile);

  function pctClass(pct) {
    if (pct >= 90) return "psc-pct-green";
    if (pct >= 70) return "psc-pct-amber";
    return "psc-pct-red";
  }

  // Builds one student's dashboard data: current week (auto-computed the
  // same way Home does, since a parent's device may never have loaded that
  // student's own local week-selection cache), that week's progress doc,
  // and the last 7 days of activity docs (7 point-reads by known date-string
  // id — no collection query — per spec §6's quota note).
  async function loadStudentDashboardData(student) {
    let week = null;
    if (student.grade) week = computeAutoWeek(state.catalogWeeks, student.grade);
    if (!week && state.catalogWeeks.length) week = state.catalogWeeks[0];

    // Local-first, same as the rest of the app (loadProgressForWeek,
    // loadCatalogAndWeek): a single local-only device is a fully supported
    // mode, and on that device the parent dashboard IS reading the same
    // localStorage the student's own session just wrote to.
    let progress = null;
    if (week) {
      progress = load(progressKey(student.id, week.id), null);
      if (!progress && firestoreReady()) {
        try { progress = await Sync.fetchProgress(student.id, week.id); } catch (e) { /* ignore */ }
      }
    }

    const today = todayLocalStr();
    const dates = weekDatesSunToSat(today);   // was weekDatesMonToSun(today)
    const activityByDate = {};
    dates.forEach((d) => {
      const local = load(activityKey(student.id, d), null);
      if (local) activityByDate[d] = local;
    });
    if (firestoreReady()) {
      try {
        const remote = await Sync.fetchActivityRange(student.id, dates);
        remote.forEach((a) => { activityByDate[a.date] = a; });
      } catch (e) { /* ignore */ }
    }

    return { student, week, progress, dates, activityByDate };
  }

  // Every study mode already calls recordModeStart() and its answers land in
  // activity.modes — the data was always there. What was missing was showing
  // it: the dashboard's only prominent activity section was "Recent tests"
  // (Test Mode/Speed Quiz only, via student.recentTests), with every other
  // mode's usage buried in one "· mostly spelling" fragment on a summary
  // line. A parent whose kid did Spelling Practice or Word Scramble — the
  // two modes these particular kids actually prefer — would see nothing that
  // looked like practice happened. This breakdown makes every mode visible.
  const MODE_LABELS = {
    flashcard: "🔊 Look & Say",
    spelling: "✏️ Spelling Practice",
    vocab: "💡 Vocab · Flip & Rate",
    vocabmatch: "🧩 Vocab · Match the Meaning",
    test: "🎯 Test Mode",
    speed: "⚡ Speed Quiz",
    scramble: "🔤 Word Scramble",
    review: "🧠 Smart Review",
  };

  // Index-aligned with weekDatesSunToSat()'s output.
  const DAY_LABELS = ["S", "M", "Tu", "W", "Th", "F", "Sa"];

  function renderStudentCard(data) {
    const { student, week, progress, dates, activityByDate } = data;
    const today = todayLocalStr();

    let weekAnswers = 0, weekCorrect = 0;
    const modeTotals = {};
    dates.forEach((d) => {
      const a = activityByDate[d];
      if (!a) return;
      weekAnswers += a.answers || 0;
      weekCorrect += a.correct || 0;
      Object.entries(a.modes || {}).forEach(([mode, n]) => { modeTotals[mode] = (modeTotals[mode] || 0) + n; });
    });
    const weekAccuracy = weekAnswers ? Math.round((weekCorrect / weekAnswers) * 100) : null;
    const modeBreakdown = Object.entries(modeTotals)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);

    // The only week view in the app that carries day labels, so it is the one
    // that has to be honest about days that haven't happened yet: a Thursday
    // in the future is dimmed, not shown as a missed day. Green is var(--success)
    // rather than var(--accent) on purpose — --accent is theme-swapped (pink in
    // bubblegum, yellow in gold, purple in galaxy), and "did they practice"
    // must not read as a different signal depending on which theme the kid last
    // equipped on this device.
    const weekTrackHtml = dates.map((d, i) => {
      const done = activityByDate[d] && activityByDate[d].answers > 0;
      const cls = ["psc-day"];
      if (done) cls.push("done");
      if (d === today) cls.push("today");
      else if (d > today) cls.push("future");
      return `<div class="${cls.join(" ")}"><span class="psc-day-label">${DAY_LABELS[i]}</span><span class="psc-day-dot"></span></div>`;
    }).join("");

    const medalCounts = { gold: 0, silver: 0, bronze: 0, none: 0 };
    (progress ? progress.words : []).forEach((w) => { medalCounts[wordMedal(w)]++; });
    const needsWork = wordsNeedingWork(progress);

    const needsWorkHtml = needsWork.length
      ? needsWork.map((w) => {
          const acc = wordAccuracy(w);
          const unpracticed = acc === null;
          return `<div class="psc-needs-work-row${unpracticed ? " unpracticed" : ""}"><span>${escapeAttr(w.text)}</span><span>${unpracticed ? "not practiced" : Math.round(acc * 100) + "%"}</span></div>`;
        }).join("")
      : `<p class="psc-empty">Nothing needs extra work right now! 🎉</p>`;

    const recentTests = student.recentTests || [];
    const testsHtml = recentTests.length
      ? recentTests.map((t) => `<div class="psc-tests-row"><span>${escapeAttr(t.date)} · ${t.kind === "spelling" ? "Spelling" : "Vocab"}</span><span class="${pctClass(t.pct)}">${t.pct}%</span></div>`).join("")
      : `<p class="psc-empty">No tests taken yet.</p>`;

    // Counts sessions (recordModeStart calls), not answers — "used Word
    // Scramble 3 times" is the honest claim this data supports. Answer-level
    // counts stay in the accuracy line above, where they're paired with the
    // week's actual correct/attempted totals rather than presented alone.
    const modeHtml = modeBreakdown.length
      ? modeBreakdown.map(([mode, n]) => `<div class="psc-mode-row"><span class="psc-mode-count">${n}×</span><span>${MODE_LABELS[mode] || escapeAttr(mode)}</span></div>`).join("")
      : `<p class="psc-empty">No practice sessions yet this week.</p>`;

    return `
      <div class="parent-student-card">
        <div class="psc-identity">
          <span class="avatar">${avatarHtml(student)}</span>
          <div>
            <div class="psc-name">${escapeAttr(student.name)}</div>
            <div class="psc-meta">${student.grade ? "Grade " + escapeAttr(student.grade) : "No grade set"}</div>
          </div>
          <div class="psc-stat-row">
            <span>⭐ ${student.stars || 0} <span style="font-weight:400;color:var(--muted)">(${student.lifetimeStars || 0} lifetime)</span></span>
            <span>🔥 ${student.currentStreak || 0} <span style="font-weight:400;color:var(--muted)">(best ${student.bestStreak || 0})</span></span>
          </div>
          <button class="psc-edit-toggle" data-edit-toggle="${student.id}" title="Edit name or grade">✏️</button>
        </div>
        <div class="psc-edit-form hidden" data-edit-form="${student.id}">
          <div class="new-profile-form">
            <input type="text" class="psc-edit-name" value="${escapeAttr(student.name)}" placeholder="Student's name" spellcheck="false" autocomplete="off" autocorrect="off">
            <input type="text" class="psc-edit-grade grade-field" value="${escapeAttr(student.grade || "")}" placeholder="Grade" spellcheck="false" autocomplete="off" autocorrect="off">
          </div>
          <div class="psc-edit-actions">
            <button class="btn btn-secondary" data-edit-save="${student.id}">Save</button>
            <button class="btn btn-ghost" data-edit-cancel="${student.id}">Cancel</button>
          </div>
        </div>

        <p class="psc-usage-line">Last practiced: <strong>${relativeDateLabel(student.lastActiveDate)}</strong></p>
        <p class="psc-usage-line">${weekAnswers} answers this week${weekAccuracy !== null ? " · " + weekAccuracy + "% accuracy" : ""}</p>

        <p class="psc-section-title">This week's practice</p>
        <div class="psc-week-track">${weekTrackHtml}</div>
        <div>${modeHtml}</div>

        <p class="psc-section-title">${week ? escapeAttr(week.label) : "No word list"}</p>
        ${week ? `<p class="psc-usage-line">🥇 ${medalCounts.gold} · 🥈 ${medalCounts.silver} · 🥉 ${medalCounts.bronze} · ⚪ ${medalCounts.none}</p>` : ""}
        <p class="psc-section-title">Needs work</p>
        <div class="psc-needs-work">${needsWorkHtml}</div>

        <p class="psc-section-title">Recent tests</p>
        <div>${testsHtml}</div>
      </div>`;
  }

  // C1: every student's current-week progress doc is already fetched by
  // loadParentDashboard below (loadStudentDashboardData) purely to build
  // each student's own card — this is a second pass over that SAME data, no
  // new reads, answering the question a teacher actually has on a Thursday
  // ("what should tonight's practice focus on?") instead of 25 separate
  // per-student needs-work lists. "Shaky" only (wordStatus), not
  // never-attempted — this card is about difficulty, not who hasn't started.
  function renderHardestWordsCard(results) {
    const counts = new Map();
    results.forEach(({ progress }) => {
      if (!progress || !Array.isArray(progress.words)) return;
      progress.words.forEach((w) => {
        if (wordStatus(w) === "shaky") counts.set(w.text, (counts.get(w.text) || 0) + 1);
      });
    });
    const entries = Array.from(counts.entries()).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!entries.length) return "";
    const total = results.length;
    const rows = entries
      .map(([text, n]) => `<div class="psc-needs-work-row"><span>${escapeAttr(text)}</span><span>${n} of ${total} student${total === 1 ? "" : "s"} shaky</span></div>`)
      .join("");
    return `<div class="parent-student-card"><p class="psc-section-title">This week's hardest words (whole class)</p><div class="psc-needs-work">${rows}</div></div>`;
  }

  // C2: kept in module scope so the roster table's expand-on-tap (below) can
  // find one student's full data without a second Firestore round trip —
  // loadParentDashboard already fetched it a moment ago.
  let lastDashboardResults = [];

  async function loadParentDashboard() {
    const wrap = document.getElementById("parent-dash-cards");
    const students = getProfiles().filter((p) => p.role !== "parent");
    if (!students.length) {
      wrap.innerHTML = '<p class="psc-empty">No student profiles in this household yet.</p>';
      return;
    }
    wrap.innerHTML = students.map((s) => `<div class="parent-student-card"><p class="psc-loading">Loading ${escapeAttr(s.name)}…</p></div>`).join("");

    await ensureCatalogLoaded();
    const results = await Promise.all(students.map((s) => loadStudentDashboardData(s)));

    // Bail if the parent exited (or a different one entered) while this
    // was in flight — don't clobber whatever screen is showing now.
    if (!state.parentProfile) return;
    lastDashboardResults = results;
    const hardestCard = renderHardestWordsCard(results);
    // Same threshold spirit as the profile picker's own search cutoff
    // (PROFILE_SEARCH_THRESHOLD): a full card per kid is fine for a family
    // of 2-4, but a class of 25 turns "who hasn't started this week?" into a
    // very long scroll. Full detail is one tap away, not gone.
    wrap.innerHTML = hardestCard + (students.length > PROFILE_SEARCH_THRESHOLD ? renderRosterTable(results) : results.map(renderStudentCard).join(""));
  }

  // Least-active-first by default — that's the actual question a teacher
  // opens this for ("who hasn't practiced?"), not alphabetical order.
  // lastActiveDate sorts correctly as a plain string (YYYY-MM-DD) and an
  // empty one (never practiced) correctly sorts first.
  function renderRosterTable(results) {
    const sorted = results.slice().sort((a, b) => (a.student.lastActiveDate || "").localeCompare(b.student.lastActiveDate || ""));
    const rows = sorted.map(({ student, dates, activityByDate, progress }) => {
      const weekAnswers = dates.reduce((sum, d) => sum + ((activityByDate[d] && activityByDate[d].answers) || 0), 0);
      const medals = { gold: 0, silver: 0, bronze: 0 };
      (progress ? progress.words : []).forEach((w) => { const m = wordMedal(w); if (medals[m] !== undefined) medals[m]++; });
      const needsWork = wordsNeedingWork(progress).length;
      return `
        <tr class="roster-row" data-roster-toggle="${student.id}">
          <td class="roster-name"><span class="avatar">${avatarHtml(student)}</span>${escapeAttr(student.name)}</td>
          <td>${relativeDateLabel(student.lastActiveDate)}</td>
          <td>${weekAnswers}</td>
          <td>🥇${medals.gold} 🥈${medals.silver} 🥉${medals.bronze}</td>
          <td>${needsWork}</td>
        </tr>
        <tr class="roster-detail-row hidden" data-roster-detail="${student.id}"><td colspan="5"></td></tr>`;
    }).join("");
    return `<div class="roster-table-wrap"><table class="roster-table">
      <thead><tr><th>Student</th><th>Last practiced</th><th>Answers this wk</th><th>Medals</th><th>Needs work</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  // A student's grade only ever gets SET at creation (createStudentProfile) —
  // there was no edit path at all before this, which matters most exactly
  // once a year (promotion) and once per roster typo caught on day one. Wired
  // as one delegated listener on the container, not per-card handlers,
  // because loadParentDashboard() replaces every card's innerHTML wholesale
  // on every refresh — element-level listeners would just be discarded.
  // Deliberately no delete here: see the comment on PARENT SELF-MANAGE above.
  document.getElementById("parent-dash-cards").addEventListener("click", (e) => {
    const rosterRow = e.target.closest("[data-roster-toggle]");
    if (rosterRow) {
      const id = rosterRow.getAttribute("data-roster-toggle");
      const detailRow = document.querySelector(`[data-roster-detail="${id}"]`);
      if (!detailRow) return;
      const opening = detailRow.classList.contains("hidden");
      detailRow.classList.toggle("hidden");
      // Lazy-filled on first expand, not up front for every row — the whole
      // point of the compact table is not rendering N full cards at once.
      if (opening && !detailRow.dataset.loaded) {
        const data = lastDashboardResults.find((r) => r.student.id === id);
        if (data) { detailRow.querySelector("td").innerHTML = renderStudentCard(data); detailRow.dataset.loaded = "1"; }
      }
      return;
    }
    const toggleBtn = e.target.closest("[data-edit-toggle]");
    if (toggleBtn) {
      const form = document.querySelector(`.psc-edit-form[data-edit-form="${toggleBtn.getAttribute("data-edit-toggle")}"]`);
      if (form) form.classList.toggle("hidden");
      return;
    }
    const cancelBtn = e.target.closest("[data-edit-cancel]");
    if (cancelBtn) {
      const form = document.querySelector(`.psc-edit-form[data-edit-form="${cancelBtn.getAttribute("data-edit-cancel")}"]`);
      if (form) form.classList.add("hidden");
      return;
    }
    const saveBtn = e.target.closest("[data-edit-save]");
    if (saveBtn) saveStudentEdit(saveBtn.getAttribute("data-edit-save"));
  });

  function saveStudentEdit(id) {
    const form = document.querySelector(`.psc-edit-form[data-edit-form="${id}"]`);
    if (!form) return;
    const name = form.querySelector(".psc-edit-name").value.trim().slice(0, ROSTER_NAME_MAX);
    const grade = form.querySelector(".psc-edit-grade").value.trim();
    if (!name) { toast("Type a name first"); return; }
    updateLocalProfileFields(id, { name, grade });
    const updated = getProfiles().find((p) => p.id === id);
    if (firestoreReady() && updated) Sync.pushProfile(updated);
    toast("Saved");
    loadParentDashboard();
  }

  /* ---------------------------------------------------------------------
   * SCHOOL OVERVIEW (docs/school-scale-plan.md Phase 3)
   * Read-only, aggregate-only, cross-class. Deliberately does NOT show any
   * individual student's name, avatar, or score — only counts — because
   * that's the whole reason a "class" is its own household in the first
   * place (see the plan's "one decision everything else follows from").
   * Reached from Parent Dashboard, the closest existing PIN-gated admin
   * screen, since a principal viewing this is already past that gate.
   * The watchlist (which class codes to show) is a local-only convenience —
   * it lives on whichever device the principal uses for this, no new
   * Firestore collection.
   * ------------------------------------------------------------------- */
  const SCHOOL_WATCHLIST_KEY = "ws_school_watchlist";
  function getSchoolWatchlist() { return load(SCHOOL_WATCHLIST_KEY, []); }
  function saveSchoolWatchlist(list) { save(SCHOOL_WATCHLIST_KEY, list); }

  function parseWatchlistText(text) {
    return text.split("\n")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        const idx = line.indexOf(",");
        const code = (idx === -1 ? line : line.slice(0, idx)).trim().slice(0, 60);
        const label = (idx === -1 ? "" : line.slice(idx + 1).trim()).slice(0, 60);
        return { code, label };
      })
      .filter((c) => c.code);
  }

  function openSchoolOverview() {
    const list = getSchoolWatchlist();
    document.getElementById("school-watchlist-input").value = list.map((c) => c.label ? `${c.code}, ${c.label}` : c.code).join("\n");
    showScreen("school-overview");
    loadSchoolOverview();
  }
  document.getElementById("parent-dash-school-overview").addEventListener("click", openSchoolOverview);
  document.getElementById("school-overview-exit").addEventListener("click", () => openParentDashboard());

  document.getElementById("btn-save-watchlist").addEventListener("click", () => {
    saveSchoolWatchlist(parseWatchlistText(document.getElementById("school-watchlist-input").value));
    toast("Saved!");
    loadSchoolOverview();
  });

  // "Practiced this week" is read directly off each profile's own
  // lastActiveDate field (already written by the existing streak logic,
  // recordDailyStreak) rather than pulling every profile's daily activity
  // docs — one Firestore read per watched class regardless of its student
  // count, instead of one per student. Cheaper, and the plan's own capacity
  // math (Firestore Spark's daily caps) is exactly why that cost matters
  // more here than it does for a single household's own dashboard.
  async function loadSchoolOverview() {
    const list = getSchoolWatchlist();
    const wrap = document.getElementById("school-overview-rows");
    if (!list.length) {
      wrap.innerHTML = '<p class="hint">No classes watched yet — add class codes below.</p>';
      return;
    }
    wrap.innerHTML = list.map((c) => `<div class="school-overview-row"><span class="school-overview-label">${escapeAttr(c.label || c.code)}</span><span class="school-overview-stats psc-loading">Loading…</span></div>`).join("");

    const cutoff = localDateMinusDays(todayLocalStr(), 6);
    const results = await Promise.all(list.map(async (c) => {
      let profiles = null;
      if (typeof Sync !== "undefined") {
        try { profiles = await Sync.fetchHouseholdProfiles(c.code); } catch (e) { profiles = null; }
      }
      return { c, profiles };
    }));

    wrap.innerHTML = results.map(({ c, profiles }) => {
      if (!profiles) {
        return `<div class="school-overview-row"><span class="school-overview-label">${escapeAttr(c.label || c.code)}</span><span class="school-overview-stats">Couldn't load</span></div>`;
      }
      const students = profiles.filter((p) => (p.role || "") !== "parent");
      const active = students.filter((p) => p.lastActiveDate && p.lastActiveDate >= cutoff).length;
      return `<div class="school-overview-row"><span class="school-overview-label">${escapeAttr(c.label || c.code)}</span><span class="school-overview-stats">${students.length} student${students.length === 1 ? "" : "s"} · ${active} of ${students.length} practiced this week</span></div>`;
    }).join("");
  }

  document.getElementById("btn-switch-profile").addEventListener("click", () => {
    renderProfiles();
    showScreen("profiles");
    watchProfilesList();
  });
  document.getElementById("btn-home").addEventListener("click", () => {
    renderHome();
    showScreen("home");
  });

  function refreshMuteButton() {
    document.getElementById("btn-mute-toggle").textContent = isMuted() ? "🔇" : "🔊";
  }
  document.getElementById("btn-mute-toggle").addEventListener("click", () => {
    setMuted(!isMuted());
    refreshMuteButton();
  });

  /* ---------------------------------------------------------------------
   * CATALOG (shared word lists, organized by grade + week)
   * ------------------------------------------------------------------- */

  // Catalog weeks are SHARED, cross-household-writable content: anyone holding
  // the catalog code can write `catalogs/{code}/weeks/{id}` directly, so week
  // docs are untrusted input arriving from a different user, not our own data.
  // A malformed doc (missing `words`, `words` not an array, junk types) must
  // degrade to "skipped" here at the boundary rather than throw a TypeError
  // deep inside a render path and take down week selection for everyone
  // sharing that catalog. Returns null for a week that can't be salvaged.
  function sanitizeWeek(week) {
    if (!week || typeof week !== "object") return null;
    if (typeof week.id !== "string" || !week.id) return null;
    const rawWords = Array.isArray(week.words) ? week.words : [];
    return {
      id: week.id,
      grade: typeof week.grade === "string" ? week.grade : "",
      weekNumber: typeof week.weekNumber === "number" ? week.weekNumber : 0,
      // Anything not a real local-calendar date string is dropped rather than
      // kept, because weekStartDate is compared as a string in
      // computeAutoWeek() — junk would silently reorder the school year
      // instead of failing loudly.
      weekStartDate: /^\d{4}-\d{2}-\d{2}$/.test(week.weekStartDate) ? week.weekStartDate : "",
      label: typeof week.label === "string" ? week.label : week.id,
      words: rawWords
        .filter((w) => w && typeof w === "object" && typeof w.id === "string" && w.id && typeof w.text === "string" && w.text)
        .map((w) => ({ id: w.id, text: w.text, definition: typeof w.definition === "string" ? w.definition : "" })),
    };
  }

  function sanitizeWeeks(list) {
    return (Array.isArray(list) ? list : []).map(sanitizeWeek).filter(Boolean);
  }

  function computeAutoWeek(weeks, grade) {
    // A week whose start date failed sanitization is excluded from automatic
    // selection — it stays reachable via the manual week picker, but must not
    // win the "nearest past start date" race by virtue of being an empty string.
    const gradeWeeks = weeks.filter((w) => w.grade === grade && w.weekStartDate).sort((a, b) => (a.weekStartDate < b.weekStartDate ? -1 : 1));
    if (!gradeWeeks.length) return null;
    const today = todayLocalStr();
    let chosen = gradeWeeks[0];
    for (const w of gradeWeeks) {
      if (w.weekStartDate <= today) chosen = w;
      else break;
    }
    return chosen;
  }

  async function loadProgressForWeek(profileId, week) {
    let progress = load(progressKey(profileId, week.id), null);
    if (!progress && firestoreReady()) {
      try { progress = await Sync.fetchProgress(profileId, week.id); } catch (e) { /* ignore */ }
    }
    const freshStat = () => ({ spelling: { correct: 0, attempts: 0 }, vocab: { known: 0, attempts: 0 } });
    // Both sides are untrusted: `week` may be a poisoned shared-catalog doc,
    // and `progress` may be a corrupt localStorage entry or a doc written by
    // another device in this household. Neither may be assumed to have a
    // usable `words` array.
    const catalogWords = Array.isArray(week.words) ? week.words : [];
    if (!progress) {
      progress = {
        weekId: week.id,
        grade: week.grade,
        label: week.label,
        words: catalogWords.map((w) => Object.assign({ id: w.id, text: w.text, definition: w.definition || "" }, freshStat())),
      };
    } else {
      // Reconcile in case the catalog's word list changed since last practiced.
      const priorWords = Array.isArray(progress.words) ? progress.words : [];
      const existingById = new Map(priorWords.filter((w) => w && w.id).map((w) => [w.id, w]));
      progress.words = catalogWords.map((w) => existingById.get(w.id) || Object.assign({ id: w.id, text: w.text, definition: w.definition || "" }, freshStat()));
      progress.label = week.label;
      progress.grade = week.grade;
    }
    saveProgressLocal(profileId, week.id, progress);
    return progress;
  }

  function lastSeenWeekKey(profileId) { return `ws_last_seen_week_${profileId}`; }

  // B1: a one-time closure moment for the week that just ended, shown the
  // first time Home actually auto-advances onto a new one — otherwise a
  // week's medals just silently vanish behind whatever's now current, with
  // nothing marking that a week finished. AUTO path only (manual==true, the
  // "Change Week" picker, must never trigger this — browsing older weeks on
  // purpose isn't a rollover) and fires at most once per transition, tracked
  // by the last week id this device saw for this profile.
  function checkWeekRollover(profileId, newWeek) {
    const key = lastSeenWeekKey(profileId);
    const lastSeenId = localStorage.getItem(key);
    localStorage.setItem(key, newWeek.id);
    if (!lastSeenId || lastSeenId === newWeek.id) return;
    const prior = load(progressKey(profileId, lastSeenId), null);
    if (!prior || !Array.isArray(prior.words) || !prior.words.length) return;
    const counts = { gold: 0, silver: 0 };
    prior.words.forEach((w) => { const m = wordMedal(w); if (counts[m] !== undefined) counts[m]++; });
    if (!counts.gold && !counts.silver) return; // nothing practiced last week — not worth a recap
    toast(`📋 Last week: 🥇 ${counts.gold} · 🥈 ${counts.silver} — new list!`);
    celebrate("small");
  }

  async function selectWeek(week, manual) {
    if (!manual) checkWeekRollover(state.profile.id, week);
    state.selectedWeek = week;
    if (manual) save(selectedWeekKey(state.profile.id), week.id);
    state.progress = await loadProgressForWeek(state.profile.id, week);
    if (firestoreReady()) Sync.watchProgress(state.profile.id, week.id, applyRemoteProgressUpdate);
    renderHome();
    showScreen("home");
  }

  // Returns the catalog code in use, or null if this household has none yet
  // connected (only meaningful when firestoreReady()). Populates
  // state.catalogWeeks either way. Shared by the student catalog/week flow
  // and the parent dashboard, which needs word lists but must never touch
  // per-profile week selection.
  async function ensureCatalogLoaded() {
    let code;
    if (!firestoreReady()) {
      code = LOCAL_CATALOG;
    } else {
      code = Sync.getCatalogCode();
      if (!code) {
        try { code = await Sync.fetchHouseholdCatalogCode(); } catch (e) { code = null; }
        if (code) Sync.cacheCatalogCode(code);
      }
      if (!code) {
        state.catalogWeeks = [];
        return null;
      }
    }

    state.catalogWeeks = sanitizeWeeks(load(catalogWeeksKey(code), []));
    if (firestoreReady()) {
      try {
        const remote = sanitizeWeeks(await Sync.fetchCatalogWeeks(code));
        if (remote.length) { state.catalogWeeks = remote; save(catalogWeeksKey(code), remote); }
      } catch (e) { /* fall back to local cache */ }
    }
    return code;
  }

  async function loadCatalogAndWeek() {
    const code = await ensureCatalogLoaded();
    if (!code) {
      state.selectedWeek = null;
      state.progress = null;
      showScreen("catalog-setup");
      return;
    }

    let week = null;
    const savedWeekId = localStorage.getItem(selectedWeekKey(state.profile.id));
    let pinned = savedWeekId ? state.catalogWeeks.find((w) => w.id === savedWeekId) : null;
    // A "Change Week" pin was meant for a one-off peek, not a permanent
    // opt-out of auto-advance — without this, tapping it once ever freezes
    // that profile's own-grade week forever, since nothing else ever clears
    // the saved id. Only expires a pin on the SAME grade the profile is
    // actually enrolled in: a deliberate look at another grade's list is left
    // alone, since there's no "current week" to compare it against.
    if (pinned && state.profile.grade && pinned.grade === state.profile.grade) {
      const auto = computeAutoWeek(state.catalogWeeks, state.profile.grade);
      if (auto && auto.id !== pinned.id && auto.weekStartDate > pinned.weekStartDate) {
        localStorage.removeItem(selectedWeekKey(state.profile.id));
        pinned = null;
      }
    }
    week = pinned;
    if (!week && state.profile.grade) week = computeAutoWeek(state.catalogWeeks, state.profile.grade);
    if (!week && state.catalogWeeks.length) week = state.catalogWeeks[0];

    if (!week) {
      state.selectedWeek = null;
      state.progress = null;
      renderHome();
      showScreen("home");
      return;
    }
    await selectWeek(week, false);
  }

  document.getElementById("btn-connect-catalog").addEventListener("click", async () => {
    const input = document.getElementById("catalog-code-input");
    let code = input.value.trim();
    const btn = document.getElementById("btn-connect-catalog");
    btn.disabled = true;
    try {
      if (!code) code = generateCode(8);
      await Sync.connectCatalog(code);
      input.value = "";
      toast("Connected! Catalog code: " + code);
      await loadCatalogAndWeek();
    } catch (e) {
      toast(e && e.message === "Invalid catalog code"
        ? "That catalog code has characters that aren't allowed — try letters, numbers, spaces, or dashes."
        : "Couldn't connect — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  });

  function parseCatalogText(text) {
    const lines = text.split("\n");
    const weeks = [];
    let currentGrade = null;
    let currentStart = null;
    let weekNum = 0;
    // C3: without this, pasting just one week (to fix or update it) always
    // lands on whatever position it is within THIS paste — almost always
    // week 1 — silently overwriting the wrong week instead of the one being
    // edited. An explicit `WEEK N` line overrides the auto-incremented
    // position for the block that follows it only; a normal multi-week paste
    // with no WEEK markers at all keeps behaving exactly as before.
    let explicitWeekNum = null;
    let block = [];

    function flushBlock() {
      if (block.length === 0) return;
      weekNum++;
      const useWeekNum = explicitWeekNum != null ? explicitWeekNum : weekNum;
      explicitWeekNum = null;
      // Length caps are pure hardening, not a UX limit — no real spelling
      // word or definition comes close to 200 characters. Bounds how much a
      // single hostile line in a shared catalog paste can bloat the shared
      // Firestore document before its 1MiB cap kicks in anyway, so a bad
      // paste degrades that one word instead of failing the whole save.
      const words = block
        .map((line) => {
          const idx = line.indexOf(",");
          const wtext = idx === -1 ? line : line.slice(0, idx);
          const definition = idx === -1 ? "" : line.slice(idx + 1).trim();
          return { id: uid(), text: wtext.trim().slice(0, 200), definition: definition.slice(0, 500) };
        })
        .filter((w) => w.text);
      if (words.length && currentGrade) {
        const start = new Date(currentStart + "T00:00:00");
        start.setDate(start.getDate() + (useWeekNum - 1) * 7);
        const dateStr = dateToLocalStr(start);
        weeks.push({
          id: `${slugify(currentGrade)}-w${useWeekNum}`,
          grade: currentGrade,
          weekNumber: useWeekNum,
          weekStartDate: dateStr,
          label: `Grade ${currentGrade} · Week ${useWeekNum}`,
          words,
        });
      }
      block = [];
    }

    lines.forEach((raw) => {
      const line = raw.trim();
      const gradeMatch = line.match(/^grade\s+(\S+)\s*(?:\(starts\s+(\d{4}-\d{2}-\d{2})\))?/i);
      if (gradeMatch) {
        flushBlock();
        currentGrade = gradeMatch[1];
        currentStart = gradeMatch[2] || todayLocalStr();
        weekNum = 0;
        explicitWeekNum = null;
        return;
      }
      const weekMatch = line.match(/^week\s+(\d+)\b/i);
      if (weekMatch) {
        flushBlock(); // in case words were already piling up with no blank line before this marker
        explicitWeekNum = parseInt(weekMatch[1], 10);
        return;
      }
      if (!line) { flushBlock(); return; }
      block.push(line);
    });
    flushBlock();
    return weeks;
  }

  function mergeWeeks(existing, incoming) {
    const map = new Map(existing.map((w) => [w.id, w]));
    incoming.forEach((w) => map.set(w.id, w));
    return Array.from(map.values());
  }

  /* ---------------------------------------------------------------------
   * C3: PER-WEEK CATALOG MANAGEMENT — edit/delete one week instead of only
   * ever re-pasting a whole grade's year. "Edit" reuses the exact same
   * paste -> preview -> save flow (parseCatalogText's WEEK N support above
   * is what makes that land on the right week instead of always week 1);
   * this just pre-fills the box with a paste that round-trips correctly.
   * ------------------------------------------------------------------- */

  // Reconstructs the GRADE header's implied start date (week 1's date) from
  // this week's own stored date and position — parseCatalogText always
  // computes weekStartDate as seriesStart + (weekNumber-1)*7 days, so
  // subtracting that same offset recovers exactly the date that regenerates
  // this week's real weekStartDate when the paste is re-parsed.
  function impliedSeriesStart(week) {
    if (!week.weekStartDate) return todayLocalStr();
    const wn = week.weekNumber || 1;
    const d = new Date(week.weekStartDate + "T00:00:00");
    d.setDate(d.getDate() - (wn - 1) * 7);
    return dateToLocalStr(d);
  }

  function weekToPasteText(week) {
    const lines = [`GRADE ${week.grade} (starts ${impliedSeriesStart(week)})`, "", `WEEK ${week.weekNumber || 1}`, ""];
    (week.words || []).forEach((w) => lines.push(w.definition ? `${w.text}, ${w.definition}` : w.text));
    return lines.join("\n");
  }

  function renderCatalogWeeksManager() {
    const wrap = document.getElementById("catalog-weeks-list");
    if (!wrap) return;
    if (!state.catalogWeeks.length) { wrap.innerHTML = '<p class="hint">No weeks in this catalog yet.</p>'; return; }
    const grades = Array.from(new Set(state.catalogWeeks.map((w) => w.grade))).sort();
    wrap.innerHTML = grades.map((g) => {
      const rows = state.catalogWeeks
        .filter((w) => w.grade === g)
        .sort((a, b) => a.weekNumber - b.weekNumber)
        .map((w) => `
          <div class="result-row">
            <span>${escapeAttr(w.label)} <span style="font-weight:400;color:var(--muted);font-size:.85rem">(${w.words.length} words)</span></span>
            <span class="catalog-week-actions">
              <button class="icon-btn-sm" data-week-edit="${w.id}" title="Load into the box below to edit">✏️</button>
              <button class="icon-btn-sm" data-week-delete="${w.id}" title="Delete this week">🗑️</button>
            </span>
          </div>`)
        .join("");
      return `<div class="week-picker-group-title">Grade ${escapeAttr(g)}</div>${rows}`;
    }).join("");
  }

  document.getElementById("catalog-weeks-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-week-edit]");
    if (editBtn) {
      const week = state.catalogWeeks.find((w) => w.id === editBtn.getAttribute("data-week-edit"));
      if (!week) return;
      document.getElementById("catalog-paste-input").value = weekToPasteText(week);
      document.getElementById("catalog-paste-input").scrollIntoView({ behavior: "smooth", block: "center" });
      toast("Loaded below — edit the words, then Preview and Save to update just this week.");
      return;
    }
    const delBtn = e.target.closest("[data-week-delete]");
    if (delBtn) {
      const week = state.catalogWeeks.find((w) => w.id === delBtn.getAttribute("data-week-delete"));
      if (week) requestDeleteWeek(week);
    }
  });

  // D1-style in-app confirm rather than a native confirm() — same reasoning
  // as the Star Shop purchase confirm (see requestBuyItem): a native dialog
  // inside an installed, standalone PWA reads as a browser error, not part
  // of the app.
  let pendingWeekDelete = null;
  function requestDeleteWeek(week) {
    pendingWeekDelete = week;
    document.getElementById("catalog-week-delete-label").textContent = week.label;
    document.getElementById("catalog-week-delete-confirm").classList.remove("hidden");
  }
  document.getElementById("btn-catalog-week-delete-cancel").addEventListener("click", () => {
    pendingWeekDelete = null;
    document.getElementById("catalog-week-delete-confirm").classList.add("hidden");
  });
  document.getElementById("btn-catalog-week-delete-yes").addEventListener("click", async () => {
    const week = pendingWeekDelete;
    pendingWeekDelete = null;
    document.getElementById("catalog-week-delete-confirm").classList.add("hidden");
    if (!week) return;
    const code = getCatalogCode();
    state.catalogWeeks = state.catalogWeeks.filter((w) => w.id !== week.id);
    save(catalogWeeksKey(code), state.catalogWeeks);
    renderCatalogWeeksManager();
    toast(`Deleted ${week.label}`);
    if (firestoreReady() && code !== LOCAL_CATALOG) {
      try { await Sync.deleteCatalogWeek(code, week.id); }
      catch (e) { toast("Deleted locally — sync didn't confirm it, so it may come back."); }
    }
    if (state.profile) await loadCatalogAndWeek();
  });

  let catalogParsePreview = [];

  async function openCatalogEditor() {
    const code = getCatalogCode();
    document.getElementById("catalog-code-display").textContent = code === LOCAL_CATALOG ? "(this device only)" : code;
    document.getElementById("catalog-paste-input").value = "";
    document.getElementById("catalog-preview").classList.add("hidden");
    document.getElementById("btn-save-catalog").classList.add("hidden");
    document.getElementById("btn-copy-catalog-link").classList.toggle("hidden", code === LOCAL_CATALOG);
    showScreen("catalog-editor");
    renderCatalogWeeksManager();

    // Ownership is a soft guardrail (same posture as household/catalog
    // codes themselves), not a hard permission — it just keeps someone from
    // *accidentally* overwriting another household's shared word list.
    //
    // Compared via opaque ownerToken, never the household code: a catalog doc
    // is readable by every household the catalog code is shared with, so the
    // code itself must never appear on it (see connectCatalog in sync.js).
    // Legacy catalogs carrying the old plaintext `ownerHousehold` field, and
    // catalogs with no owner recorded at all (e.g. the real zoelive catalog,
    // created before either existed), stay editable by everyone — failing
    // open keeps anything already live from being locked out.
    //
    // editorTokens (docs/school-scale-plan.md's shared-school-catalog model):
    // a second, third, etc. class is never auto-granted edit access just by
    // connecting — the whole point of a soft guardrail is that it keeps
    // *accidental* overwrites, not deliberate collaboration, from happening
    // without a person choosing it — but the readonly note now offers an
    // explicit one-tap way to grant it, instead of dead-ending at "ask them."
    const note = document.getElementById("catalog-readonly-note");
    const form = document.getElementById("catalog-editor-form");
    note.classList.add("hidden");
    note.innerHTML = "";
    form.classList.remove("hidden");
    if (code !== LOCAL_CATALOG && firestoreReady()) {
      try {
        const meta = await Sync.fetchCatalogMeta(code);
        const owner = meta && meta.ownerToken;
        const editors = (meta && Array.isArray(meta.editorTokens)) ? meta.editorTokens : [];
        const mine = await Sync.ensureOwnerToken();
        const isEditor = !owner || !mine || owner === mine || editors.includes(mine);
        if (!isEditor) {
          note.innerHTML = 'This catalog is managed by another class — ask them to add new weeks, or <button id="btn-request-catalog-edit" class="link-btn">enable editing for this class too</button>.';
          note.classList.remove("hidden");
          form.classList.add("hidden");
          document.getElementById("btn-request-catalog-edit").addEventListener("click", async () => {
            const ok = await Sync.addCatalogEditor(code);
            if (ok) { toast("Editing enabled — you can add your grade's weeks now"); openCatalogEditor(); }
            else toast("Couldn't enable editing — check your internet and try again.");
          });
        }
      } catch (e) { /* ignore — fail open to editable, matching the app's existing offline-friendly fallbacks */ }
    }
  }
  document.getElementById("btn-manage-catalog").addEventListener("click", openCatalogEditor);
  document.getElementById("catalog-editor-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });
  document.getElementById("btn-copy-catalog-link").addEventListener("click", () => {
    const code = getCatalogCode();
    if (code && code !== LOCAL_CATALOG) copyToClipboard(inviteURL("catalog", code));
  });

  document.getElementById("btn-preview-catalog").addEventListener("click", () => {
    const text = document.getElementById("catalog-paste-input").value;
    catalogParsePreview = parseCatalogText(text);
    const box = document.getElementById("catalog-preview");
    if (!catalogParsePreview.length) {
      box.innerHTML = '<p class="hint">Nothing parsed yet — check the format (each grade needs a "GRADE ..." line).</p>';
      box.classList.remove("hidden");
      document.getElementById("btn-save-catalog").classList.add("hidden");
      return;
    }
    box.innerHTML = "";
    catalogParsePreview.forEach((w) => {
      const row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = `<span>${escapeAttr(w.label)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${w.words.length} words · starts ${w.weekStartDate}</span>`;
      box.appendChild(row);
    });
    box.classList.remove("hidden");
    document.getElementById("btn-save-catalog").classList.remove("hidden");
  });

  document.getElementById("btn-save-catalog").addEventListener("click", async () => {
    const code = getCatalogCode();
    const btn = document.getElementById("btn-save-catalog");
    btn.disabled = true;
    try {
      if (firestoreReady()) await Sync.saveCatalogWeeks(code, catalogParsePreview);
      const key = catalogWeeksKey(code);
      // sanitizeWeeks() here is belt-and-suspenders, not a fix for a known
      // gap: catalogParsePreview already satisfies its invariants since
      // parseCatalogText() built it. It's applied anyway for parity with
      // ensureCatalogLoaded() — every OTHER path that sets state.catalogWeeks
      // goes through it, and a future change to the parser silently losing
      // that guarantee should degrade gracefully here too, not reopen the
      // "poisoned catalog crashes other households" bug sanitizeWeek() exists
      // to prevent (see docs/HANDOFF.md).
      const merged = sanitizeWeeks(mergeWeeks(load(key, []), catalogParsePreview));
      save(key, merged);
      state.catalogWeeks = merged;
      toast(`Saved ${catalogParsePreview.length} week${catalogParsePreview.length === 1 ? "" : "s"}!`);
      document.getElementById("catalog-paste-input").value = "";
      document.getElementById("catalog-preview").classList.add("hidden");
      btn.classList.add("hidden");
      renderCatalogWeeksManager();
      if (state.profile) await loadCatalogAndWeek();
    } catch (e) {
      toast("Couldn't save — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------------------------------------------------------------
   * STARTER WORD LISTS
   * The app's single biggest adoption blocker was that a brand new family
   * opens it to "No word list yet" and cannot do anything at all until
   * someone types out a full week of words. These bundled packs
   * (js/starter-lists.js) make it two taps to a usable app.
   * ------------------------------------------------------------------- */
  function mondayOfThisWeek() {
    return weekDatesMonToSun(todayLocalStr())[0];
  }

  function starterPackWordCount(pack) {
    return pack.weeks.reduce((n, w) => n + w.vocab.length + w.spelling.length, 0);
  }

  function openStarterLists() {
    const wrap = document.getElementById("starter-list-grid");
    wrap.innerHTML = "";
    StarterLists.PACKS.forEach((pack) => {
      const card = document.createElement("div");
      card.className = "starter-card";
      card.innerHTML =
        `<div class="starter-card-title">${escapeAttr(pack.label)}</div>` +
        `<div class="starter-card-desc">${escapeAttr(pack.description)}</div>` +
        `<div class="starter-card-meta">${pack.weeks.length} weeks · ${starterPackWordCount(pack)} words</div>`;
      const btn = document.createElement("button");
      btn.className = "btn btn-primary starter-card-btn";
      btn.textContent = "Add to My Lists";
      btn.addEventListener("click", () => importStarterPack(pack, btn));
      card.appendChild(btn);
      wrap.appendChild(card);
    });
    showScreen("starter-lists");
  }

  // Deliberately mirrors the paste-import save path (btn-save-catalog) rather
  // than inventing a second one: same mergeWeeks, same local+Firestore write,
  // same loadCatalogAndWeek refresh — so a starter pack behaves exactly like
  // a pasted list once imported and there's only one code path to reason
  // about when catalog writes go wrong.
  async function importStarterPack(pack, btn) {
    const weeks = StarterLists.toWeeks(pack.grade, mondayOfThisWeek(), dateToLocalStr);
    if (!weeks.length) { toast("That starter list is empty."); return; }
    btn.disabled = true;
    try {
      const code = getCatalogCode();
      if (firestoreReady()) await Sync.saveCatalogWeeks(code, weeks);
      const key = catalogWeeksKey(code);
      const merged = sanitizeWeeks(mergeWeeks(load(key, []), weeks));
      save(key, merged);
      state.catalogWeeks = merged;
      // A student profile with no grade set yet would otherwise import words
      // and still land on "No word list yet", since computeAutoWeek() filters
      // by grade — adopt the pack's grade so the import visibly works.
      if (state.profile && state.profile.role !== "parent" && !state.profile.grade) {
        state.profile.grade = pack.grade;
        persistProfile();
      }
      toast(`Added ${weeks.length} weeks of ${pack.label}! 🎉`);
      celebrate("small");
      if (state.profile) await loadCatalogAndWeek();
      renderHome();
      showScreen("home");
    } catch (e) {
      toast("Couldn't add that list — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById("starter-lists-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });
  document.getElementById("btn-home-starter-lists").addEventListener("click", openStarterLists);
  document.getElementById("btn-starter-lists-from-catalog").addEventListener("click", openStarterLists);

  /* ---------------------------------------------------------------------
   * DAILY GOAL
   * A visible, resettable target for "am I done for today?" — the streak
   * system rewards showing up at all, this rewards actually finishing a
   * useful amount. Counts answers, which every study mode already reports
   * through recordAnswer(), so no mode needs to know this exists.
   * ------------------------------------------------------------------- */
  const DAILY_GOAL_ANSWERS = 20;
  const DAILY_GOAL_BONUS = 5;

  function renderDailyGoal() {
    const el = document.getElementById("home-daily-goal");
    if (!state.profile || state.profile.role === "parent") { el.classList.add("hidden"); return; }
    const a = getOrInitActivity();
    if (!a) { el.classList.add("hidden"); return; }
    const done = Math.min(a.answers || 0, DAILY_GOAL_ANSWERS);
    const pct = Math.round((done / DAILY_GOAL_ANSWERS) * 100);
    const met = (a.answers || 0) >= DAILY_GOAL_ANSWERS;
    document.getElementById("daily-goal-label").textContent = met ? "🎉 Goal complete!" : "Today's Goal";
    document.getElementById("daily-goal-count").textContent = `${done} / ${DAILY_GOAL_ANSWERS}`;
    const fill = document.getElementById("daily-goal-fill");
    fill.style.width = pct + "%";
    fill.classList.toggle("met", met);
    el.classList.remove("hidden");
  }

  // Called from recordAnswer, so it fires the moment the goal is crossed
  // mid-session rather than only when the kid returns to Home. `goalAwarded`
  // is persisted on the activity doc (not just held in memory) so reloading
  // the page or practicing on a second device can't re-award the bonus.
  function checkDailyGoal(activity) {
    if (!activity || activity.goalAwarded) return;
    if ((activity.answers || 0) < DAILY_GOAL_ANSWERS) return;
    activity.goalAwarded = true;
    addStars(DAILY_GOAL_BONUS);
    activity.starsEarned = (activity.starsEarned || 0) + DAILY_GOAL_BONUS;
    toast(`🎯 Daily goal reached! +${DAILY_GOAL_BONUS} ⭐`);
    celebrate("big");
    playSound("medal");
    reactBuddy("cheer");
    flushActivity();
  }

  /* ---------------------------------------------------------------------
   * "LOCK IT IN" RETYPE GATE
   * Spelling Practice and Smart Review are the only two modes where the answer
   * IS the spelling the child typed, so they are the only two where writing the
   * word once more is the same act as the thing being practiced. On a miss the
   * Continue button stays hidden until the word has been typed correctly once —
   * framed as locking the spelling in, never as a penalty.
   *
   * Both modes drive this through an id prefix ("spell" / "review") because
   * their submit handlers are duplicated code rather than a shared helper;
   * routing the gate through one object here keeps the two from drifting apart
   * the way the handlers themselves already have.
   *
   * The retype is never reported to recordAnswer(): the miss was already
   * recorded, and a second call would double-count the attempt, re-enter the
   * star economy, and could even hand out a medal-up for the word the child
   * just got wrong.
   * ------------------------------------------------------------------- */
  let retype = { active: false, prefix: "", target: "" };

  function beginRetype(prefix, wordText) {
    retype = { active: true, prefix, target: normalizeSpelling(wordText) };
    const input = document.getElementById(prefix + "-input");
    const submit = document.getElementById(prefix + "-submit");
    input.value = "";
    input.disabled = false;
    submit.textContent = "Lock It In";
    submit.classList.remove("hidden");
    document.getElementById(prefix + "-continue").classList.add("hidden");
    input.focus();
  }

  // Called by the submit handlers before they grade anything. Returns true when
  // it consumed the click, so the caller knows not to fall through into scoring
  // a retype as if it were a fresh attempt at the word.
  function handleRetypeSubmit() {
    if (!retype.active) return false;
    const prefix = retype.prefix;
    const input = document.getElementById(prefix + "-input");
    const answer = input.value.trim();
    if (!answer) { input.focus(); return true; }
    if (normalizeSpelling(answer) !== retype.target) {
      // No message and no sound on a wrong retype — the correct spelling is
      // still displayed directly above the input, so anything written here
      // would only be repeating what they can already see, in a scolding tone.
      input.value = "";
      input.classList.remove("input-shake");
      void input.offsetWidth; // restart the animation; without the reflow a second miss in a row would not shake
      input.classList.add("input-shake");
      setTimeout(() => input.classList.remove("input-shake"), 400);
      input.focus();
      return true;
    }
    const feedback = document.getElementById(prefix + "-feedback");
    feedback.className = "feedback correct";
    feedback.textContent = "🔒 Got it — nice job locking that in!";
    input.disabled = true;
    document.getElementById(prefix + "-continue").classList.remove("hidden");
    playSound("lockin");
    reactBuddy("correct");
    endRetype();
    return true;
  }

  // Restores the submit button to its normal label for whichever mode was
  // mid-retype. Called from showScreen() as well, so that bailing out through
  // the header Home button (which skips both exit handlers) can never leave a
  // "Lock It In" button waiting for the next session.
  function endRetype() {
    if (retype.prefix) {
      const submit = document.getElementById(retype.prefix + "-submit");
      if (submit) submit.textContent = "Check";
    }
    retype = { active: false, prefix: "", target: "" };
  }

  /* ---------------------------------------------------------------------
   * SMART REVIEW
   * Every other mode studies exactly one week. This one pulls the words the
   * student is actually weakest on out of EVERY week they have ever
   * practiced, so old material doesn't silently rot once the class moves on.
   *
   * The important structural difference: a review word belongs to another
   * week's progress doc, so stats must be written back to that word's own
   * doc, not to state.progress (which still points at the currently selected
   * week and must not be corrupted by review answers). reviewSession.docs
   * holds every touched doc by weekId and saves each one individually.
   * ------------------------------------------------------------------- */
  const REVIEW_MAX_WORDS = 15;
  let reviewSession = { queue: [], index: 0, streak: 0, docs: new Map() };

  // Loads every progress doc this profile has, keyed by weekId. Local only
  // on purpose: the progress index is written on every save, so anything
  // this device practiced is here, and a cross-device gap just means a
  // slightly smaller review pool rather than a wrong one.
  function loadAllProgressDocs(profileId) {
    const docs = new Map();
    load(progressIndexKey(profileId), []).forEach((weekId) => {
      const doc = load(progressKey(profileId, weekId), null);
      if (doc && Array.isArray(doc.words)) docs.set(weekId, doc);
    });
    return docs;
  }

  // Weakest-first: unmastered medals before mastered ones, then genuinely
  // low accuracy, then never-practiced. Never-practiced words sort as 0.5 so
  // they land behind demonstrated weaknesses but ahead of words the student
  // is merely okay at — reviewing a word you got 80% right is less valuable
  // than one you have never attempted, which in turn is less urgent than one
  // you keep getting wrong.
  function buildReviewQueue(profileId) {
    const docs = loadAllProgressDocs(profileId);
    const candidates = [];
    docs.forEach((doc, weekId) => {
      doc.words.forEach((w) => {
        // A progress doc written by an older build (or hand-edited/corrupted
        // localStorage) may lack the stat sub-objects wordMedal() indexes
        // into. Skip rather than throw — one bad word must not take down the
        // whole review queue, and this runs on every renderHome().
        if (!w || !w.spelling || !w.vocab) return;
        if (wordMedal(w) === "gold") return;
        const acc = wordAccuracy(w);
        candidates.push({
          word: w,
          weekId,
          weekLabel: doc.label || "",
          rank: MEDAL_RANK[wordMedal(w)],
          score: acc === null ? 0.5 : acc,
        });
      });
    });
    candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.score - b.score));
    return { queue: candidates.slice(0, REVIEW_MAX_WORDS), docs };
  }

  function reviewAvailableCount(profileId) {
    return buildReviewQueue(profileId).queue.length;
  }

  function openReview() {
    const { queue, docs } = buildReviewQueue(state.profile.id);
    if (!queue.length) {
      toast("Nothing to review yet — practice a week first!");
      return;
    }
    reviewSession = {
      queue: shuffle(queue), index: 0, streak: 0, docs, missedAny: false,
      starsThisSession: 0, medalUps: [], bestStreak: 0, wordSet: queue.map((q) => q.word),
    };
    document.getElementById("review-streak").classList.add("hidden");
    recordModeStart("review");
    renderReview();
    showScreen("review");
  }

  function renderReview() {
    const item = reviewSession.queue[reviewSession.index];
    document.getElementById("review-progress").textContent = `Word ${reviewSession.index + 1} of ${reviewSession.queue.length}`;
    document.getElementById("review-origin").textContent = item.weekLabel ? "from " + item.weekLabel : "";
    document.getElementById("review-input").value = "";
    document.getElementById("review-input").disabled = false;
    document.getElementById("review-feedback").classList.add("hidden");
    document.getElementById("review-continue").classList.add("hidden");
    document.getElementById("review-submit").classList.remove("hidden");
    speak(item.word.text);
    document.getElementById("review-input").focus();
  }

  attachMic(document.getElementById("review-mic"), document.getElementById("review-input"));
  document.getElementById("review-hear").addEventListener("click", () => {
    speak(reviewSession.queue[reviewSession.index].word.text);
  });

  function saveReviewDoc(weekId) {
    const doc = reviewSession.docs.get(weekId);
    if (!doc) return;
    saveProgress(state.profile.id, weekId, doc);
    // The reviewed word may belong to the week that is currently open on
    // Home. Its object identity is different (loaded from storage separately),
    // so refresh state.progress from the just-saved doc to keep Home's medal
    // counts honest instead of showing pre-review numbers.
    if (state.progress && state.progress.weekId === weekId) state.progress = doc;
  }

  document.getElementById("review-submit").addEventListener("click", () => {
    if (handleRetypeSubmit()) return;
    const item = reviewSession.queue[reviewSession.index];
    const answer = document.getElementById("review-input").value.trim();
    const correct = normalizeSpelling(answer) === normalizeSpelling(item.word.text);
    const result = recordAnswer(item.word, correct, "spelling", { streakStep: reviewSession.streak + 1 });
    trackSessionResult(reviewSession, item.word, result);
    const feedback = document.getElementById("review-feedback");
    if (correct) {
      reviewSession.streak++;
      reviewSession.bestStreak = Math.max(reviewSession.bestStreak || 0, reviewSession.streak);
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
      appendMedalNudge(feedback, item.word);
      handleHotStreak(reviewSession, true);
    } else {
      endStreak(reviewSession);
      reviewSession.missedAny = true;
      feedback.className = "feedback incorrect";
      feedback.innerHTML = `❌ Not quite. The word is:<span class="correct-answer">${escapeAttr(item.word.text)}</span><span class="retype-prompt">Now type it once to lock it in 🔒</span>`;
    }
    updateStreakBadge(document.getElementById("review-streak"), reviewSession.streak);
    feedback.classList.remove("hidden");
    if (correct) {
      document.getElementById("review-input").disabled = true;
      document.getElementById("review-submit").classList.add("hidden");
      document.getElementById("review-continue").classList.remove("hidden");
    } else {
      beginRetype("review", item.word.text);
    }
    saveReviewDoc(item.weekId);
  });

  document.getElementById("review-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !document.getElementById("review-submit").classList.contains("hidden")) {
      document.getElementById("review-submit").click();
    }
  });

  document.getElementById("review-continue").addEventListener("click", () => {
    reviewSession.index++;
    if (reviewSession.index >= reviewSession.queue.length) {
      // Smart Review previously got no completion reward at all — the most
      // pedagogically useful mode (weakest words, drawn across every week
      // ever practiced) was also the least celebrated. Same perfect-round
      // shape as the other modes (no misses, real-sized list), just built by
      // hand instead of through awardRoundCompletionBonus: reviewSession has
      // no round/retry — it's a single flat pass, not a two-round shape.
      if (!reviewSession.missedAny && reviewSession.queue.length >= 4) {
        const paid = awardCappedBonus(5, getOrInitActivity());
        toast(paid ? "🌟 Perfect round! +5 ⭐" : "🌟 Perfect round!");
        celebrate("big");
        playSound("perfect");
        reactBuddy("cheer");
      }
      flushActivity();
      showSessionWrapUp(reviewSession, {
        title: "Smart Review",
        showStars: true,
        wordSet: reviewSession.wordSet,
        replay: () => openReview(),
      });
    } else {
      renderReview();
    }
  });

  document.getElementById("review-exit").addEventListener("click", () => {
    flushActivity();
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * WEEK PICKER
   * ------------------------------------------------------------------- */
  function openWeekPicker() {
    const wrap = document.getElementById("week-picker-list");
    wrap.innerHTML = "";
    if (!state.catalogWeeks.length) {
      wrap.innerHTML = '<p class="hint">No weeks in the catalog yet. Add some from Manage Word Catalog.</p>';
    } else {
      const grades = Array.from(new Set(state.catalogWeeks.map((w) => w.grade))).sort();
      grades.forEach((g) => {
        const h = document.createElement("div");
        h.className = "week-picker-group-title";
        h.textContent = "Grade " + g;
        wrap.appendChild(h);
        state.catalogWeeks
          .filter((w) => w.grade === g)
          .sort((a, b) => a.weekNumber - b.weekNumber)
          .forEach((w) => {
            const btn = document.createElement("button");
            btn.className = "result-row clickable";
            btn.innerHTML = `<span>${escapeAttr(w.label)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${w.words.length} words</span>`;
            btn.addEventListener("click", () => selectWeek(w, true));
            wrap.appendChild(btn);
          });
      });
    }
    showScreen("week-picker");
  }
  document.getElementById("btn-change-week").addEventListener("click", openWeekPicker);
  document.getElementById("week-picker-exit").addEventListener("click", () => showScreen("home"));

  /* ---------------------------------------------------------------------
   * HOME SCREEN
   * ------------------------------------------------------------------- */
  // Dots reflect only THIS device's local activity cache, not a cross-device
  // merge — a kid who practices on two devices may see gaps here even on a
  // real streak. Accepted tradeoff at family scale (currentStreak itself is
  // still accurate, since that's synced on the profile doc); avoids an extra
  // Firestore read on every Home render for a cosmetic detail.
  function renderStreakBanner() {
    const banner = document.getElementById("home-streak-banner");
    if (!state.profile) { banner.classList.add("hidden"); return; }
    const streak = state.profile.currentStreak || 0;
    banner.classList.toggle("no-streak", streak === 0);
    document.getElementById("streak-banner-text").textContent =
      streak > 0 ? `🔥 ${streak}-day streak!` : "Practice today to start a streak!";

    const today = todayLocalStr();
    const dotsWrap = document.getElementById("streak-banner-dots");
    dotsWrap.innerHTML = "";
    weekDatesMonToSun(today).forEach((d) => {
      const activity = load(activityKey(state.profile.id, d), null);
      const dot = document.createElement("span");
      dot.className = "streak-dot";
      if (activity && activity.answers > 0) dot.classList.add("filled");
      if (d === today) dot.classList.add("today");
      dotsWrap.appendChild(dot);
    });
    banner.classList.remove("hidden");
  }

  function renderHome() {
    const summary = document.getElementById("home-medal-summary");
    const starterBtn = document.getElementById("btn-home-starter-lists");
    renderReviewBadge();
    if (!state.selectedWeek || !state.progress) {
      document.getElementById("home-week-label").textContent = "No word list yet";
      document.getElementById("home-word-count").textContent = "Load a ready-made list to start practicing right now.";
      summary.classList.add("hidden");
      document.getElementById("home-week-progress").classList.add("hidden");
      document.getElementById("home-gold-ring").classList.add("hidden");
      document.getElementById("home-streak-banner").classList.add("hidden");
      document.getElementById("home-daily-goal").classList.add("hidden");
      document.getElementById("home-recommend").classList.add("hidden");
      starterBtn.classList.remove("hidden");
      return;
    }
    starterBtn.classList.add("hidden");
    document.getElementById("home-week-label").textContent = state.selectedWeek.label;
    const n = state.progress.words.length;
    document.getElementById("home-word-count").textContent = n === 1 ? "1 word" : n + " words";

    const counts = { gold: 0, silver: 0, bronze: 0 };
    state.progress.words.forEach((w) => {
      const m = wordMedal(w);
      if (counts[m] !== undefined) counts[m]++;
    });
    if (counts.gold || counts.silver || counts.bronze) {
      summary.textContent = `🥇 ${counts.gold} · 🥈 ${counts.silver} · 🥉 ${counts.bronze}`;
      summary.classList.remove("hidden");
    } else {
      summary.classList.add("hidden");
    }

    // "Am I done with THIS WEEK" — the daily goal below answers the same
    // question at a one-day scale; medals-only was otherwise the only
    // week-scale signal, and a bare count isn't a target the way a bar is.
    const progressWrap = document.getElementById("home-week-progress");
    if (n > 0) {
      const silverPlus = counts.gold + counts.silver;
      const pct = Math.round((silverPlus / n) * 100);
      document.getElementById("week-progress-fill").style.width = pct + "%";
      document.getElementById("week-progress-label").textContent = `${silverPlus} of ${n} word${n === 1 ? "" : "s"} at Silver or better`;
      progressWrap.classList.remove("hidden");
    } else {
      progressWrap.classList.add("hidden");
    }

    // Mechanic 6 ("Gold the List") — a trophy already banked for this exact
    // week reads as a completed badge, not a live count creeping toward a
    // goal that's already been hit.
    const goldEl = document.getElementById("home-gold-ring");
    if (n > 0) {
      const trophyDate = (state.profile.weekTrophies || {})[state.progress.weekId];
      goldEl.textContent = trophyDate ? `🏆 All Gold — earned ${relativeDateLabel(trophyDate)}!` : `🥇 ${counts.gold} of ${n} Gold`;
      goldEl.classList.remove("hidden");
    } else {
      goldEl.classList.add("hidden");
    }

    renderStreakBanner();
    renderDailyGoal();
    renderHomeRecommendation();
  }

  // Smart Review works off past weeks, so it stays available (and shows how
  // many words are waiting) even when the current week is empty.
  function renderReviewBadge() {
    const badge = document.getElementById("review-count-badge");
    if (!badge) return;
    if (!state.profile || state.profile.role === "parent") { badge.classList.add("hidden"); return; }
    const n = reviewAvailableCount(state.profile.id);
    if (n > 0) {
      badge.textContent = n;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // Factored out of the tile grid's own click handler so the Home "start
  // here" recommendation (below) can send a kid into the same modes through
  // the same gate, instead of duplicating the word-list-required check.
  function navigateHomeTarget(target) {
    const noWordListNeeded = target === "progress" || target === "shop" || target === "review";
    if (!noWordListNeeded && (!state.progress || state.progress.words.length === 0)) {
      toast("Add some words first — try a starter list!");
      openStarterLists();
      return;
    }
    if (target === "word-list") openWordList();
    else if (target === "flashcard") openFlashcard();
    else if (target === "spelling") openSpelling(false);
    else if (target === "vocab") openVocabSetup();
    else if (target === "test-setup") showScreen("test-setup");
    else if (target === "speed-setup") showScreen("speed-setup");
    else if (target === "scramble") openScramble();
    else if (target === "review") openReview();
    else if (target === "progress") openProgress();
    else if (target === "shop") openShop();
  }

  document.querySelectorAll(".menu-card[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigateHomeTarget(btn.getAttribute("data-nav")));
  });

  // B3: one steer above the free-choice grid, not a gate — rules run in
  // priority order over data every mode already produces, so a kid who
  // doesn't know where to start on a 9-tile grid has one obvious first tap.
  let homeRecommendTarget = null;
  function renderHomeRecommendation() {
    const el = document.getElementById("home-recommend");
    homeRecommendTarget = null;
    if (!state.progress || !state.progress.words.length) { el.classList.add("hidden"); return; }
    const words = state.progress.words;
    const unpracticedCount = words.filter((w) => wordStatus(w) === "new").length;
    let text = null;
    if (unpracticedCount === words.length) {
      text = "Brand-new list — see what's coming up in This Week's Words.";
      homeRecommendTarget = "word-list";
    } else if (unpracticedCount / words.length >= 0.6) {
      text = "Most of this week's words are new — try Look & Say to hear them first.";
      homeRecommendTarget = "flashcard";
    } else if (words.filter((w) => { const m = wordMedal(w); return m === "none" || m === "bronze"; }).length / words.length >= 0.5) {
      text = "Quite a few of these could use more practice — try Spelling Practice.";
      homeRecommendTarget = "spelling";
    } else if (reviewAvailableCount(state.profile.id) > 0) {
      text = "You've got words waiting in Smart Review — a quick round would help.";
      homeRecommendTarget = "review";
    }
    document.getElementById("home-recommend-text").textContent = text || "";
    el.classList.toggle("hidden", !text);
  }
  document.getElementById("home-recommend").addEventListener("click", () => {
    if (homeRecommendTarget) navigateHomeTarget(homeRecommendTarget);
  });

  /* ---------------------------------------------------------------------
   * THIS WEEK'S WORDS — a clean reference sheet, not a progress view: every
   * word in the current week's catalog order (the order the teacher/parent
   * authored it in — the same order every study mode already trusts, not
   * alphabetical), with its definition when there is one. No stats, no
   * medals — a kid starting the week reaches for this, not Progress.
   * ------------------------------------------------------------------- */
  function openWordList() {
    renderWordList();
    showScreen("word-list");
  }

  function renderWordList() {
    document.getElementById("word-list-week-label").textContent = state.selectedWeek ? state.selectedWeek.label : "";
    const wrap = document.getElementById("word-list-rows");
    wrap.innerHTML = "";
    state.progress.words.forEach((w) => {
      const row = document.createElement("div");
      row.className = "word-list-row";
      // Empty definitions render nothing here, deliberately — same rule
      // wordsWithDefinition() documents for Look & Say, so a plain spelling
      // word never shows a "(no definition)" placeholder next to a real one.
      const def = w.definition && w.definition.trim()
        ? `<p class="word-list-row-def">${escapeAttr(w.definition)}</p>`
        : "";
      row.innerHTML = `<div class="word-list-row-main"><span class="word-list-row-word">${escapeAttr(w.text)}</span><button class="word-list-row-speak" title="Hear it">🔊</button></div>${def}`;
      row.querySelector(".word-list-row-speak").addEventListener("click", () => speak(w.text));
      wrap.appendChild(row);
    });
  }

  document.getElementById("word-list-hear-all").addEventListener("click", () => {
    // speak() calls speechSynthesis.cancel() before every utterance, so
    // calling it once per word in a loop would cut each word off as the next
    // one starts — one combined utterance with natural pause points (commas)
    // is simpler than teaching speak() to queue.
    if (!state.progress) return;
    speak(state.progress.words.map((w) => w.text).join(", "));
  });
  document.getElementById("word-list-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

  /* ---------------------------------------------------------------------
   * FLASHCARD (Look & Say) SESSION
   * ------------------------------------------------------------------- */
  let flash = { order: [], index: 0 };

  function openFlashcard() {
    flash.order = state.progress.words.slice();
    flash.index = 0;
    document.getElementById("flash-shuffle").checked = false;
    recordModeStart("flashcard");
    renderFlashcard();
    showScreen("flashcard");
  }

  function renderFlashcard() {
    const w = flash.order[flash.index];
    document.getElementById("flash-word").textContent = w.text;
    document.getElementById("flash-progress").textContent = `Card ${flash.index + 1} of ${flash.order.length}`;
    speak(w.text);
  }

  document.getElementById("flash-shuffle").addEventListener("change", (e) => {
    flash.order = e.target.checked ? shuffle(state.progress.words) : state.progress.words.slice();
    flash.index = 0;
    renderFlashcard();
  });
  document.getElementById("flash-hear").addEventListener("click", () => speak(flash.order[flash.index].text));
  document.getElementById("flash-next").addEventListener("click", () => {
    flash.index = (flash.index + 1) % flash.order.length;
    renderFlashcard();
  });
  document.getElementById("flash-prev").addEventListener("click", () => {
    flash.index = (flash.index - 1 + flash.order.length) % flash.order.length;
    renderFlashcard();
  });
  document.getElementById("flash-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

  /* ---------------------------------------------------------------------
   * SPELLING PRACTICE SESSION
   * ------------------------------------------------------------------- */
  let spell = { queue: [], retry: [], index: 0, round: 1, streak: 0, missedThisRound: false };

  // words: optional subset (e.g. "practice the ones I missed" from a results
  // screen) — falsy/empty falls back to the full current week, same as
  // before. The Home tile's own call site passes the literal `false` it
  // always has; that's harmless here since it's exactly what "no subset"
  // looks like.
  function openSpelling(words) {
    const list = Array.isArray(words) && words.length ? words : state.progress.words;
    spell = {
      queue: shuffle(list), retry: [], index: 0, round: 1, streak: 0, missedThisRound: false,
      starsThisSession: 0, medalUps: [], bestStreak: 0, wordSet: list,
      bonusWordId: (pickBonusWord(list) || {}).id || null, bonusWordAwarded: false,
    };
    document.getElementById("spell-streak").classList.add("hidden");
    recordModeStart("spelling");
    renderSpelling();
    showScreen("spelling");
  }

  function renderSpelling() {
    const w = spell.queue[spell.index];
    document.getElementById("spell-progress").textContent = `Word ${spell.index + 1} of ${spell.queue.length}${spell.round === 2 ? " (retry)" : ""}`;
    document.getElementById("spell-input").value = "";
    document.getElementById("spell-input").disabled = false;
    document.getElementById("spell-feedback").classList.add("hidden");
    document.getElementById("spell-continue").classList.add("hidden");
    document.getElementById("spell-submit").classList.remove("hidden");
    speak(w.text);
    document.getElementById("spell-input").focus();
  }

  attachMic(document.getElementById("spell-mic"), document.getElementById("spell-input"));
  document.getElementById("spell-hear").addEventListener("click", () => speak(spell.queue[spell.index].text));

  function updateStreakBadge(el, n) {
    if (n >= 3) { el.classList.remove("hidden"); el.textContent = "🔥 " + n; }
    else el.classList.add("hidden");
  }

  document.getElementById("spell-submit").addEventListener("click", () => {
    if (handleRetypeSubmit()) return;
    const w = spell.queue[spell.index];
    const answer = document.getElementById("spell-input").value.trim();
    const correct = normalizeSpelling(answer) === normalizeSpelling(w.text);
    const canPay = !offGradeWeek();
    const result = recordAnswer(w, correct, "spelling", { noStars: !canPay, streakStep: spell.streak + 1 });
    trackSessionResult(spell, w, result);
    const feedback = document.getElementById("spell-feedback");
    if (correct) {
      spell.streak++;
      spell.bestStreak = Math.max(spell.bestStreak || 0, spell.streak);
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
      appendMedalNudge(feedback, w);
      handleHotStreak(spell, canPay);
      checkBonusWord(spell, w, canPay);
    } else {
      endStreak(spell);
      spell.missedThisRound = true;
      if (spell.round === 1) spell.retry.push(w);
      feedback.className = "feedback incorrect";
      feedback.innerHTML = `❌ Not quite. The word is:<span class="correct-answer">${escapeAttr(w.text)}</span><span class="retype-prompt">Now type it once to lock it in 🔒</span>`;
    }
    updateStreakBadge(document.getElementById("spell-streak"), spell.streak);
    feedback.classList.remove("hidden");
    if (correct) {
      document.getElementById("spell-input").disabled = true;
      document.getElementById("spell-submit").classList.add("hidden");
      document.getElementById("spell-continue").classList.remove("hidden");
    } else {
      beginRetype("spell", w.text);
    }
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
  });

  document.getElementById("spell-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !document.getElementById("spell-submit").classList.contains("hidden")) {
      document.getElementById("spell-submit").click();
    }
  });

  document.getElementById("spell-continue").addEventListener("click", () => {
    spell.index++;
    if (spell.index >= spell.queue.length) {
      if (spell.round === 1 && spell.retry.length > 0) {
        spell.queue = shuffle(spell.retry);
        spell.retry = [];
        spell.index = 0;
        spell.round = 2;
        spell.missedThisRound = false;
        toast("Let's try those tricky ones again!");
        renderSpelling();
      } else {
        const canPay = !offGradeWeek();
        awardRoundCompletionBonus(spell, canPay);
        checkGoldTheList();
        flushActivity();
        showSessionWrapUp(spell, {
          title: "Spelling Practice",
          showStars: canPay,
          wordSet: spell.wordSet,
          extraNudge: bonusWordMissedNudge(spell, spell.wordSet),
          replay: () => openSpelling(spell.wordSet),
        });
      }
    } else {
      renderSpelling();
    }
  });

  document.getElementById("spell-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * VOCAB PRACTICE PICKER
   * The Home grid is a deliberate 9 tiles (a clean 3x3 at >=480px), so the
   * second vocab mode goes behind the existing tile rather than beside it —
   * the same tile -> pick-a-kind -> run shape Test Mode and Speed Quiz
   * already use, so it's a pattern the family has learned once already.
   * ------------------------------------------------------------------- */
  const VOCAB_MATCH_MIN_WORDS = 3;  // fewer than 3 definitions can't make a real multiple choice
  const VOCAB_MATCH_CHOICES = 4;

  function openVocabSetup() {
    const defined = wordsWithDefinition(state.progress);
    const empty = document.getElementById("vocab-setup-empty");
    const grid = document.getElementById("vocab-setup-grid");
    const note = document.getElementById("vocab-setup-match-note");
    if (!defined.length) {
      // The one-time explanation for a household whose current week has no
      // definitions — they used to get a Vocab session full of placeholder
      // text, which looked like a broken app rather than missing content.
      empty.textContent = "None of this week's words have a definition yet, so there's nothing to practice the meaning of. A grown-up can add them in Manage Word Catalog — put a comma and the meaning after the word, like: habit, something you do often";
      empty.classList.remove("hidden");
      grid.classList.add("hidden");
      note.classList.add("hidden");
    } else {
      empty.classList.add("hidden");
      grid.classList.remove("hidden");
      const matchCard = grid.querySelector('.menu-card[data-vocab-kind="match"]');
      const enoughForMatch = defined.length >= VOCAB_MATCH_MIN_WORDS;
      matchCard.disabled = !enoughForMatch;
      matchCard.classList.toggle("menu-card-disabled", !enoughForMatch);
      note.classList.toggle("hidden", enoughForMatch);
    }
    showScreen("vocab-setup");
  }

  document.querySelectorAll(".menu-card[data-vocab-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.getAttribute("data-vocab-kind") === "match") openVocabMatch();
      else openVocab();
    });
  });
  document.getElementById("vocab-setup-exit").addEventListener("click", () => showScreen("home"));

  /* ---------------------------------------------------------------------
   * VOCAB PRACTICE SESSION
   * ------------------------------------------------------------------- */
  let vocab = { queue: [], retry: [], index: 0, round: 1, streak: 0, missedThisRound: false };

  // subset: optional word list (e.g. missed vocab words from a results
  // screen) — already-real word objects, so no need to re-filter through
  // wordsWithDefinition() the way the normal full-week path does.
  function openVocab(subset) {
    const words = Array.isArray(subset) && subset.length ? subset : wordsWithDefinition(state.progress);
    // The picker already gates this, but a session with an empty queue would
    // crash renderVocab() on queue[0] — cheap guard, same shape as openReview().
    if (!words.length) { toast("No words with definitions in this week's list."); return; }
    vocab = { queue: shuffle(words), retry: [], index: 0, round: 1, streak: 0, missedThisRound: false, starsThisSession: 0, medalUps: [], bestStreak: 0, wordSet: words };
    document.getElementById("vocab-streak").classList.add("hidden");
    recordModeStart("vocab");
    renderVocab();
    showScreen("vocab");
  }

  function renderVocab() {
    const w = vocab.queue[vocab.index];
    document.getElementById("vocab-progress").textContent = `Word ${vocab.index + 1} of ${vocab.queue.length}${vocab.round === 2 ? " (retry)" : ""}`;
    document.getElementById("vocab-word").textContent = w.text;
    document.getElementById("vocab-definition").classList.add("hidden");
    document.getElementById("vocab-definition").textContent = w.definition;
    document.getElementById("vocab-reveal").classList.remove("hidden");
    document.getElementById("vocab-selfgrade").classList.add("hidden");
    speak(w.text);
  }

  document.getElementById("vocab-hear").addEventListener("click", () => speak(vocab.queue[vocab.index].text));
  document.getElementById("vocab-reveal").addEventListener("click", () => {
    document.getElementById("vocab-definition").classList.remove("hidden");
    document.getElementById("vocab-reveal").classList.add("hidden");
    document.getElementById("vocab-selfgrade").classList.remove("hidden");
  });

  function gradeVocab(knewIt) {
    const w = vocab.queue[vocab.index];
    // Self-graded ("I Knew It" is the child's own report, never checked) — see
    // recordAnswer's noStars doc comment. Still gets the streak pitch-rise
    // (pure feedback, not currency) but never the hot-streak bonus burst or a
    // Bonus Word reveal — see handleHotStreak/checkBonusWord's canPay guard.
    const result = recordAnswer(w, knewIt, "vocab", { noStars: true, streakStep: vocab.streak + 1 });
    trackSessionResult(vocab, w, result);
    if (knewIt) { vocab.streak++; vocab.bestStreak = Math.max(vocab.bestStreak || 0, vocab.streak); }
    else endStreak(vocab);
    if (!knewIt) { vocab.missedThisRound = true; if (vocab.round === 1) vocab.retry.push(w); }
    updateStreakBadge(document.getElementById("vocab-streak"), vocab.streak);
    saveProgress(state.profile.id, state.progress.weekId, state.progress);

    vocab.index++;
    if (vocab.index >= vocab.queue.length) {
      if (vocab.round === 1 && vocab.retry.length > 0) {
        vocab.queue = shuffle(vocab.retry);
        vocab.retry = [];
        vocab.index = 0;
        vocab.round = 2;
        vocab.missedThisRound = false;
        toast("Let's review those again!");
        renderVocab();
      } else {
        awardRoundCompletionBonus(vocab, false);
        flushActivity();
        showSessionWrapUp(vocab, {
          title: "Vocab Practice",
          showStars: false,
          wordSet: vocab.wordSet,
          replay: () => openVocab(vocab.wordSet),
        });
      }
    } else {
      renderVocab();
    }
  }
  document.getElementById("vocab-knew-it").addEventListener("click", () => gradeVocab(true));
  document.getElementById("vocab-missed").addEventListener("click", () => gradeVocab(false));
  document.getElementById("vocab-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * MATCH THE MEANING (word -> pick its definition)
   * Same session skeleton as Spelling/Scramble (queue + round-2 retry +
   * awardRoundCompletionBonus) and the same "vocab" stat bucket as Flip &
   * Rate, so medals and accuracy stay one coherent number per word rather
   * than splitting by which vocab mode produced the answer.
   * ------------------------------------------------------------------- */
  let vmatch = { queue: [], pool: [], retry: [], index: 0, round: 1, streak: 0, missedThisRound: false, choices: [], locked: false };

  // Distractors come from the whole week's defined words, never from the
  // current (possibly 2-word retry) queue, so round 2 still offers a real
  // choice. Definitions are de-duplicated case-insensitively: two words in one
  // list can legitimately share wording, and offering that text as a "wrong"
  // answer would mark a correct understanding wrong.
  function buildVocabMatchChoices(word, pool) {
    const target = word.definition.trim();
    const seen = new Set([target.toLowerCase()]);
    const distractors = [];
    shuffle(pool).forEach((w) => {
      if (distractors.length >= VOCAB_MATCH_CHOICES - 1) return;
      if (w.id === word.id) return;
      const d = (w.definition || "").trim();
      if (!d || seen.has(d.toLowerCase())) return;
      seen.add(d.toLowerCase());
      distractors.push(d);
    });
    return shuffle([target].concat(distractors));
  }

  // Fewer than 6 defined words this week means buildVocabMatchChoices (which
  // needs up to VOCAB_MATCH_CHOICES-1 = 3 distinct wrong definitions) draws
  // from the same tiny pool every round — the 3 distractors repeat and a kid
  // learns "the odd one out" instead of the actual meanings. Topped up from
  // OTHER weeks of the same grade: still real definitions the child has (or
  // will) study, just not this week's, so they read as plausible wrong
  // answers rather than obviously-unrelated filler.
  function extraDistractorPool(currentWeek) {
    if (!currentWeek || !Array.isArray(state.catalogWeeks)) return [];
    const extra = [];
    state.catalogWeeks
      .filter((wk) => wk.grade === currentWeek.grade && wk.id !== currentWeek.id)
      .forEach((wk) => (wk.words || []).forEach((w) => { if (w.definition && w.definition.trim()) extra.push(w); }));
    return extra;
  }

  function openVocabMatch() {
    const words = wordsWithDefinition(state.progress);
    if (words.length < VOCAB_MATCH_MIN_WORDS) { toast("Needs at least 3 words with definitions."); return; }
    let pool = words;
    if (words.length < 6) {
      const extra = extraDistractorPool(state.selectedWeek);
      if (extra.length) pool = words.concat(extra);
    }
    // queue stays THIS week's words only — pool (the distractor source) is
    // the only thing ever widened.
    vmatch = {
      queue: shuffle(words), pool, retry: [], index: 0, round: 1, streak: 0, missedThisRound: false, choices: [], locked: false,
      starsThisSession: 0, medalUps: [], bestStreak: 0, wordSet: words,
      bonusWordId: (pickBonusWord(words) || {}).id || null, bonusWordAwarded: false,
    };
    document.getElementById("vmatch-streak").classList.add("hidden");
    recordModeStart("vocabmatch");
    renderVocabMatch();
    showScreen("vocab-match");
  }

  function renderVocabMatch() {
    const w = vmatch.queue[vmatch.index];
    vmatch.locked = false;
    vmatch.choices = buildVocabMatchChoices(w, vmatch.pool);
    document.getElementById("vmatch-progress").textContent = `Word ${vmatch.index + 1} of ${vmatch.queue.length}${vmatch.round === 2 ? " (retry)" : ""}`;
    document.getElementById("vmatch-word").textContent = w.text;
    document.getElementById("vmatch-feedback").classList.add("hidden");
    document.getElementById("vmatch-continue").classList.add("hidden");
    const wrap = document.getElementById("vmatch-choices");
    wrap.innerHTML = "";
    vmatch.choices.forEach((text) => {
      const btn = document.createElement("button");
      btn.className = "vmatch-choice";
      btn.textContent = text;                       // textContent, so no escaping question at all
      btn.addEventListener("click", () => gradeVocabMatch(text));
      wrap.appendChild(btn);
    });
    speak(w.text);
  }

  document.getElementById("vmatch-hear").addEventListener("click", () => speak(vmatch.queue[vmatch.index].text));

  function gradeVocabMatch(chosen) {
    if (vmatch.locked) return;                      // a double-tap must not double-record an answer
    vmatch.locked = true;
    const w = vmatch.queue[vmatch.index];
    const target = w.definition.trim();
    const correct = chosen === target;
    const canPay = !offGradeWeek();
    const result = recordAnswer(w, correct, "vocab", { noStars: !canPay, streakStep: vmatch.streak + 1 });
    trackSessionResult(vmatch, w, result);
    Array.from(document.getElementById("vmatch-choices").children).forEach((btn) => {
      btn.disabled = true;
      if (btn.textContent === target) btn.classList.add("correct");
      else if (btn.textContent === chosen) btn.classList.add("wrong");
    });
    const feedback = document.getElementById("vmatch-feedback");
    if (correct) {
      vmatch.streak++;
      vmatch.bestStreak = Math.max(vmatch.bestStreak || 0, vmatch.streak);
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
      appendMedalNudge(feedback, w);
      handleHotStreak(vmatch, canPay);
      checkBonusWord(vmatch, w, canPay);
    } else {
      endStreak(vmatch);
      vmatch.missedThisRound = true;
      if (vmatch.round === 1) vmatch.retry.push(w);
      feedback.className = "feedback incorrect";
      feedback.textContent = "❌ Not quite — the green one is what it means.";
    }
    updateStreakBadge(document.getElementById("vmatch-streak"), vmatch.streak);
    feedback.classList.remove("hidden");
    document.getElementById("vmatch-continue").classList.remove("hidden");
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
  }

  document.getElementById("vmatch-continue").addEventListener("click", () => {
    vmatch.index++;
    if (vmatch.index >= vmatch.queue.length) {
      if (vmatch.round === 1 && vmatch.retry.length > 0) {
        vmatch.queue = shuffle(vmatch.retry);
        vmatch.retry = [];
        vmatch.index = 0;
        vmatch.round = 2;
        vmatch.missedThisRound = false;
        toast("Let's review those again!");
        renderVocabMatch();
      } else {
        const canPay = !offGradeWeek();
        awardRoundCompletionBonus(vmatch, canPay);
        checkGoldTheList();
        flushActivity();
        showSessionWrapUp(vmatch, {
          title: "Match the Meaning",
          showStars: canPay,
          wordSet: vmatch.wordSet,
          extraNudge: bonusWordMissedNudge(vmatch, vmatch.wordSet),
          replay: () => openVocabMatch(),
        });
      }
    } else {
      renderVocabMatch();
    }
  });

  document.getElementById("vmatch-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * TEST MODE
   * ------------------------------------------------------------------- */
  let test = { kind: "spelling", queue: [], index: 0, replaysLeft: 2, results: [] };

  document.querySelectorAll(".menu-card[data-test-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.progress || state.progress.words.length === 0) { toast("Add some words first!"); openCatalogEditor(); return; }
      test.kind = btn.getAttribute("data-test-kind");
      test.queue = shuffle(state.progress.words);
      test.index = 0;
      test.results = [];
      recordModeStart("test");
      renderTest();
      showScreen("test");
    });
  });
  document.getElementById("test-setup-exit").addEventListener("click", () => showScreen("home"));

  function renderTest() {
    const w = test.queue[test.index];
    test.replaysLeft = 2;
    document.getElementById("test-progress").textContent = `Word ${test.index + 1} of ${test.queue.length}`;
    const isSpelling = test.kind === "spelling";
    document.getElementById("test-spelling-ui").classList.toggle("hidden", !isSpelling);
    document.getElementById("test-vocab-ui").classList.toggle("hidden", isSpelling);
    document.getElementById("test-instruction").textContent = isSpelling
      ? "Listen, then spell the word. You won't see if you're right until the end."
      : "Think about what this word means, then rate yourself honestly.";
    document.getElementById("test-submit").classList.toggle("hidden", !isSpelling);
    if (isSpelling) {
      document.getElementById("test-input").value = "";
      document.getElementById("test-input").focus();
    } else {
      document.getElementById("test-vocab-word").textContent = w.text;
    }
    updateReplayLabel();
    speak(w.text);
  }

  function updateReplayLabel() {
    document.getElementById("test-replays").textContent = test.replaysLeft > 0 ? `🔊 ${test.replaysLeft} replay${test.replaysLeft === 1 ? "" : "s"} left` : "No replays left";
    document.getElementById("test-hear").disabled = test.replaysLeft <= 0;
  }

  attachMic(document.getElementById("test-mic"), document.getElementById("test-input"));
  document.getElementById("test-hear").addEventListener("click", () => {
    if (test.replaysLeft <= 0) return;
    test.replaysLeft--;
    updateReplayLabel();
    speak(test.queue[test.index].text);
  });

  function nextTestWord(record) {
    const w = test.queue[test.index];
    // Vocab Test is self-graded (an honest self-rating, never checked) —
    // Spelling Test is a real typed answer. Same off-grade gate as every
    // other mode either way.
    recordAnswer(w, record.correct, record.kind, { silent: true, noStars: record.kind === "vocab" || offGradeWeek() });
    test.results.push(record);
    saveProgress(state.profile.id, state.progress.weekId, state.progress);

    test.index++;
    if (test.index >= test.queue.length) {
      showTestResults();
    } else {
      renderTest();
    }
  }

  document.getElementById("test-submit").addEventListener("click", () => {
    const w = test.queue[test.index];
    const answer = document.getElementById("test-input").value.trim();
    const correct = normalizeSpelling(answer) === normalizeSpelling(w.text);
    nextTestWord({ kind: "spelling", word: w.text, given: answer, correct });
  });
  document.getElementById("test-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("test-submit").click();
  });
  document.getElementById("test-vocab-knew").addEventListener("click", () => {
    const w = test.queue[test.index];
    nextTestWord({ kind: "vocab", word: w.text, correct: true });
  });
  document.getElementById("test-vocab-missed").addEventListener("click", () => {
    const w = test.queue[test.index];
    nextTestWord({ kind: "vocab", word: w.text, correct: false });
  });
  document.getElementById("test-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  // Mechanic 7 ("Beat Your Best") — mode ("test" vs "speed") keeps a
  // swipe-graded Speed Quiz score from ever being compared against a real
  // typed/checked Test Mode one; different rigor, not interchangeable
  // numbers. Cap raised from 5 to 10 (was tuned for the parent dashboard's
  // history list alone) so a week of practice can't evict the actual best
  // score right before a kid gets to see it beaten.
  const RECENT_TESTS_MAX = 10;
  function recordTestResult(kind, mode, pct) {
    if (!state.profile || !state.progress) return;
    state.profile.recentTests = [
      { date: todayLocalStr(), kind, mode, pct, weekId: state.progress.weekId },
      ...(state.profile.recentTests || []),
    ].slice(0, RECENT_TESTS_MAX);
    persistProfile();
  }
  // The best PRIOR score for this exact week+kind+mode — call BEFORE
  // recordTestResult so the just-finished run doesn't count as its own
  // "prior" best. null (not 0) means "nothing to compare," so a first-ever
  // run shows no Best line rather than a misleading "Best: 0%".
  function bestPriorScore(weekId, kind, mode) {
    const entries = (state.profile && state.profile.recentTests) || [];
    const matches = entries.filter((t) => t.weekId === weekId && t.kind === kind && t.mode === mode);
    return matches.length ? Math.max(...matches.map((t) => t.pct)) : null;
  }

  function showTestResults() {
    let bestPrior = null;
    if (state.profile && state.progress) {
      const total = test.results.length;
      const right = test.results.filter((r) => r.correct).length;
      const pct = total ? Math.round((right / total) * 100) : 0;
      bestPrior = bestPriorScore(state.progress.weekId, test.kind, "test");
      recordTestResult(test.kind, "test", pct);
    }
    renderResultsScreen({
      title: "Test Results",
      kindLabel: (test.kind === "spelling" ? "Spelling" : "Vocab") + " Test",
      results: test.results,
      allowBonus: test.kind === "spelling" && !offGradeWeek(),
      bestPrior,
    });
  }

  // allowBonus: false whenever every result on this screen was self-graded
  // (Speed Quiz, always; Vocab Test, always) or off-grade — otherwise a
  // "perfect round" here is just a kid tapping the same self-report button
  // repeatedly, not a verified perfect score. See recordAnswer's noStars.
  let resultsMissedPractice = { words: [], isVocab: false };

  function renderResultsScreen({ title, kindLabel, results, allowBonus, bestPrior }) {
    const total = results.length;
    const right = results.filter((r) => r.correct).length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    document.getElementById("test-results-title").textContent = title;
    document.getElementById("test-score-circle").textContent = pct + "%";
    document.getElementById("test-score-text").textContent = `${right} of ${total} correct — ${kindLabel}`;

    // Mechanic 7: on a lower or tied score, show ONLY the existing best —
    // never the current (worse) number and never a down-arrow/delta. A
    // missing bestPrior (no comparable history yet, e.g. Speed Quiz's first
    // run on this week) hides the line entirely rather than claiming "Best: 0%".
    const bestEl = document.getElementById("test-results-best");
    if (bestPrior === null || bestPrior === undefined) {
      bestEl.classList.add("hidden");
    } else if (pct > bestPrior) {
      bestEl.textContent = `🎉 New best! ${bestPrior}% → ${pct}%`;
      bestEl.classList.remove("hidden");
    } else {
      bestEl.textContent = `Best: ${Math.max(bestPrior, pct)}%`;
      bestEl.classList.remove("hidden");
    }

    const list = document.getElementById("test-results-list");
    list.innerHTML = "";
    results.forEach((r) => {
      const row = document.createElement("div");
      row.className = "result-row";
      const icon = r.correct ? "✅" : "❌";
      const extra = !r.correct && r.given ? ` <span style="opacity:.6">(you wrote: ${escapeAttr(r.given)})</span>` : "";
      row.innerHTML = `<span>${icon} ${escapeAttr(r.word)}${extra}</span>`;
      list.appendChild(row);
    });

    // "Practice the ones I missed" — results only ever holds a word's TEXT
    // (`{word: w.text, ...}`), not the live word object, so map back into
    // state.progress.words (every queue here — Test Mode, Speed Quiz — is
    // sourced from it) to hand the practice modes real, current word data.
    // Vocab misses route to Flip & Rate and need a real definition to
    // practice against; a word with none just drops out of the subset rather
    // than blocking the whole button.
    const missedBtn = document.getElementById("test-results-practice-missed");
    const isVocabResults = results.length > 0 && results[0].kind === "vocab";
    let missedWords = results
      .filter((r) => !r.correct)
      .map((r) => state.progress.words.find((w) => w.text === r.word))
      .filter(Boolean);
    if (isVocabResults) missedWords = missedWords.filter((w) => w.definition && w.definition.trim());
    resultsMissedPractice = { words: missedWords, isVocab: isVocabResults };
    missedBtn.classList.toggle("hidden", missedWords.length === 0);

    const perfectRoundBonus = allowBonus && total >= 4 && right === total;
    if (perfectRoundBonus) {
      const paid = awardCappedBonus(5, getOrInitActivity());
      toast(paid ? "🌟 Perfect round! +5 ⭐" : "🌟 Perfect round!");
    } else if (pct === 100) toast("Perfect score! Amazing! 🌟");
    else if (pct >= 80) toast("Great job! Almost ready! ⭐");
    else toast("Good practice — a few more rounds will help.");

    if (pct >= 90) { celebrate("big"); playSound("perfect"); }

    flushActivity();
    showScreen("test-results");
    // Must run after showScreen(), not next to the celebrate() above: showScreen()
    // calls clearBuddy(), so a class added before it would be wiped immediately.
    if (pct >= 90) reactBuddy("cheer");
  }
  document.getElementById("test-results-done").addEventListener("click", () => { renderHome(); showScreen("home"); });
  document.getElementById("test-results-practice-missed").addEventListener("click", () => {
    const { words, isVocab } = resultsMissedPractice;
    if (!words.length) return;
    if (isVocab) openVocab(words); else openSpelling(words);
  });

  /* ---------------------------------------------------------------------
   * SPEED QUIZ (parent-led, swipe right = got it / swipe left = missed it)
   * ------------------------------------------------------------------- */
  let speed = { kind: "spelling", queue: [], index: 0, results: [], streak: 0, autoSpeak: true };

  document.querySelectorAll(".menu-card[data-speed-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!state.progress || state.progress.words.length === 0) { toast("Add some words first!"); openCatalogEditor(); return; }
      speed = {
        kind: btn.getAttribute("data-speed-kind"),
        queue: shuffle(state.progress.words),
        index: 0,
        results: [],
        streak: 0,
        autoSpeak: document.getElementById("speed-audio-toggle").checked,
      };
      document.getElementById("speed-streak").classList.add("hidden");
      recordModeStart("speed");
      renderSpeedCard();
      showScreen("speed");
    });
  });
  document.getElementById("speed-setup-exit").addEventListener("click", () => showScreen("home"));

  function renderSpeedCard() {
    const w = speed.queue[speed.index];
    const card = document.getElementById("speed-card");
    card.classList.remove("dragging");
    card.style.transition = "none";
    card.style.transform = "";
    card.style.opacity = 1;
    requestAnimationFrame(() => { card.style.transition = ""; });
    document.getElementById("speed-overlay-right").style.opacity = 0;
    document.getElementById("speed-overlay-left").style.opacity = 0;
    document.getElementById("speed-progress").textContent = `Word ${speed.index + 1} of ${speed.queue.length}`;
    document.getElementById("speed-word").textContent = w.text;
    if (speed.autoSpeak) speak(w.text);
  }

  document.getElementById("speed-hear").addEventListener("click", () => speak(speed.queue[speed.index].text));

  function commitSpeedAnswer(correct) {
    const w = speed.queue[speed.index];
    // Always self/adult-graded — a swipe, never a typed or checked answer —
    // for both kinds, so this is always noStars regardless of grade.
    recordAnswer(w, correct, speed.kind, { noStars: true });
    if (correct) speed.streak++; else speed.streak = 0;
    updateStreakBadge(document.getElementById("speed-streak"), speed.streak);
    speed.results.push({ kind: speed.kind, word: w.text, correct });
    saveProgress(state.profile.id, state.progress.weekId, state.progress);

    speed.index++;
    if (speed.index >= speed.queue.length) {
      const total = speed.results.length;
      const right = speed.results.filter((r) => r.correct).length;
      const pct = total ? Math.round((right / total) * 100) : 0;
      const bestPrior = state.progress ? bestPriorScore(state.progress.weekId, speed.kind, "speed") : null;
      recordTestResult(speed.kind, "speed", pct);
      renderResultsScreen({
        title: "Speed Quiz Results",
        kindLabel: (speed.kind === "spelling" ? "Spelling" : "Vocab") + " Speed Quiz",
        results: speed.results,
        allowBonus: false,
        bestPrior,
      });
    } else {
      renderSpeedCard();
    }
  }

  function resolveSpeedSwipe(direction) {
    const card = document.getElementById("speed-card");
    card.classList.remove("dragging");
    const flyX = direction === "right" ? 700 : -700;
    card.style.transition = "transform 0.25s ease, opacity 0.25s ease";
    card.style.transform = `translateX(${flyX}px) rotate(${flyX / 20}deg)`;
    card.style.opacity = 0;
    setTimeout(() => commitSpeedAnswer(direction === "right"), 220);
  }

  document.getElementById("speed-got-it").addEventListener("click", () => resolveSpeedSwipe("right"));
  document.getElementById("speed-missed").addEventListener("click", () => resolveSpeedSwipe("left"));
  document.getElementById("speed-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  (function setupSpeedDrag() {
    const card = document.getElementById("speed-card");
    const overlayRight = document.getElementById("speed-overlay-right");
    const overlayLeft = document.getElementById("speed-overlay-left");
    const threshold = 90;
    let dragging = false, startX = 0, deltaX = 0, pointerId = null;

    card.addEventListener("pointerdown", (e) => {
      dragging = true;
      startX = e.clientX;
      deltaX = 0;
      pointerId = e.pointerId;
      card.setPointerCapture(pointerId);
      card.classList.add("dragging");
    });
    card.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      deltaX = e.clientX - startX;
      card.style.transform = `translateX(${deltaX}px) rotate(${deltaX / 20}deg)`;
      const strength = Math.min(Math.abs(deltaX) / threshold, 1);
      overlayRight.style.opacity = deltaX > 0 ? strength : 0;
      overlayLeft.style.opacity = deltaX < 0 ? strength : 0;
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (deltaX > threshold) resolveSpeedSwipe("right");
      else if (deltaX < -threshold) resolveSpeedSwipe("left");
      else {
        card.classList.remove("dragging");
        card.style.transform = "";
        overlayRight.style.opacity = 0;
        overlayLeft.style.opacity = 0;
      }
    }
    card.addEventListener("pointerup", endDrag);
    card.addEventListener("pointercancel", endDrag);
  })();

  /* ---------------------------------------------------------------------
   * WORD SCRAMBLE (drag letter tiles into the right order)
   * ------------------------------------------------------------------- */
  let scramble = { queue: [], retry: [], index: 0, round: 1, streak: 0, bank: [], answer: [], locked: false, missedThisRound: false };

  // Multi-word or digit-bearing entries ("1 and 2 Samuel", "1 and 2 Kings") are
  // real shipped curriculum content, but shuffleLetters() below splits on
  // every character including spaces — producing a blank clickable tile with
  // nothing sensible to place there. Excluded from Scramble entirely rather
  // than given a smarter tile layout; every other mode still uses them fine.
  function scrambleSafeWords(words) {
    return words.filter((w) => !/[\d ]/.test(w.text));
  }

  function openScramble(subset) {
    const source = Array.isArray(subset) && subset.length ? subset : state.progress.words;
    const words = scrambleSafeWords(source);
    // The setup screens for Test/Speed already guard "no words at all"; this
    // is the one mode that can lose every word in a list to the filter above
    // (a week that's entirely Bible-book names, say) and needs its own check.
    if (!words.length) { toast("This week's words don't work with Word Scramble — try Spelling Practice instead."); return; }
    scramble = {
      queue: shuffle(words), retry: [], index: 0, round: 1, streak: 0, bank: [], answer: [], locked: false, missedThisRound: false,
      starsThisSession: 0, medalUps: [], bestStreak: 0, wordSet: words,
      bonusWordId: (pickBonusWord(words) || {}).id || null, bonusWordAwarded: false,
    };
    document.getElementById("scramble-streak").classList.add("hidden");
    recordModeStart("scramble");
    renderScrambleWord();
    showScreen("scramble");
  }

  function shuffleLetters(word) {
    const chars = word.split("").map((c, i) => ({ id: `t${i}`, char: c }));
    if (chars.length <= 1) return chars;
    let attempt = chars;
    for (let tries = 0; tries < 8; tries++) {
      attempt = shuffle(chars);
      if (attempt.map((t) => t.char).join("") !== word) break;
    }
    return attempt;
  }

  function renderScrambleWord() {
    const w = scramble.queue[scramble.index];
    document.getElementById("scramble-progress").textContent = `Word ${scramble.index + 1} of ${scramble.queue.length}${scramble.round === 2 ? " (retry)" : ""}`;
    scramble.bank = shuffleLetters(w.text.trim());
    scramble.answer = new Array(scramble.bank.length).fill(null);
    scramble.locked = false;
    document.getElementById("scramble-feedback").classList.add("hidden");
    document.getElementById("scramble-continue").classList.add("hidden");
    document.getElementById("scramble-submit").classList.add("hidden");
    renderScrambleTiles();
    speak(w.text);
  }

  function renderScrambleTiles() {
    const bankRow = document.getElementById("scramble-bank-row");
    const answerRow = document.getElementById("scramble-answer-row");
    bankRow.innerHTML = "";
    answerRow.innerHTML = "";

    scramble.answer.forEach((tileId, i) => {
      const slot = document.createElement("div");
      if (tileId) {
        const tile = scramble.bank.find((t) => t.id === tileId);
        slot.className = "scramble-tile filled";
        slot.textContent = tile.char.toUpperCase();
        slot.addEventListener("click", () => removeFromAnswer(i));
      } else {
        slot.className = "scramble-tile empty-slot";
      }
      answerRow.appendChild(slot);
    });

    scramble.bank.forEach((tile) => {
      if (scramble.answer.includes(tile.id)) return;
      const el = document.createElement("button");
      el.className = "scramble-tile bank-tile";
      el.textContent = tile.char.toUpperCase();
      attachTileDrag(el, tile.id);
      bankRow.appendChild(el);
    });
  }

  function placeInAnswer(tileId) {
    if (scramble.locked) return;
    const idx = scramble.answer.indexOf(null);
    if (idx === -1) return;
    scramble.answer[idx] = tileId;
    renderScrambleTiles();
    updateScrambleSubmitVisibility();
  }

  function removeFromAnswer(slotIndex) {
    if (scramble.locked) return;
    scramble.answer[slotIndex] = null;
    renderScrambleTiles();
    updateScrambleSubmitVisibility();
  }

  // Filling the last slot no longer auto-grades — kids (and their parents)
  // asked for a chance to double-check/fix a slip before it's scored. The
  // Submit button only appears once every slot is filled.
  function updateScrambleSubmitVisibility() {
    const canSubmit = !scramble.locked && !scramble.answer.includes(null);
    document.getElementById("scramble-submit").classList.toggle("hidden", !canSubmit);
  }

  // A tap and a drag both end in the same place: release the tile and it
  // drops into the next empty answer slot. The visual drag exists purely
  // for the tactile "move the letter with your finger" feel — there's no
  // pixel-precise drop-zone check, which keeps it forgiving for small
  // fingers and imprecise drops.
  function attachTileDrag(el, tileId) {
    let dragging = false, startX = 0, startY = 0, pointerId = null;
    el.addEventListener("pointerdown", (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      el.setPointerCapture(pointerId);
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      placeInAnswer(tileId);
    }
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  }

  function checkScrambleAnswer() {
    scramble.locked = true;
    document.getElementById("scramble-submit").classList.add("hidden");
    const w = scramble.queue[scramble.index];
    const assembled = scramble.answer.map((tileId) => scramble.bank.find((t) => t.id === tileId).char).join("");
    const correct = assembled.toLowerCase() === w.text.trim().toLowerCase();
    const canPay = !offGradeWeek();
    const result = recordAnswer(w, correct, "spelling", { noStars: !canPay, streakStep: scramble.streak + 1 });
    trackSessionResult(scramble, w, result);
    const feedback = document.getElementById("scramble-feedback");
    if (correct) {
      scramble.streak++;
      scramble.bestStreak = Math.max(scramble.bestStreak || 0, scramble.streak);
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
      appendMedalNudge(feedback, w);
      handleHotStreak(scramble, canPay);
      checkBonusWord(scramble, w, canPay);
    } else {
      endStreak(scramble);
      scramble.missedThisRound = true;
      if (scramble.round === 1) scramble.retry.push(w);
      feedback.className = "feedback incorrect";
      feedback.innerHTML = `❌ Not quite. The word is:<span class="correct-answer">${escapeAttr(w.text)}</span>`;
    }
    updateStreakBadge(document.getElementById("scramble-streak"), scramble.streak);
    feedback.classList.remove("hidden");
    document.getElementById("scramble-continue").classList.remove("hidden");
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
  }

  document.getElementById("scramble-hear").addEventListener("click", () => speak(scramble.queue[scramble.index].text));
  document.getElementById("scramble-submit").addEventListener("click", () => {
    if (scramble.locked || scramble.answer.includes(null)) return;
    checkScrambleAnswer();
  });
  document.getElementById("scramble-continue").addEventListener("click", () => {
    scramble.index++;
    if (scramble.index >= scramble.queue.length) {
      if (scramble.round === 1 && scramble.retry.length > 0) {
        scramble.queue = shuffle(scramble.retry);
        scramble.retry = [];
        scramble.index = 0;
        scramble.round = 2;
        scramble.missedThisRound = false;
        toast("Let's try those tricky ones again!");
        renderScrambleWord();
      } else {
        const canPay = !offGradeWeek();
        awardRoundCompletionBonus(scramble, canPay);
        checkGoldTheList();
        flushActivity();
        showSessionWrapUp(scramble, {
          title: "Word Scramble",
          showStars: canPay,
          wordSet: scramble.wordSet,
          extraNudge: bonusWordMissedNudge(scramble, scramble.wordSet),
          replay: () => openScramble(scramble.wordSet),
        });
      }
    } else {
      renderScrambleWord();
    }
  });
  document.getElementById("scramble-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    flushActivity();
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * PROGRESS SCREEN
   * ------------------------------------------------------------------- */
  function statusMeta(status) {
    if (status === "solid") return { label: "Looking good", cls: "status-solid" };
    if (status === "shaky") return { label: "Needs practice", cls: "status-shaky" };
    return { label: "Not practiced yet", cls: "status-new" };
  }

  async function openProgress() {
    const cur = document.getElementById("progress-current");
    cur.innerHTML = "";
    if (state.progress && state.progress.words.length) {
      state.progress.words.forEach((w) => {
        const meta = statusMeta(wordStatus(w));
        const icon = MEDAL_ICON[wordMedal(w)];
        const nudge = medalProgressText(w);
        const row = document.createElement("div");
        row.className = "result-row " + meta.cls;
        row.innerHTML = `<span>${icon} ${escapeAttr(w.text)}${nudge ? `<span class="progress-medal-nudge">${escapeAttr(nudge)}</span>` : ""}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${meta.label}</span>`;
        cur.appendChild(row);
      });
    } else {
      cur.innerHTML = '<p class="hint">No words yet this week.</p>';
    }

    const histWrap = document.getElementById("progress-history");
    histWrap.innerHTML = '<p class="hint">Loading…</p>';
    showScreen("progress");

    let others = [];
    if (firestoreReady()) {
      try { others = await Sync.fetchAllProgress(state.profile.id); } catch (e) { /* ignore */ }
    }
    if (!others.length) {
      const idx = load(progressIndexKey(state.profile.id), []);
      others = idx.map((wid) => load(progressKey(state.profile.id, wid), null)).filter(Boolean);
    }
    if (state.progress) others = others.filter((o) => o.weekId !== state.progress.weekId);

    histWrap.innerHTML = "";
    if (!others.length) {
      histWrap.innerHTML = '<p class="hint">No other weeks practiced yet.</p>';
      return;
    }
    others.sort((a, b) => (a.label || "").localeCompare(b.label || ""));
    others.forEach((o) => {
      let correct = 0, attempts = 0;
      (o.words || []).forEach((w) => { correct += w.spelling.correct + w.vocab.known; attempts += w.spelling.attempts + w.vocab.attempts; });
      const pct = attempts ? Math.round((correct / attempts) * 100) : 0;
      const btn = document.createElement("button");
      btn.className = "history-week result-row clickable";
      btn.innerHTML = `<div><div class="hw-title">${escapeAttr(o.label || o.weekId)}</div><div class="hw-meta">${(o.words || []).length} words · ${attempts ? pct + "% accuracy" : "not practiced"}</div></div>`;
      btn.addEventListener("click", () => {
        const wk = state.catalogWeeks.find((w) => w.id === o.weekId);
        if (wk) selectWeek(wk, true);
        else toast("That week isn't in the catalog anymore");
      });
      histWrap.appendChild(btn);
    });
  }
  document.getElementById("progress-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

  /* ---------------------------------------------------------------------
   * STAR SHOP (spend stars on avatars & themes)
   * ------------------------------------------------------------------- */
  function isUnlocked(profile, unlockId) {
    return (profile.unlocks || []).includes(unlockId);
  }

  // Which characters are active in the Star Shop and what they cost is a
  // parent-controlled, household-wide setting (see Manage Avatars below) —
  // deliberately separate from any one kid's profile so every profile in
  // the household sees the same storefront. ShopCatalog.CHARACTERS carries
  // only the defaults; this is the override layer on top of it.
  const SHOP_CONFIG_KEY = "ws_shop_config";

  function getShopConfigOverrides() {
    return load(SHOP_CONFIG_KEY, {});
  }

  function saveShopConfigOverrides(overrides) {
    save(SHOP_CONFIG_KEY, overrides);
    if (firestoreReady()) {
      Sync.saveShopConfig(overrides).catch((err) => {
        // The local write already succeeded and the checkbox already moved, so
        // failing silently here would leave the parent believing a store change
        // synced to the kids' devices when it never left this one.
        console.warn("[word-study] shop config sync failed", err);
        toast("Saved on this device — couldn't sync to other devices.");
      });
    }
  }

  // `active` and `price` fall back to the catalog default independently —
  // setting a custom price doesn't require also deciding active, and a
  // parent flipping active off and back on later doesn't lose a custom price.
  // The override blob is NOT trustworthy input, even though a parent is the
  // only one meant to write it: it round-trips through Firestore, where any
  // household member can write it directly with the SDK, bypassing the Manage
  // Avatars UI (and therefore its own Math.max(0, ...) clamp). A *negative*
  // price passes a bare `typeof === "number"` check and then turns
  // `p.stars -= price` in buyItem() into a star grant — so the range check
  // here is the load-bearing one, not the clamp in the UI.
  function sanitizePrice(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
  }

  function effectiveCharacter(item) {
    const o = getShopConfigOverrides()[item.id] || {};
    return Object.assign({}, item, {
      price: sanitizePrice(o.price, item.defaultPrice),
      active: typeof o.active === "boolean" ? o.active : item.defaultActive,
    });
  }

  function effectiveCharacters() {
    return ShopCatalog.CHARACTERS.map(effectiveCharacter);
  }

  function setCharacterOverride(id, patch) {
    const overrides = getShopConfigOverrides();
    overrides[id] = Object.assign({}, overrides[id], patch);
    saveShopConfigOverrides(overrides);
  }

  // Pulls the parent's latest config down from Firestore into the local
  // override cache, so a change made on the parent's device shows up here
  // the next time this device opens the shop or the dashboard. A plain
  // overwrite of a config cache, not live session state, so — unlike profile
  // sync — there's no mid-session/self-echo hazard to guard against here.
  async function refreshShopConfigFromCloud() {
    if (!firestoreReady()) return;
    try {
      const remote = await Sync.fetchShopConfig();
      if (remote) save(SHOP_CONFIG_KEY, remote);
    } catch (e) { /* ignore */ }
  }

  function openShop() {
    renderShop();
    showScreen("shop");
    // Render immediately from whatever's cached, then refresh from the
    // cloud and re-render if the parent changed something on another
    // device — same "render local-first, reconcile after" shape as the
    // rest of the app.
    refreshShopConfigFromCloud().then(() => {
      if (document.getElementById("screen-shop").classList.contains("active")) renderShop();
    });
  }

  // B5: the shop only ever shows a character at 92-108px, and unlockDates
  // (recorded on every purchase since 2026-08-28) has had nowhere to surface
  // at all — this is that home, plus the lifetime stats that were similarly
  // recorded but never shown anywhere on their own. Device-local, same
  // tradeoff as Smart Review's pool (loadAllProgressDocs): a fuller picture
  // on the device that's actually been used to practice, not a promise of
  // cross-device completeness.
  function openTrophyShelf() {
    const p = state.profile;
    const statsWrap = document.getElementById("trophy-stats");
    const medals = { gold: 0, silver: 0, bronze: 0 };
    loadAllProgressDocs(p.id).forEach((doc) => {
      (doc.words || []).forEach((w) => { const m = wordMedal(w); if (medals[m] !== undefined) medals[m]++; });
    });
    statsWrap.innerHTML = [
      { value: p.lifetimeStars || 0, label: "Lifetime Stars" },
      { value: p.bestStreak || 0, label: "Best Streak" },
      { value: medals.gold, label: "Gold Words" },
    ].map((s) => `<div class="trophy-stat"><div class="trophy-stat-value">${s.value}</div><div class="trophy-stat-label">${s.label}</div></div>`).join("");

    // Mechanic 6's collection view: each weekTrophies entry is a permanent
    // record of a fully-Gold week. weekId is looked up against whatever
    // catalog weeks are currently loaded for a readable label, falling back
    // to the raw id (a week from a catalog the family/class has since moved
    // off of) rather than hiding an earned trophy.
    const trophies = Object.entries(p.weekTrophies || {}).sort((a, b) => b[1].localeCompare(a[1]));
    const goldWeeksTitle = document.getElementById("trophy-gold-weeks-title");
    const goldWeeksWrap = document.getElementById("trophy-gold-weeks");
    goldWeeksTitle.classList.toggle("hidden", !trophies.length);
    goldWeeksWrap.innerHTML = trophies.map(([weekId, date]) => {
      const wk = (state.catalogWeeks || []).find((w) => w.id === weekId);
      return `<div class="result-row"><span>🏆 ${escapeAttr(wk ? wk.label : weekId)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${relativeDateLabel(date)}</span></div>`;
    }).join("");

    const grid = document.getElementById("trophy-characters");
    const earned = ShopCatalog.CHARACTERS
      .filter((item) => isUnlocked(p, "char:" + item.id))
      .map((item) => ({ item, date: (p.unlockDates || {})["char:" + item.id] || "" }))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (!earned.length) {
      grid.innerHTML = '<p class="trophy-empty">No characters earned yet — the Star Shop is full of them!</p>';
    } else {
      grid.innerHTML = earned.map(({ item, date }) => `
        <div class="trophy-card${item.tier === "chase" ? " legendary" : ""}">
          <span class="trophy-card-img"><img src="assets/avatars/${item.id}.webp" alt="${escapeAttr(item.label)}"></span>
          <span class="trophy-card-label">${escapeAttr(item.label)}</span>
          <span class="trophy-card-date">${date ? "earned " + relativeDateLabel(date) : ""}</span>
        </div>`).join("");
    }
    showScreen("trophy-shelf");
  }
  document.getElementById("btn-open-trophy-shelf").addEventListener("click", openTrophyShelf);
  document.getElementById("trophy-shelf-exit").addEventListener("click", () => showScreen("shop"));

  // Renders one item card in one of four states: equipped (disabled, ring),
  // owned-not-equipped (click to equip), affordable (click to buy), or
  // locked/too-expensive (dimmed, disabled — spec's "too expensive" state
  // has no action, so it deliberately gets no click listener at all, not a
  // disabled one — a disabled button never fires click events anyway).
  function renderShopItem(wrap, { html, legendary, owned, equipped, price, onEquip, onBuy }) {
    const stars = state.profile.stars || 0;
    const affordable = !owned && stars >= price;
    const cls = ["shop-item"];
    if (equipped) cls.push("equipped");
    else if (owned) cls.push("owned");
    else cls.push("locked");
    if (legendary) cls.push("legendary");
    const btn = document.createElement("button");
    btn.className = cls.join(" ");
    const priceLabel = equipped ? "✓ Equipped" : owned ? "Equip" : price + " ⭐";
    btn.innerHTML = `${html}<span class="shop-item-price">${priceLabel}</span>`;
    if (equipped) {
      btn.disabled = true;
    } else if (owned) {
      btn.addEventListener("click", onEquip);
    } else if (affordable) {
      btn.addEventListener("click", onBuy);
    } else {
      btn.disabled = true;
    }
    wrap.appendChild(btn);
  }

  function renderCharacterCard(wrap, item) {
    const p = state.profile;
    const owned = item.price === 0 || isUnlocked(p, "char:" + item.id);
    renderShopItem(wrap, {
      html: `<span class="shop-item-char"><img src="assets/avatars/${item.id}.webp" alt="${escapeAttr(item.label)}"></span>` +
            `<span class="shop-item-label">${escapeAttr(item.label)}</span>`,
      legendary: item.tier === "chase",
      owned,
      equipped: avatarFor(p) === avatarValue(item),
      price: item.price,
      onEquip: () => equipAvatar(item),
      onBuy: () => requestBuyItem("char", item),
    });
  }

  function renderShop() {
    const p = state.profile;
    document.getElementById("shop-lifetime").textContent = `All-time: ${p.lifetimeStars || 0} ⭐`;

    const active = effectiveCharacters().filter((c) => c.active);
    const chaseItems = active.filter((c) => c.tier === "chase");
    const standardItems = active.filter((c) => c.tier !== "chase");

    document.getElementById("shop-chase-section").classList.toggle("hidden", chaseItems.length === 0);
    const chaseWrap = document.getElementById("shop-chase");
    chaseWrap.innerHTML = "";
    chaseItems.forEach((item) => renderCharacterCard(chaseWrap, item));

    const charWrap = document.getElementById("shop-characters");
    charWrap.innerHTML = "";
    standardItems.forEach((item) => renderCharacterCard(charWrap, item));

    const avatarWrap = document.getElementById("shop-avatars");
    avatarWrap.innerHTML = "";
    ShopCatalog.AVATARS.forEach((item) => {
      const owned = item.price === 0 || isUnlocked(p, "avatar:" + item.id);
      renderShopItem(avatarWrap, {
        html: `<span class="shop-item-emoji">${item.emoji}</span>`,
        legendary: item.legendary,
        owned,
        equipped: avatarFor(p) === avatarValue(item),
        price: item.price,
        onEquip: () => equipAvatar(item),
        onBuy: () => requestBuyItem("avatar", item),
      });
    });

    const themeWrap = document.getElementById("shop-themes");
    themeWrap.innerHTML = "";
    renderShopItem(themeWrap, {
      html: `<span class="shop-item-swatch" style="background:#4338ca"></span>`,
      owned: true,
      equipped: !p.equippedTheme,
      price: 0,
      onEquip: () => equipTheme(null),
    });
    ShopCatalog.THEMES.forEach((item) => {
      const owned = isUnlocked(p, "theme:" + item.id);
      const equipped = p.equippedTheme === item.id;
      renderShopItem(themeWrap, {
        html: `<span class="shop-item-swatch" style="background:${item.swatch}"></span>`,
        owned,
        equipped,
        price: item.price,
        onEquip: () => equipTheme(item),
        onBuy: () => requestBuyItem("theme", item),
      });
    });
  }

  // What actually gets stored in `equippedAvatar`: emoji items store the emoji
  // character itself (unchanged from the original shop, so existing profiles
  // need no migration), character items store "char:<id>".
  function avatarValue(item) {
    return item.emoji || "char:" + item.id;
  }

  // Emoji and character avatars live in separate unlock namespaces so an id
  // reused across the two catalogs can never gift the other one for free.
  function unlockIdFor(item) {
    return (item.emoji ? "avatar:" : "char:") + item.id;
  }

  function equipAvatar(item) {
    const p = state.profile;
    if (item.price > 0 && !isUnlocked(p, unlockIdFor(item))) return;
    const value = avatarValue(item);
    if (avatarFor(p) === value) return;
    p.equippedAvatar = value;
    persistProfile();
    refreshHeader();
    renderShop();
  }

  function equipTheme(item) {
    const p = state.profile;
    if (item && !isUnlocked(p, "theme:" + item.id)) return;
    const themeId = item ? item.id : "";
    if ((p.equippedTheme || "") === themeId) return;
    p.equippedTheme = themeId;
    persistProfile();
    applyTheme(themeId);
    renderShop();
  }

  // D1: a native confirm() inside an installed, standalone PWA looks like a
  // browser chrome error, not part of the app — pendingBuy holds what
  // requestBuyItem below is asking the child to confirm, and buyItem is now
  // only ever called after that in-app "Yes, buy it" tap.
  let pendingBuy = null;

  function requestBuyItem(kind, item) {
    const p = state.profile;
    const unlockId = kind + ":" + item.id;
    if (isUnlocked(p, unlockId)) return;
    const price = sanitizePrice(item.price, 0);
    if ((p.stars || 0) < price) return;
    const label = kind === "avatar" ? item.emoji : item.label;
    pendingBuy = { kind, item };
    document.getElementById("shop-buy-confirm-label").textContent = label;
    document.getElementById("shop-buy-confirm-price").textContent = price;
    document.getElementById("shop-buy-confirm").classList.remove("hidden");
  }
  document.getElementById("btn-shop-buy-confirm-cancel").addEventListener("click", () => {
    pendingBuy = null;
    document.getElementById("shop-buy-confirm").classList.add("hidden");
  });
  document.getElementById("btn-shop-buy-confirm-yes").addEventListener("click", () => {
    const pending = pendingBuy;
    pendingBuy = null;
    document.getElementById("shop-buy-confirm").classList.add("hidden");
    if (pending) buyItem(pending.kind, pending.item);
  });

  // Two devices spending the same balance simultaneously can double-spend —
  // accepted tradeoff at family scale, resolved last-write-wins via the
  // existing profile sync. Not building conflict-resolution machinery for it.
  // Called only from the "Yes, buy it" handler above — requestBuyItem() owns
  // every guard (already owned, can't afford) up front, and re-checks them
  // here too in case shop state changed while the confirm box was open.
  function buyItem(kind, item) {
    const p = state.profile;
    const unlockId = kind + ":" + item.id;
    if (isUnlocked(p, unlockId)) return;
    // Second line of defence behind sanitizePrice(): a spend must never be
    // able to *increase* the balance, whatever the caller handed us.
    const price = sanitizePrice(item.price, 0);
    if ((p.stars || 0) < price) return;
    const label = kind === "avatar" ? item.emoji : item.label;
    p.stars -= price;
    p.unlocks = p.unlocks || [];
    p.unlocks.push(unlockId);
    // Purely additive, never a migration: existing unlocks simply have no
    // entry here and that's fine everywhere this is read. Captured now,
    // while it's free, for whenever a "your collection over time" view gets
    // built later — the data is worthless in hindsight if not recorded when
    // the purchase actually happens. Local-calendar date, not toISOString()
    // (see the known bug pattern in docs/HANDOFF.md).
    p.unlockDates = p.unlockDates || {};
    p.unlockDates[unlockId] = todayLocalStr();
    if (kind === "avatar" || kind === "char") p.equippedAvatar = avatarValue(item);
    else p.equippedTheme = item.id;
    persistProfile();
    refreshHeader();
    if (kind === "theme") applyTheme(item.id);
    celebrate("small");
    playSound("purchase");
    reactBuddy("cheer");
    toast(`Bought ${label}! 🎉`);
    renderShop();
  }

  document.getElementById("shop-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

  /* ---------------------------------------------------------------------
   * MANAGE AVATARS (parent-only — which characters are in the Star Shop
   * right now, and what they cost). Reached only from the Parent Dashboard,
   * so it inherits that screen's PIN gate rather than needing its own.
   * ------------------------------------------------------------------- */
  function renderManageAvatarCard(item) {
    const card = document.createElement("div");
    card.className = "manage-avatar-card" + (item.tier === "chase" ? " chase" : "");
    card.innerHTML = `
      <span class="manage-avatar-thumb"><img src="assets/avatars/${item.id}.webp" alt="${escapeAttr(item.label)}"></span>
      <span class="manage-avatar-label">${escapeAttr(item.label)}</span>
      <label class="manage-avatar-active">
        <input type="checkbox"${item.active ? " checked" : ""}> In Store
      </label>
      <label class="manage-avatar-price">
        <input type="number" min="0" step="5" value="${item.price}" inputmode="numeric"> ⭐
      </label>`;
    const checkbox = card.querySelector('input[type="checkbox"]');
    const priceInput = card.querySelector('input[type="number"]');
    checkbox.addEventListener("change", () => {
      setCharacterOverride(item.id, { active: checkbox.checked });
    });
    priceInput.addEventListener("change", () => {
      const v = Math.max(0, parseInt(priceInput.value, 10) || 0);
      priceInput.value = v;
      setCharacterOverride(item.id, { price: v });
    });
    return card;
  }

  function renderManageAvatars() {
    const chaseWrap = document.getElementById("manage-chase");
    const stdWrap = document.getElementById("manage-standard");
    chaseWrap.innerHTML = "";
    stdWrap.innerHTML = "";
    effectiveCharacters().forEach((item) => {
      const card = renderManageAvatarCard(item);
      (item.tier === "chase" ? chaseWrap : stdWrap).appendChild(card);
    });
  }

  function openManageAvatars() {
    renderManageAvatars();
    showScreen("manage-avatars");
    refreshShopConfigFromCloud().then(() => {
      if (document.getElementById("screen-manage-avatars").classList.contains("active")) renderManageAvatars();
    });
  }

  document.getElementById("parent-dash-manage-avatars").addEventListener("click", openManageAvatars);
  document.getElementById("manage-avatars-exit").addEventListener("click", () => { openParentDashboard(); });

  /* ---------------------------------------------------------------------
   * HOUSEHOLD (cross-device sync) SCREEN
   * ------------------------------------------------------------------- */
  const SYNC_SKIP_KEY = "ws_sync_skipped";

  function enterApp() {
    const profiles = getProfiles();
    renderProfiles();
    const activeId = getActiveProfileId();
    const activeProfile = activeId && profiles.find((p) => p.id === activeId);
    // Parents are never auto-resumed — they re-enter their PIN every visit.
    if (activeProfile && activeProfile.role !== "parent") {
      selectProfile(activeId);
    } else {
      showScreen("profiles");
      watchProfilesList();
    }
  }

  // Creating a household doesn't connect+enter immediately — it drops the new
  // code into the same password-type join field below and asks for one more
  // tap. That extra tap is a real form submission with a filled password
  // field, which is what gets the browser/iCloud Keychain to offer to save
  // it — durable storage that survives Safari wiping this site's localStorage
  // (the actual cause of "forgot the code" lockouts), unlike a toast alone.
  document.getElementById("btn-create-household").addEventListener("click", async () => {
    const btn = document.getElementById("btn-create-household");
    btn.disabled = true;
    try {
      const code = await Sync.createHousehold();
      const input = document.getElementById("join-household-code");
      input.value = code;
      input.type = "text";
      document.getElementById("household-code-hint").style.display = "";
      document.getElementById("btn-toggle-household-code").setAttribute("aria-label", "Hide code");
      toast(`Household created! Code: ${code}`);
      // A teacher creating a class needs the code/QR/invite-link at the exact
      // moment they most need it, not buried behind navigation
      // (docs/school-scale-plan.md §1.2). openClassInfo() sends "Back" to
      // this same screen so the join-tap password-save flow below still works.
      openClassInfo();
    } catch (e) {
      toast("Couldn't connect — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("join-household-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("join-household-code");
    const code = input.value.trim();
    if (!code) { toast("Enter a code first"); return; }
    // Force real password-field state at the moment of submission (it may
    // have been toggled to "text" for visibility) — browsers key their
    // save-password offer off the field being type="password" when the
    // form submits, not just its autocomplete attribute.
    input.type = "password";
    const btn = document.getElementById("btn-join-household");
    btn.disabled = true;
    try {
      const ok = await Sync.joinHousehold(code);
      if (ok) { toast("Connected!"); enterApp(); }
      else toast("That code wasn't found — check it and try again.");
    } catch (e) {
      toast("Couldn't connect — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-toggle-household-code").addEventListener("click", () => {
    const input = document.getElementById("join-household-code");
    const btn = document.getElementById("btn-toggle-household-code");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.setAttribute("aria-label", showing ? "Show code" : "Hide code");
  });

  document.getElementById("btn-skip-household").addEventListener("click", () => {
    localStorage.setItem(SYNC_SKIP_KEY, "1");
    enterApp();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushActivity();
  });

  // Pre-fills the matching field from an invite link (?household=CODE or
  // ?catalog=CODE) — the input nodes persist for the app's whole lifetime
  // (screens are just hidden/shown), so setting the value once here is
  // enough regardless of when the user actually reaches that screen.
  (function consumeInviteLinkParams() {
    const params = new URLSearchParams(location.search);
    const householdInvite = params.get("household");
    const catalogInvite = params.get("catalog");
    if (householdInvite) {
      const el = document.getElementById("join-household-code");
      if (el) el.value = householdInvite.toUpperCase();
    }
    if (catalogInvite) {
      const el = document.getElementById("catalog-code-input");
      if (el) el.value = catalogInvite;
    }
    if (householdInvite || catalogInvite) {
      history.replaceState(null, "", location.pathname);
    }
  })();

  /* ---------------------------------------------------------------------
   * INIT
   * ------------------------------------------------------------------- */
  function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
    refreshMuteButton();

    const hasHousehold = typeof Sync !== "undefined" && Sync.getHouseholdCode();
    const skipped = localStorage.getItem(SYNC_SKIP_KEY);
    if (hasHousehold || skipped || typeof Sync === "undefined") {
      if (hasHousehold) watchProfilesList();
      enterApp();
    } else {
      showScreen("household");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
