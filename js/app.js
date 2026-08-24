(function () {
  "use strict";

  /* ---------------------------------------------------------------------
   * Storage helpers
   * ------------------------------------------------------------------- */
  const PROFILES_KEY = "ws_profiles";
  const ACTIVE_KEY = "ws_active_profile";
  const weekKey = (id) => `ws_week_${id}`;
  const historyKey = (id) => `ws_history_${id}`;

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

  function getWeek(profileId) { return load(weekKey(profileId), null); }
  function saveWeek(profileId, week) { save(weekKey(profileId), week); }
  function getHistory(profileId) { return load(historyKey(profileId), []); }
  function saveHistory(profileId, hist) { save(historyKey(profileId), hist); }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function freshWord(text, definition) {
    return {
      id: uid(),
      text: text.trim(),
      definition: (definition || "").trim(),
      spelling: { correct: 0, attempts: 0 },
      vocab: { known: 0, attempts: 0 },
    };
  }

  function freshWeek() {
    const now = Date.now();
    return {
      label: "Week of " + new Date(now).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      startedAt: now,
      words: [],
    };
  }

  /* ---------------------------------------------------------------------
   * App state
   * ------------------------------------------------------------------- */
  const state = {
    profile: null, // active profile object
    week: null,
    editingWords: [],
    session: null, // active study session object
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
    header.classList.toggle("hidden", id === "profiles");
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
      btn.innerHTML = `<span class="avatar">${p.avatar}</span>${p.name}`;
      btn.addEventListener("click", () => selectProfile(p.id));
      wrap.appendChild(btn);
    });
  }

  function selectProfile(id) {
    const profiles = getProfiles();
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    state.profile = p;
    setActiveProfileId(id);
    let week = getWeek(id);
    if (!week) {
      week = freshWeek();
      saveWeek(id, week);
    }
    state.week = week;
    refreshHeader();
    renderHome();
    showScreen("home");
  }

  document.getElementById("btn-add-profile").addEventListener("click", () => {
    const input = document.getElementById("new-profile-name");
    const name = input.value.trim();
    if (!name) { toast("Type a name first"); return; }
    const profiles = getProfiles();
    const p = { id: uid(), name, avatar: AVATARS[profiles.length % AVATARS.length], stars: 0 };
    profiles.push(p);
    saveProfiles(profiles);
    input.value = "";
    renderProfiles();
    selectProfile(p.id);
  });
  document.getElementById("new-profile-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-add-profile").click();
  });

  document.getElementById("btn-switch-profile").addEventListener("click", () => {
    renderProfiles();
    showScreen("profiles");
  });
  document.getElementById("btn-home").addEventListener("click", () => {
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * HOME SCREEN
   * ------------------------------------------------------------------- */
  function renderHome() {
    state.week = getWeek(state.profile.id) || freshWeek();
    document.getElementById("home-week-label").textContent = state.week.label;
    const n = state.week.words.length;
    document.getElementById("home-word-count").textContent = n === 1 ? "1 word" : n + " words";
  }

  document.querySelectorAll(".menu-card[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      if (target !== "edit" && target !== "progress" && state.week.words.length === 0) {
        toast("Add some words to this week's list first!");
        openEdit();
        return;
      }
      if (target === "edit") openEdit();
      else if (target === "flashcard") openFlashcard();
      else if (target === "spelling") openSpelling(false);
      else if (target === "vocab") openVocab(false);
      else if (target === "test-setup") showScreen("test-setup");
      else if (target === "progress") openProgress();
    });
  });

  /* ---------------------------------------------------------------------
   * EDIT SCREEN
   * ------------------------------------------------------------------- */
  function openEdit() {
    state.editingWords = state.week.words.slice();
    renderWordRows();
    showScreen("edit");
  }

  function renderWordRows() {
    const wrap = document.getElementById("word-rows");
    wrap.innerHTML = "";
    state.editingWords.forEach((w) => {
      const row = document.createElement("div");
      row.className = "word-row";
      row.innerHTML = `
        <input type="text" class="word-field" placeholder="word" value="${escapeAttr(w.text)}" spellcheck="false" autocomplete="off" autocorrect="off">
        <input type="text" class="def-field" placeholder="definition (optional)" value="${escapeAttr(w.definition)}" spellcheck="false" autocomplete="off" autocorrect="off">
        <button class="row-delete" title="Remove">✕</button>
      `;
      const wordInput = row.querySelector(".word-field");
      const defInput = row.querySelector(".def-field");
      wordInput.addEventListener("input", () => { w.text = wordInput.value; });
      defInput.addEventListener("input", () => { w.definition = defInput.value; });
      row.querySelector(".row-delete").addEventListener("click", () => {
        state.editingWords = state.editingWords.filter((x) => x.id !== w.id);
        renderWordRows();
      });
      wrap.appendChild(row);
    });
  }

  function escapeAttr(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  document.getElementById("btn-add-row").addEventListener("click", () => {
    state.editingWords.push(freshWord("", ""));
    renderWordRows();
    const rows = document.querySelectorAll("#word-rows .word-field");
    if (rows.length) rows[rows.length - 1].focus();
  });

  document.getElementById("btn-import-paste").addEventListener("click", () => {
    const box = document.getElementById("paste-input");
    const lines = box.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast("Paste some words first"); return; }
    lines.forEach((line) => {
      const commaIdx = line.indexOf(",");
      let word, def;
      if (commaIdx === -1) { word = line; def = ""; }
      else { word = line.slice(0, commaIdx); def = line.slice(commaIdx + 1); }
      if (word.trim()) state.editingWords.push(freshWord(word, def));
    });
    box.value = "";
    renderWordRows();
    toast(`Added ${lines.length} word${lines.length === 1 ? "" : "s"}`);
  });

  document.getElementById("btn-save-week").addEventListener("click", () => {
    const cleaned = state.editingWords.filter((w) => w.text.trim().length > 0);
    state.week.words = cleaned;
    saveWeek(state.profile.id, state.week);
    toast("Saved!");
    renderHome();
    showScreen("home");
  });

  document.getElementById("btn-new-week").addEventListener("click", () => {
    if (state.week.words.length > 0) {
      const ok = confirm("Archive this week's list and start a fresh one? Past progress is saved in Progress > Past Weeks.");
      if (!ok) return;
      const hist = getHistory(state.profile.id);
      hist.unshift(Object.assign({}, state.week, { endedAt: Date.now() }));
      saveHistory(state.profile.id, hist);
    }
    state.week = freshWeek();
    saveWeek(state.profile.id, state.week);
    state.editingWords = [];
    renderWordRows();
    renderHome();
    toast("New week started!");
  });

  /* ---------------------------------------------------------------------
   * FLASHCARD (Look & Say) SESSION
   * ------------------------------------------------------------------- */
  let flash = { order: [], index: 0 };

  function openFlashcard() {
    flash.order = state.week.words.slice();
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
    flash.order = e.target.checked ? shuffle(state.week.words) : state.week.words.slice();
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
    spell = { queue: shuffle(state.week.words), retry: [], index: 0, round: 1, streak: 0 };
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
    saveWeek(state.profile.id, state.week);
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
    saveWeek(state.profile.id, state.week);
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * VOCAB PRACTICE SESSION
   * ------------------------------------------------------------------- */
  let vocab = { queue: [], retry: [], index: 0, round: 1, streak: 0 };

  function openVocab() {
    vocab = { queue: shuffle(state.week.words), retry: [], index: 0, round: 1, streak: 0 };
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
    saveWeek(state.profile.id, state.week);

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
    saveWeek(state.profile.id, state.week);
    renderHome();
    showScreen("home");
  });

  /* ---------------------------------------------------------------------
   * TEST MODE
   * ------------------------------------------------------------------- */
  let test = { kind: "spelling", queue: [], index: 0, replaysLeft: 2, results: [] };

  document.querySelectorAll(".menu-card[data-test-kind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.week.words.length === 0) { toast("Add some words first!"); showScreen("edit"); return; }
      test.kind = btn.getAttribute("data-test-kind");
      test.queue = shuffle(state.week.words);
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
    saveWeek(state.profile.id, state.week);

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
    saveWeek(state.profile.id, state.week);
    renderHome();
    showScreen("home");
  });

  function showTestResults() {
    const total = test.results.length;
    const right = test.results.filter((r) => r.correct).length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    document.getElementById("test-score-circle").textContent = pct + "%";
    document.getElementById("test-score-text").textContent = `${right} of ${total} correct — ${test.kind === "spelling" ? "Spelling" : "Vocab"} Test`;

    const list = document.getElementById("test-results-list");
    list.innerHTML = "";
    test.results.forEach((r) => {
      const row = document.createElement("div");
      row.className = "result-row";
      const icon = r.correct ? "✅" : "❌";
      const extra = !r.correct && r.kind === "spelling" ? ` <span style="opacity:.6">(you wrote: ${escapeAttr(r.given || "—")})</span>` : "";
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
   * PROGRESS SCREEN
   * ------------------------------------------------------------------- */
  function statusMeta(status) {
    if (status === "solid") return { icon: "✅", label: "Looking good", cls: "status-solid" };
    if (status === "shaky") return { icon: "🔁", label: "Needs practice", cls: "status-shaky" };
    return { icon: "⚪", label: "Not practiced yet", cls: "status-new" };
  }

  function openProgress() {
    const cur = document.getElementById("progress-current");
    cur.innerHTML = "";
    state.week.words.forEach((w) => {
      const meta = statusMeta(wordStatus(w));
      const row = document.createElement("div");
      row.className = "result-row " + meta.cls;
      row.innerHTML = `<span>${meta.icon} ${escapeAttr(w.text)}</span><span style="font-weight:400;color:var(--muted);font-size:.85rem">${meta.label}</span>`;
      cur.appendChild(row);
    });
    if (state.week.words.length === 0) {
      cur.innerHTML = '<p class="hint">No words yet this week.</p>';
    }

    const hist = getHistory(state.profile.id);
    const histWrap = document.getElementById("progress-history");
    histWrap.innerHTML = "";
    if (hist.length === 0) {
      histWrap.innerHTML = '<p class="hint">No past weeks yet.</p>';
    } else {
      hist.forEach((wk) => {
        let correct = 0, attempts = 0;
        wk.words.forEach((w) => { correct += w.spelling.correct + w.vocab.known; attempts += w.spelling.attempts + w.vocab.attempts; });
        const pct = attempts ? Math.round((correct / attempts) * 100) : 0;
        const div = document.createElement("div");
        div.className = "history-week";
        div.innerHTML = `<div class="hw-title">${escapeAttr(wk.label)}</div><div class="hw-meta">${wk.words.length} words · ${attempts ? pct + "% accuracy" : "not practiced"}</div>`;
        histWrap.appendChild(div);
      });
    }
    showScreen("progress");
  }
  document.getElementById("progress-exit").addEventListener("click", () => { renderHome(); showScreen("home"); });

  /* ---------------------------------------------------------------------
   * INIT
   * ------------------------------------------------------------------- */
  function init() {
    const profiles = getProfiles();
    renderProfiles();
    const activeId = getActiveProfileId();
    if (activeId && profiles.find((p) => p.id === activeId)) {
      selectProfile(activeId);
    } else {
      showScreen("profiles");
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
  }

  // wrap openFlashcard/openSpelling/openVocab to accept no-op arg from menu handler
  document.addEventListener("DOMContentLoaded", init);
})();
