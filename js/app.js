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
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.85;
      u.pitch = 1;
      u.lang = "en-US";
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

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
    header.classList.toggle("hidden", id === "profiles" || id === "household" || id === "parent-dashboard");
    window.scrollTo(0, 0);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  // equippedAvatar replaces the legacy `avatar` field at display time —
  // profiles that never opened the shop (e.g. Micah's existing doc) keep
  // working untouched since this just falls back to `avatar`.
  function avatarFor(profile) {
    return (profile && (profile.equippedAvatar || profile.avatar)) || "🙂";
  }

  function refreshHeader() {
    if (!state.profile) return;
    document.getElementById("header-avatar").textContent = avatarFor(state.profile) + " ";
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

  function escapeAttr(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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

  function renderProfiles() {
    const list = getProfiles();
    const students = list.filter((p) => p.role !== "parent");
    const parents = list.filter((p) => p.role === "parent");

    const wrap = document.getElementById("profile-list");
    wrap.innerHTML = "";
    students.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "profile-card";
      const gradeLine = p.grade ? `<br><span style="font-weight:400;font-size:.75rem;color:var(--muted)">Grade ${escapeAttr(p.grade)}</span>` : "";
      btn.innerHTML = `<span class="avatar">${avatarFor(p)}</span>${escapeAttr(p.name)}${gradeLine}`;
      btn.addEventListener("click", () => selectProfile(p.id));
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

    const code = typeof Sync !== "undefined" ? Sync.getHouseholdCode() : null;
    const info = document.getElementById("household-info");
    info.classList.remove("hidden");
    if (code) {
      info.innerHTML = 'Household code: <strong id="household-code-display"></strong> <button id="btn-copy-household" class="btn btn-ghost household-copy-btn">Copy</button>';
      document.getElementById("household-code-display").textContent = code;
      document.getElementById("btn-copy-household").addEventListener("click", () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(() => toast("Copied!")).catch(() => toast(code));
        } else {
          toast(code);
        }
      });
    } else if (typeof Sync !== "undefined") {
      info.innerHTML = '<button id="btn-open-household" class="btn btn-ghost household-copy-btn">🔗 Sync across devices</button>';
      document.getElementById("btn-open-household").addEventListener("click", () => showScreen("household"));
    } else {
      info.classList.add("hidden");
    }
  }

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

  document.getElementById("btn-add-profile").addEventListener("click", () => {
    const input = document.getElementById("new-profile-name");
    const gradeInput = document.getElementById("new-profile-grade");
    const name = input.value.trim();
    if (!name) { toast("Type a name first"); return; }
    const grade = gradeInput.value.trim();
    const profiles = getProfiles();
    const studentCount = profiles.filter((x) => x.role !== "parent").length;
    const p = { id: uid(), name, avatar: AVATARS[studentCount % AVATARS.length], stars: 0, grade };
    profiles.push(p);
    saveProfiles(profiles);
    input.value = "";
    gradeInput.value = "";
    renderProfiles();
    if (firestoreReady()) Sync.pushProfile(p);
    selectProfile(p.id);
  });
  function addProfileOnEnter(e) { if (e.key === "Enter") document.getElementById("btn-add-profile").click(); }
  document.getElementById("new-profile-name").addEventListener("keydown", addProfileOnEnter);
  document.getElementById("new-profile-grade").addEventListener("keydown", addProfileOnEnter);

  /* ---------------------------------------------------------------------
   * PARENT PROFILES (role:"parent" — child-proofing PIN, not security;
   * see spec §6. No grade/stars/streak/progress for these profiles.)
   * ------------------------------------------------------------------- */
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
    let mostUsedMode = null, mostUsedCount = 0;
    Object.entries(modeTotals).forEach(([mode, n]) => { if (n > mostUsedCount) { mostUsedMode = mode; mostUsedCount = n; } });

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

    return `
      <div class="parent-student-card">
        <div class="psc-identity">
          <span class="avatar">${avatarFor(student)}</span>
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
        <p class="psc-usage-line">${weekAnswers} answers this week${weekAccuracy !== null ? " · " + weekAccuracy + "% accuracy" : ""}${mostUsedMode ? " · mostly " + mostUsedMode : ""}</p>

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

  function computeAutoWeek(weeks, grade) {
    const gradeWeeks = weeks.filter((w) => w.grade === grade).sort((a, b) => (a.weekStartDate < b.weekStartDate ? -1 : 1));
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
    if (!progress) {
      progress = {
        weekId: week.id,
        grade: week.grade,
        label: week.label,
        words: week.words.map((w) => Object.assign({ id: w.id, text: w.text, definition: w.definition }, freshStat())),
      };
    } else {
      // Reconcile in case the catalog's word list changed since last practiced.
      const existingById = new Map(progress.words.map((w) => [w.id, w]));
      progress.words = week.words.map((w) => existingById.get(w.id) || Object.assign({ id: w.id, text: w.text, definition: w.definition }, freshStat()));
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

    state.catalogWeeks = load(catalogWeeksKey(code), []);
    if (firestoreReady()) {
      try {
        const remote = await Sync.fetchCatalogWeeks(code);
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
      toast("Couldn't connect — check your internet and try again.");
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
      const words = block
        .map((line) => {
          const idx = line.indexOf(",");
          const wtext = idx === -1 ? line : line.slice(0, idx);
          const definition = idx === -1 ? "" : line.slice(idx + 1).trim();
          return { id: uid(), text: wtext.trim(), definition };
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

  function openCatalogEditor() {
    const code = getCatalogCode();
    document.getElementById("catalog-code-display").textContent = code === LOCAL_CATALOG ? "(this device only)" : code;
    document.getElementById("catalog-paste-input").value = "";
    document.getElementById("catalog-preview").classList.add("hidden");
    document.getElementById("btn-save-catalog").classList.add("hidden");
    showScreen("catalog-editor");
  }
  document.getElementById("btn-manage-catalog").addEventListener("click", openCatalogEditor);
  document.getElementById("catalog-editor-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

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
      const merged = mergeWeeks(load(key, []), catalogParsePreview);
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
    if (!state.selectedWeek || !state.progress) {
      document.getElementById("home-week-label").textContent = "No word list yet";
      document.getElementById("home-word-count").textContent = "Add words from Manage Word Catalog to get started";
      summary.classList.add("hidden");
      document.getElementById("home-streak-banner").classList.add("hidden");
      return;
    }
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
  }

  document.querySelectorAll(".menu-card[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      const noWordListNeeded = target === "progress" || target === "shop";
      if (!noWordListNeeded && (!state.progress || state.progress.words.length === 0)) {
        toast("Add some words to the catalog first!");
        openCatalogEditor();
        return;
      }
      if (target === "flashcard") openFlashcard();
      else if (target === "spelling") openSpelling(false);
      else if (target === "vocab") openVocab(false);
      else if (target === "test-setup") showScreen("test-setup");
      else if (target === "speed-setup") showScreen("speed-setup");
      else if (target === "scramble") openScramble();
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
    if (!scramble.answer.includes(null)) checkScrambleAnswer();
  }

  function removeFromAnswer(slotIndex) {
    if (scramble.locked) return;
    scramble.answer[slotIndex] = null;
    renderScrambleTiles();
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

  function openShop() {
    renderShop();
    showScreen("shop");
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

  function renderShop() {
    const p = state.profile;
    document.getElementById("shop-lifetime").textContent = `All-time: ${p.lifetimeStars || 0} ⭐`;

    const avatarWrap = document.getElementById("shop-avatars");
    avatarWrap.innerHTML = "";
    ShopCatalog.AVATARS.forEach((item) => {
      const owned = item.price === 0 || isUnlocked(p, "avatar:" + item.id);
      const equipped = (p.equippedAvatar || p.avatar) === item.emoji;
      renderShopItem(avatarWrap, {
        html: `<span class="shop-item-emoji">${item.emoji}</span>`,
        legendary: item.legendary,
        owned,
        equipped,
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

  function equipAvatar(item) {
    const p = state.profile;
    const unlockId = "avatar:" + item.id;
    if (item.price > 0 && !isUnlocked(p, unlockId)) return;
    if ((p.equippedAvatar || p.avatar) === item.emoji) return;
    p.equippedAvatar = item.emoji;
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
    if ((p.stars || 0) < item.price) return;
    const label = kind === "avatar" ? item.emoji : item.label;
    if (!confirm(`Buy ${label} for ${item.price} ⭐?`)) return;
    p.stars -= item.price;
    p.unlocks = p.unlocks || [];
    p.unlocks.push(unlockId);
    if (kind === "avatar") p.equippedAvatar = item.emoji;
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

  document.getElementById("btn-create-household").addEventListener("click", async () => {
    const btn = document.getElementById("btn-create-household");
    btn.disabled = true;
    try {
      const code = await Sync.createHousehold();
      toast(`Household created! Code: ${code}`);
      enterApp();
    } catch (e) {
      toast("Couldn't connect — check your internet and try again.");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-join-household").addEventListener("click", async () => {
    const input = document.getElementById("join-household-code");
    const code = input.value.trim();
    if (!code) { toast("Enter a code first"); return; }
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
  document.getElementById("join-household-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-join-household").click();
  });

  document.getElementById("btn-skip-household").addEventListener("click", () => {
    localStorage.setItem(SYNC_SKIP_KEY, "1");
    enterApp();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushActivity();
  });

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
