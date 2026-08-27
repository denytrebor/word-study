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
    if (firestoreReady()) Sync.pushProgress(profileId, weekId, progress);
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
    document.getElementById("header-stars").textContent = "⭐ " + (state.profile.stars || 0);
  }

  function persistProfile() {
    if (!state.profile) return;
    const profiles = getProfiles();
    const idx = profiles.findIndex((p) => p.id === state.profile.id);
    if (idx !== -1) profiles[idx] = state.profile;
    saveProfiles(profiles);
    if (firestoreReady()) Sync.pushProfile(state.profile);
  }

  // `stars` is the spendable balance (shop purchases decrement it);
  // `lifetimeStars` is monotonically increasing, so future levels/badges
  // never conflict with what's been spent.
  function addStars(n) {
    state.profile.stars = (state.profile.stars || 0) + n;
    state.profile.lifetimeStars = (state.profile.lifetimeStars || 0) + n;
    persistProfile();
    refreshHeader();
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

  // kind: "correct" | "medal" | "purchase" | "streak" | "perfect" —
  // a subtle single tone for plain correct answers, a two-note ascending
  // chime for medal/purchase moments, a brighter three-note arpeggio for
  // the big streak/perfect moments.
  function playSound(kind) {
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
      tone(660, 0, 0.12, 0.12);
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

  function flushActivity() {
    if (!state.activity || !state.profile) return;
    save(activityKey(state.profile.id, state.activity.date), state.activity);
    if (firestoreReady()) Sync.pushActivity(state.profile.id, state.activity.date, state.activity);
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
  function ensureStreakForToday() {
    const p = state.profile;
    const today = todayLocalStr();
    if (p.lastActiveDate === today) return;
    const yesterday = localDateMinusDays(today, 1);
    const newStreak = p.lastActiveDate === yesterday ? (p.currentStreak || 0) + 1 : 1;
    p.currentStreak = newStreak;
    p.bestStreak = Math.max(p.bestStreak || 0, newStreak);
    p.lastActiveDate = today;
    const bonus = STREAK_MILESTONES[newStreak];
    if (bonus) {
      addStars(bonus);
      toast(`🔥 ${newStreak}-day streak! +${bonus} ⭐`);
      celebrate("big");
      playSound("streak");
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
  function recordAnswer(w, correct, statKind, opts) {
    const silent = !!(opts && opts.silent);
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

    const activity = getOrInitActivity();
    const isFirstAnswerToday = activity.answers === 0;
    activity.answers++;
    if (correct) activity.correct++;

    let starsAwarded = 0;
    if (correct) {
      starsAwarded = starsForCorrectAnswer(w, wasGoldBefore, activity);
      if (starsAwarded > 0) {
        addStars(starsAwarded);
        activity.starsEarned += starsAwarded;
        activity.starEarns[w.id] = (activity.starEarns[w.id] || 0) + starsAwarded;
      }
      if (!silent) playSound("correct");
    }

    const medalUp = MEDAL_RANK[afterMedal] > MEDAL_RANK[beforeMedal];
    if (medalUp && !silent) {
      const label = afterMedal.charAt(0).toUpperCase() + afterMedal.slice(1);
      toast(`${MEDAL_ICON[afterMedal]} "${w.text}" leveled up to ${label}!`);
      celebrate("small");
      playSound("medal");
    }

    if (isFirstAnswerToday) {
      ensureStreakForToday();
      addStars(3);
      toast("🌞 First practice today! +3 ⭐");
    }

    checkDailyGoal(activity);

    if (activity.answers % 10 === 0) flushActivity();

    return { starsAwarded, medalUp };
  }

  // Shared by Spelling/Vocab/Scramble, which all use a {queue, retry, round,
  // missedThisRound} session shape: rewards a clean round 1 (no misses, real-
  // sized list) or a fully-cleared retry round. missedThisRound (NOT
  // retry.length — that array is only ever populated during round 1, so it's
  // always empty by the time round 2 finishes regardless of how round 2 went)
  // is what actually proves the round just completed had zero misses.
  // Returns whether a bonus fired so the caller can skip its own "complete"
  // toast in favor of this louder one.
  function awardRoundCompletionBonus(session) {
    if (session.round === 1 && !session.missedThisRound && session.queue.length >= 4) {
      addStars(5);
      toast("🌟 Perfect round! +5 ⭐");
      celebrate("big");
      playSound("perfect");
      return true;
    }
    if (session.round === 2 && !session.missedThisRound) {
      addStars(2);
      toast("💪 Cleared the retries! +2 ⭐");
      celebrate("small");
      playSound("perfect");
      return true;
    }
    return false;
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
    if (firestoreReady()) Sync.watchProfile(id, applyRemoteProfileUpdate);
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
    const dates = weekDatesMonToSun(today);
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
    vocab: "💡 Vocab Practice",
    test: "🎯 Test Mode",
    speed: "⚡ Speed Quiz",
    scramble: "🔤 Word Scramble",
    review: "🧠 Smart Review",
  };

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

    const dotsHtml = dates.map((d) => {
      const filled = activityByDate[d] && activityByDate[d].answers > 0;
      const cls = ["psc-dot"];
      if (filled) cls.push("filled");
      if (d === today) cls.push("today");
      return `<span class="${cls.join(" ")}"></span>`;
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
      ? modeBreakdown.map(([mode, n]) => `<div class="psc-tests-row"><span>${MODE_LABELS[mode] || escapeAttr(mode)}</span><span>${n}×</span></div>`).join("")
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
        </div>

        <p class="psc-usage-line">Last practiced: <strong>${relativeDateLabel(student.lastActiveDate)}</strong></p>
        <div class="psc-dots">${dotsHtml}</div>
        <p class="psc-usage-line">${weekAnswers} answers this week${weekAccuracy !== null ? " · " + weekAccuracy + "% accuracy" : ""}</p>

        <p class="psc-section-title">This week's practice</p>
        <div>${modeHtml}</div>

        <p class="psc-section-title">${week ? escapeAttr(week.label) : "No word list"}</p>
        ${week ? `<p class="psc-usage-line">🥇 ${medalCounts.gold} · 🥈 ${medalCounts.silver} · 🥉 ${medalCounts.bronze} · ⚪ ${medalCounts.none}</p>` : ""}
        <p class="psc-section-title">Needs work</p>
        <div class="psc-needs-work">${needsWorkHtml}</div>

        <p class="psc-section-title">Recent tests</p>
        <div>${testsHtml}</div>
      </div>`;
  }

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
    wrap.innerHTML = results.map(renderStudentCard).join("");
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

  async function selectWeek(week, manual) {
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
    if (savedWeekId) week = state.catalogWeeks.find((w) => w.id === savedWeekId);
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
    let block = [];

    function flushBlock() {
      if (block.length === 0) return;
      weekNum++;
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
        start.setDate(start.getDate() + (weekNum - 1) * 7);
        const dateStr = dateToLocalStr(start);
        weeks.push({
          id: `${slugify(currentGrade)}-w${weekNum}`,
          grade: currentGrade,
          weekNumber: weekNum,
          weekStartDate: dateStr,
          label: `Grade ${currentGrade} · Week ${weekNum}`,
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

  let catalogParsePreview = [];

  async function openCatalogEditor() {
    const code = getCatalogCode();
    document.getElementById("catalog-code-display").textContent = code === LOCAL_CATALOG ? "(this device only)" : code;
    document.getElementById("catalog-paste-input").value = "";
    document.getElementById("catalog-preview").classList.add("hidden");
    document.getElementById("btn-save-catalog").classList.add("hidden");
    document.getElementById("btn-copy-catalog-link").classList.toggle("hidden", code === LOCAL_CATALOG);
    showScreen("catalog-editor");

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
    const note = document.getElementById("catalog-readonly-note");
    const form = document.getElementById("catalog-editor-form");
    note.classList.add("hidden");
    form.classList.remove("hidden");
    if (code !== LOCAL_CATALOG && firestoreReady()) {
      try {
        const meta = await Sync.fetchCatalogMeta(code);
        const owner = meta && meta.ownerToken;
        const mine = await Sync.ensureOwnerToken();
        if (owner && mine && owner !== mine) {
          note.textContent = "This catalog is managed by another household — you can use it, but only they can add or change words. Ask them to add new weeks, or connect a different catalog.";
          note.classList.remove("hidden");
          form.classList.add("hidden");
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
    flushActivity();
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
    reviewSession = { queue: shuffle(queue), index: 0, streak: 0, docs };
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
    const item = reviewSession.queue[reviewSession.index];
    const answer = document.getElementById("review-input").value.trim();
    const correct = answer.toLowerCase() === item.word.text.trim().toLowerCase();
    recordAnswer(item.word, correct, "spelling");
    const feedback = document.getElementById("review-feedback");
    if (correct) {
      reviewSession.streak++;
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
    } else {
      reviewSession.streak = 0;
      feedback.className = "feedback incorrect";
      feedback.innerHTML = `❌ Not quite. The word is:<span class="correct-answer">${escapeAttr(item.word.text)}</span>`;
    }
    updateStreakBadge(document.getElementById("review-streak"), reviewSession.streak);
    feedback.classList.remove("hidden");
    document.getElementById("review-input").disabled = true;
    document.getElementById("review-submit").classList.add("hidden");
    document.getElementById("review-continue").classList.remove("hidden");
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
      toast("Review complete! 🧠");
      flushActivity();
      renderHome();
      showScreen("home");
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
      document.getElementById("home-streak-banner").classList.add("hidden");
      document.getElementById("home-daily-goal").classList.add("hidden");
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

    renderStreakBanner();
    renderDailyGoal();
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

  document.querySelectorAll(".menu-card[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      const noWordListNeeded = target === "progress" || target === "shop" || target === "review";
      if (!noWordListNeeded && (!state.progress || state.progress.words.length === 0)) {
        toast("Add some words first — try a starter list!");
        openStarterLists();
        return;
      }
      if (target === "flashcard") openFlashcard();
      else if (target === "spelling") openSpelling(false);
      else if (target === "vocab") openVocab(false);
      else if (target === "test-setup") showScreen("test-setup");
      else if (target === "speed-setup") showScreen("speed-setup");
      else if (target === "scramble") openScramble();
      else if (target === "review") openReview();
      else if (target === "progress") openProgress();
      else if (target === "shop") openShop();
    });
  });

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

  function openSpelling() {
    spell = { queue: shuffle(state.progress.words), retry: [], index: 0, round: 1, streak: 0, missedThisRound: false };
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
    const w = spell.queue[spell.index];
    const answer = document.getElementById("spell-input").value.trim();
    const correct = answer.toLowerCase() === w.text.trim().toLowerCase();
    recordAnswer(w, correct, "spelling");
    const feedback = document.getElementById("spell-feedback");
    if (correct) {
      spell.streak++;
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
    } else {
      spell.streak = 0;
      spell.missedThisRound = true;
      if (spell.round === 1) spell.retry.push(w);
      feedback.className = "feedback incorrect";
      feedback.innerHTML = `❌ Not quite. The word is:<span class="correct-answer">${escapeAttr(w.text)}</span>`;
    }
    updateStreakBadge(document.getElementById("spell-streak"), spell.streak);
    feedback.classList.remove("hidden");
    document.getElementById("spell-input").disabled = true;
    document.getElementById("spell-submit").classList.add("hidden");
    document.getElementById("spell-continue").classList.remove("hidden");
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
        if (!awardRoundCompletionBonus(spell)) toast("Spelling practice complete! ⭐");
        flushActivity();
        renderHome();
        showScreen("home");
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
   * VOCAB PRACTICE SESSION
   * ------------------------------------------------------------------- */
  let vocab = { queue: [], retry: [], index: 0, round: 1, streak: 0, missedThisRound: false };

  function openVocab() {
    vocab = { queue: shuffle(state.progress.words), retry: [], index: 0, round: 1, streak: 0, missedThisRound: false };
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
    document.getElementById("vocab-definition").textContent = w.definition || "(No definition added for this word)";
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
    recordAnswer(w, knewIt, "vocab");
    if (knewIt) vocab.streak++;
    else { vocab.streak = 0; vocab.missedThisRound = true; if (vocab.round === 1) vocab.retry.push(w); }
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
        if (!awardRoundCompletionBonus(vocab)) toast("Vocab practice complete! ⭐");
        flushActivity();
        renderHome();
        showScreen("home");
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
    recordAnswer(w, record.correct, record.kind, { silent: true });
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
    const correct = answer.toLowerCase() === w.text.trim().toLowerCase();
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

  function showTestResults() {
    if (state.profile && state.progress) {
      const total = test.results.length;
      const right = test.results.filter((r) => r.correct).length;
      const pct = total ? Math.round((right / total) * 100) : 0;
      state.profile.recentTests = [
        { date: todayLocalStr(), kind: test.kind, pct, weekId: state.progress.weekId },
        ...(state.profile.recentTests || []),
      ].slice(0, 5);
      persistProfile();
    }
    renderResultsScreen({
      title: "Test Results",
      kindLabel: (test.kind === "spelling" ? "Spelling" : "Vocab") + " Test",
      results: test.results,
    });
  }

  function renderResultsScreen({ title, kindLabel, results }) {
    const total = results.length;
    const right = results.filter((r) => r.correct).length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    document.getElementById("test-results-title").textContent = title;
    document.getElementById("test-score-circle").textContent = pct + "%";
    document.getElementById("test-score-text").textContent = `${right} of ${total} correct — ${kindLabel}`;

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

    const perfectRoundBonus = total >= 4 && right === total;
    if (perfectRoundBonus) {
      addStars(5);
      toast("🌟 Perfect round! +5 ⭐");
    } else if (pct === 100) toast("Perfect score! Amazing! 🌟");
    else if (pct >= 80) toast("Great job! Almost ready! ⭐");
    else toast("Good practice — a few more rounds will help.");

    if (pct >= 90) { celebrate("big"); playSound("perfect"); }

    flushActivity();
    showScreen("test-results");
  }
  document.getElementById("test-results-done").addEventListener("click", () => { renderHome(); showScreen("home"); });

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
    recordAnswer(w, correct, speed.kind);
    if (correct) speed.streak++; else speed.streak = 0;
    updateStreakBadge(document.getElementById("speed-streak"), speed.streak);
    speed.results.push({ kind: speed.kind, word: w.text, correct });
    saveProgress(state.profile.id, state.progress.weekId, state.progress);

    speed.index++;
    if (speed.index >= speed.queue.length) {
      renderResultsScreen({
        title: "Speed Quiz Results",
        kindLabel: (speed.kind === "spelling" ? "Spelling" : "Vocab") + " Speed Quiz",
        results: speed.results,
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

  function openScramble() {
    scramble = { queue: shuffle(state.progress.words), retry: [], index: 0, round: 1, streak: 0, bank: [], answer: [], locked: false, missedThisRound: false };
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
    recordAnswer(w, correct, "spelling");
    const feedback = document.getElementById("scramble-feedback");
    if (correct) {
      scramble.streak++;
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
    } else {
      scramble.streak = 0;
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
        if (!awardRoundCompletionBonus(scramble)) toast("Word Scramble complete! ⭐");
        flushActivity();
        renderHome();
        showScreen("home");
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
        const row = document.createElement("div");
        row.className = "result-row " + meta.cls;
        row.innerHTML = `<span>${icon} ${escapeAttr(w.text)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${meta.label}</span>`;
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
      onBuy: () => buyItem("char", item),
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
        onBuy: () => buyItem("avatar", item),
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
        onBuy: () => buyItem("theme", item),
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

  // Two devices spending the same balance simultaneously can double-spend —
  // accepted tradeoff at family scale, resolved last-write-wins via the
  // existing profile sync. Not building conflict-resolution machinery for it.
  function buyItem(kind, item) {
    const p = state.profile;
    const unlockId = kind + ":" + item.id;
    if (isUnlocked(p, unlockId)) return;
    // Second line of defence behind sanitizePrice(): a spend must never be
    // able to *increase* the balance, whatever the caller handed us.
    const price = sanitizePrice(item.price, 0);
    if ((p.stars || 0) < price) return;
    const label = kind === "avatar" ? item.emoji : item.label;
    if (!confirm(`Buy ${label} for ${price} ⭐?`)) return;
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
