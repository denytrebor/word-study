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

  function saveProgressLocal(profileId, weekId, progress) {
    save(progressKey(profileId, weekId), progress);
    const idx = load(progressIndexKey(profileId), []);
    if (!idx.includes(weekId)) { idx.push(weekId); save(progressIndexKey(profileId), idx); }
  }
  function saveProgress(profileId, weekId, progress) {
    saveProgressLocal(profileId, weekId, progress);
    if (firestoreReady()) Sync.pushProgress(profileId, weekId, progress);
  }

  function updateLocalProfileStars(id, stars) {
    const profiles = getProfiles();
    const p = profiles.find((x) => x.id === id);
    if (p) { p.stars = stars; saveProfiles(profiles); }
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

  /* ---------------------------------------------------------------------
   * App state
   * ------------------------------------------------------------------- */
  const state = {
    profile: null,       // active profile {id, name, avatar, stars, grade}
    catalogWeeks: [],     // every week in the connected catalog, all grades
    selectedWeek: null,   // the catalog week currently being studied
    progress: null,       // this profile's per-word stats for selectedWeek
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
    header.classList.toggle("hidden", id === "profiles" || id === "household");
    window.scrollTo(0, 0);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function refreshHeader() {
    if (!state.profile) return;
    document.getElementById("header-profile-name").textContent = state.profile.name;
    document.getElementById("header-stars").textContent = "⭐ " + (state.profile.stars || 0);
  }

  function addStars(n) {
    state.profile.stars = (state.profile.stars || 0) + n;
    const profiles = getProfiles();
    const idx = profiles.findIndex((p) => p.id === state.profile.id);
    if (idx !== -1) profiles[idx] = state.profile;
    saveProfiles(profiles);
    refreshHeader();
    if (firestoreReady()) Sync.pushProfile(state.profile);
  }

  function escapeAttr(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /* ---------------------------------------------------------------------
   * Word status (for progress + repetition weighting)
   * ------------------------------------------------------------------- */
  function wordStatus(w) {
    const totalAttempts = w.spelling.attempts + w.vocab.attempts;
    const totalCorrect = w.spelling.correct + w.vocab.known;
    if (totalAttempts === 0) return "new";
    return totalCorrect / totalAttempts >= 0.8 ? "solid" : "shaky";
  }

  /* ---------------------------------------------------------------------
   * PROFILES SCREEN
   * ------------------------------------------------------------------- */
  const AVATARS = ["🦊", "🐨", "🐸", "🦁", "🐯", "🐼", "🦉", "🐢", "🐧", "🦄"];

  function renderProfiles() {
    const list = getProfiles();
    const wrap = document.getElementById("profile-list");
    wrap.innerHTML = "";
    list.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "profile-card";
      const gradeLine = p.grade ? `<br><span style="font-weight:400;font-size:.75rem;color:var(--muted)">Grade ${escapeAttr(p.grade)}</span>` : "";
      btn.innerHTML = `<span class="avatar">${p.avatar}</span>${escapeAttr(p.name)}${gradeLine}`;
      btn.addEventListener("click", () => selectProfile(p.id));
      wrap.appendChild(btn);
    });
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
      saveProfiles(remoteList.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, stars: p.stars, grade: p.grade || "" })));
      renderProfiles();
    });
  }

  function applyRemoteProfileUpdate(data) {
    if (!state.profile) return;
    if (typeof data.stars === "number" && data.stars !== state.profile.stars) {
      state.profile.stars = data.stars;
      updateLocalProfileStars(state.profile.id, data.stars);
      refreshHeader();
    }
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
    state.profile = p;
    setActiveProfileId(id);
    refreshHeader();
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
    const p = { id: uid(), name, avatar: AVATARS[profiles.length % AVATARS.length], stars: 0, grade };
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

  document.getElementById("btn-switch-profile").addEventListener("click", () => {
    renderProfiles();
    showScreen("profiles");
    watchProfilesList();
  });
  document.getElementById("btn-home").addEventListener("click", () => {
    renderHome();
    showScreen("home");
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

  async function loadCatalogAndWeek() {
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
        state.selectedWeek = null;
        state.progress = null;
        showScreen("catalog-setup");
        return;
      }
    }

    state.catalogWeeks = load(catalogWeeksKey(code), []);
    if (firestoreReady()) {
      try {
        const remote = await Sync.fetchCatalogWeeks(code);
        if (remote.length) { state.catalogWeeks = remote; save(catalogWeeksKey(code), remote); }
      } catch (e) { /* fall back to local cache */ }
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
  function renderHome() {
    if (!state.selectedWeek || !state.progress) {
      document.getElementById("home-week-label").textContent = "No word list yet";
      document.getElementById("home-word-count").textContent = "Add words from Manage Word Catalog to get started";
      return;
    }
    document.getElementById("home-week-label").textContent = state.selectedWeek.label;
    const n = state.progress.words.length;
    document.getElementById("home-word-count").textContent = n === 1 ? "1 word" : n + " words";
  }

  document.querySelectorAll(".menu-card[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      if (target !== "progress" && (!state.progress || state.progress.words.length === 0)) {
        toast("Add some words to the catalog first!");
        openCatalogEditor();
        return;
      }
      if (target === "flashcard") openFlashcard();
      else if (target === "spelling") openSpelling(false);
      else if (target === "vocab") openVocab(false);
      else if (target === "test-setup") showScreen("test-setup");
      else if (target === "speed-setup") showScreen("speed-setup");
      else if (target === "progress") openProgress();
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
  let spell = { queue: [], retry: [], index: 0, round: 1, streak: 0 };

  function openSpelling() {
    spell = { queue: shuffle(state.progress.words), retry: [], index: 0, round: 1, streak: 0 };
    document.getElementById("spell-streak").classList.add("hidden");
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
    w.spelling.attempts++;
    const feedback = document.getElementById("spell-feedback");
    if (correct) {
      w.spelling.correct++;
      spell.streak++;
      addStars(1);
      feedback.className = "feedback correct";
      feedback.textContent = "✅ Correct! Nice work.";
    } else {
      spell.streak = 0;
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
        toast("Let's try those tricky ones again!");
        renderSpelling();
      } else {
        toast("Spelling practice complete! ⭐");
        renderHome();
        showScreen("home");
      }
    } else {
      renderSpelling();
    }
  });

  document.getElementById("spell-exit").addEventListener("click", () => {
    saveProgress(state.profile.id, state.progress.weekId, state.progress);
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * VOCAB PRACTICE SESSION
   * ------------------------------------------------------------------- */
  let vocab = { queue: [], retry: [], index: 0, round: 1, streak: 0 };

  function openVocab() {
    vocab = { queue: shuffle(state.progress.words), retry: [], index: 0, round: 1, streak: 0 };
    document.getElementById("vocab-streak").classList.add("hidden");
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
    w.vocab.attempts++;
    if (knewIt) { w.vocab.known++; vocab.streak++; addStars(1); }
    else { vocab.streak = 0; if (vocab.round === 1) vocab.retry.push(w); }
    updateStreakBadge(document.getElementById("vocab-streak"), vocab.streak);
    saveProgress(state.profile.id, state.progress.weekId, state.progress);

    vocab.index++;
    if (vocab.index >= vocab.queue.length) {
      if (vocab.round === 1 && vocab.retry.length > 0) {
        vocab.queue = shuffle(vocab.retry);
        vocab.retry = [];
        vocab.index = 0;
        vocab.round = 2;
        toast("Let's review those again!");
        renderVocab();
      } else {
        toast("Vocab practice complete! ⭐");
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
    w.spelling.attempts += record.kind === "spelling" ? 1 : 0;
    w.vocab.attempts += record.kind === "vocab" ? 1 : 0;
    if (record.correct) {
      if (record.kind === "spelling") w.spelling.correct++; else w.vocab.known++;
      addStars(1);
    }
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
    renderHome();
    showScreen("home");
  });

  function showTestResults() {
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

    if (pct === 100) toast("Perfect score! Amazing! 🌟");
    else if (pct >= 80) toast("Great job! Almost ready! ⭐");
    else toast("Good practice — a few more rounds will help.");

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
    if (speed.kind === "spelling") { w.spelling.attempts++; if (correct) w.spelling.correct++; }
    else { w.vocab.attempts++; if (correct) w.vocab.known++; }
    if (correct) { speed.streak++; addStars(1); } else { speed.streak = 0; }
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
   * PROGRESS SCREEN
   * ------------------------------------------------------------------- */
  function statusMeta(status) {
    if (status === "solid") return { icon: "✅", label: "Looking good", cls: "status-solid" };
    if (status === "shaky") return { icon: "🔁", label: "Needs practice", cls: "status-shaky" };
    return { icon: "⚪", label: "Not practiced yet", cls: "status-new" };
  }

  async function openProgress() {
    const cur = document.getElementById("progress-current");
    cur.innerHTML = "";
    if (state.progress && state.progress.words.length) {
      state.progress.words.forEach((w) => {
        const meta = statusMeta(wordStatus(w));
        const row = document.createElement("div");
        row.className = "result-row " + meta.cls;
        row.innerHTML = `<span>${meta.icon} ${escapeAttr(w.text)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${meta.label}</span>`;
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
   * HOUSEHOLD (cross-device sync) SCREEN
   * ------------------------------------------------------------------- */
  const SYNC_SKIP_KEY = "ws_sync_skipped";

  function enterApp() {
    const profiles = getProfiles();
    renderProfiles();
    const activeId = getActiveProfileId();
    if (activeId && profiles.find((p) => p.id === activeId)) {
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

  /* ---------------------------------------------------------------------
   * INIT
   * ------------------------------------------------------------------- */
  function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }

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
