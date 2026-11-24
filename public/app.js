/* ZTI frontend — state, rendering, streaming, attachments, voice.
   Depends on: audio.js (window.ZTIAudio). Optional CDN libs: marked, DOMPurify, highlight.js. */
(() => {
  "use strict";

  const A = window.ZTIAudio;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ico = (name, cls = "") => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const host = window.location.hostname || "localhost";
  const API_BASE = window.location.port === "3000" ? "" : `http://${host}:3000`;

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const PERSONAS = [
    { id: "humanoid", name: "Humanoid", desc: "Warm, natural, conversational (default)" },
    { id: "tutor", name: "Study Tutor", desc: "Step-by-step teaching with examples" },
    { id: "coder", name: "Coding Pro", desc: "Senior engineer: clean code, real fixes" },
    { id: "creative", name: "Creative Partner", desc: "Imaginative, playful brainstorming" },
    { id: "professional", name: "Professional", desc: "Polished, structured, businesslike" },
  ];

  const QUICK_ACTIONS = [
    { label: "Summarize", text: "Summarize the following in a few clear bullet points:\n\n" },
    { label: "Translate", text: "Translate this into Hindi:\n\n" },
    { label: "Explain code", text: "Explain what this code does, step by step:\n\n```\n\n```" },
    { label: "Fix bug", text: "Find and fix the bug in this code, and explain the cause:\n\n```\n\n```" },
    { label: "Improve writing", text: "Improve the clarity and tone of this text:\n\n" },
    { label: "Quiz me", text: "Quiz me with 5 questions on: " },
  ];

  const STARTERS = {
    summarize: { text: "Summarize and analyze the following. Give me the key points, insights and anything I should watch out for:\n\n" },
    code: { text: "Help me write and debug code. Here's what I'm working on:\n\n", persona: "coder" },
    research: { text: "Research the latest news and developments about ", webSearch: true },
  };

  const MAX_FILES = 4;
  const MAX_BYTES = 10 * 1024 * 1024;
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|log)$/i;
  const STORE_KEY = "zti.state.v1";

  /* ------------------------------------------------------------------ */
  /* State + persistence                                                 */
  /* ------------------------------------------------------------------ */

  const defaults = () => ({
    chats: [],
    activeId: null,
    view: "assistant",
    prefs: { persona: "humanoid", webSearch: false, codeExec: true, json: false, theme: "dark", userName: "Nipun" },
  });

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaults();
        return { ...d, ...s, prefs: { ...d.prefs, ...(s.prefs || {}) } };
      }
    } catch (e) {
      console.warn("Could not read saved state", e);
    }
    return defaults();
  }

  let state = loadState();
  let pending = []; // attachments waiting in the composer (kept in memory)
  let streaming = false;
  let controller = null;
  let speakingId = null;

  // Attachment binary data is kept in memory only; localStorage gets lightweight metadata.
  function serialisable() {
    return {
      ...state,
      chats: state.chats.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.attachments && m.attachments.length
            ? {
                ...m,
                attachments: m.attachments.map(({ id, name, mimeType, kind, size }) => ({ id, name, mimeType, kind, size, stripped: true })),
              }
            : m
        ),
      })),
    };
  }

  let saveTimer = null;
  function save(immediate = false) {
    clearTimeout(saveTimer);
    const run = () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(serialisable()));
          return;
        } catch (e) {
          // Storage full: drop the oldest non-active chat and retry.
          const victim = [...state.chats].sort((a, b) => a.updatedAt - b.updatedAt).find((c) => c.id !== state.activeId);
          if (!victim) return;
          state.chats = state.chats.filter((c) => c.id !== victim.id);
          toast("Storage was full — removed your oldest chat.", "error");
        }
      }
    };
    if (immediate) run();
    else saveTimer = setTimeout(run, 250);
  }

  const activeChat = () => {
    let c = state.chats.find((chat) => chat && chat.id === state.activeId);
    if (!c) {
      c = state.chats.find((chat) => chat && Array.isArray(chat.messages));
      if (c) {
        state.activeId = c.id;
      } else {
        c = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        state.chats = [c];
        state.activeId = c.id;
        save();
      }
    }
    if (!Array.isArray(c.messages)) c.messages = [];
    return c;
  };

  function newChat() {
    const cur = state.chats.find((c) => c && c.id === state.activeId);
    if (cur && cur.messages.length === 0) return cur; // reuse the empty one
    const chat = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
    save();
    return chat;
  }

  /* ------------------------------------------------------------------ */
  /* Toasts / clipboard / popovers                                       */
  /* ------------------------------------------------------------------ */

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  function closePopovers(except) {
    $$(".popover").forEach((p) => {
      if (p !== except) p.classList.add("hidden");
    });
  }

  function togglePopover(id) {
    const pop = $("#" + id);
    const willOpen = pop.classList.contains("hidden");
    closePopovers();
    if (willOpen) {
      if (id === "plusMenu") renderPlusMenu();
      if (id === "historyMenu") renderHistory();
      pop.classList.remove("hidden");
    }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".pop-wrap")) closePopovers();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopovers();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#globalSearch").focus();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Markdown rendering                                                  */
  /* ------------------------------------------------------------------ */

  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(text || "", { gfm: true, breaks: true });
      return window.DOMPurify.sanitize(html);
    }
    return esc(text || "").replace(/\n/g, "<br>");
  }

  function enhance(container) {
    $$("a", container).forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    $$("pre", container).forEach((pre) => {
      if (pre.parentElement.classList.contains("code-block")) return;
      const code = $("code", pre);
      const lang = ((code && [...code.classList].find((c) => c.startsWith("language-"))) || "").replace("language-", "") || "code";
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      wrap.innerHTML = `<div class="code-head"><span>${esc(lang)}</span><button type="button" class="copy-code">${ico("copy")}<span>Copy Code</span></button></div>`;
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      if (code && window.hljs) {
        try {
          window.hljs.highlightElement(code);
        } catch (_) {}
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Message rendering                                                   */
  /* ------------------------------------------------------------------ */

  const thread = () => $("#thread");
  const personaName = (id) => (PERSONAS.find((p) => p.id === id) || PERSONAS[0]).name;
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  function msgDisplayText(msg) {
    if (msg.json) return "```json\n" + msg.text + "\n```";
    return msg.text;
  }

  function buildUserEl(msg) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.dataset.id = msg.id;
    const atts = (msg.attachments || [])
      .map((a) =>
        a.previewUrl
          ? `<img class="att-img" src="${a.previewUrl}" alt="${esc(a.name)}" />`
          : `<span class="att-chip">${ico("file")}${esc(a.name)}</span>`
      )
      .join("");
    el.innerHTML = `<div class="bubble"><div class="att-row">${atts}</div><div class="txt">${esc(msg.text)}</div></div>`;
    return el;
  }

  function buildAiEl(msg, isLast) {
    const el = document.createElement("div");
    el.className = "msg ai";
    el.dataset.id = msg.id;
    el.innerHTML = `
      <div class="ai-avatar">${ico("sparkle")}</div>
      <div class="msg-body">
        <div class="msg-name">ZTI <span class="tag">${esc(personaName(msg.persona))}</span></div>
        <div class="md"></div>
        <div class="sources"></div>
        <div class="msg-actions">
          <button type="button" class="act" data-act="copy" title="Copy reply">${ico("copy")}<span>Copy</span></button>
          <button type="button" class="act" data-act="speak" title="Replay voice">${ico("volume")}<span>Listen</span></button>
          ${isLast ? `<button type="button" class="act" data-act="regen" title="Regenerate">${ico("refresh")}<span>Retry</span></button>` : ""}
        </div>
      </div>`;
    updateAiEl(el, msg, false);
    return el;
  }

  function updateAiEl(el, msg, isStreaming) {
    el.classList.toggle("streaming", !!isStreaming);
    const md = $(".md", el);
    if (!msg.text && isStreaming) {
      md.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`;
    } else {
      md.innerHTML = renderMarkdown(msgDisplayText(msg));
      enhance(md);
    }
    const src = $(".sources", el);
    if (msg.sources && msg.sources.length) {
      src.innerHTML =
        `<span class="label">Sources</span>` +
        msg.sources
          .filter((s) => /^https?:\/\//i.test(s.uri))
          .map((s) => `<a class="src" href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">${ico("globe")}${esc(s.title)}</a>`)
          .join("");
    } else src.innerHTML = "";
    const old = $(".stopped-note", el);
    if (old) old.remove();
    if (msg.stopped) {
      const n = document.createElement("div");
      n.className = "stopped-note";
      n.textContent = "Stopped";
      $(".msg-body", el).insertBefore(n, $(".msg-actions", el));
    }
    const sp = $('[data-act="speak"]', el);
    if (sp) sp.classList.toggle("speaking", speakingId === msg.id);
  }

  function renderChat() {
    const chat = activeChat();
    const th = thread();
    th.innerHTML = "";
    chat.messages.forEach((m, i) => {
      th.appendChild(m.role === "user" ? buildUserEl(m) : buildAiEl(m, i === chat.messages.length - 1));
    });
    $("#stage").classList.toggle("empty", chat.messages.length === 0);
    th.scrollTop = th.scrollHeight;
  }

  function nearBottom() {
    const th = thread();
    return th.scrollHeight - th.scrollTop - th.clientHeight < 140;
  }
  function scrollBottom(force) {
    const th = thread();
    if (force || nearBottom()) th.scrollTop = th.scrollHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar / views                                                     */
  /* ------------------------------------------------------------------ */

  function setView(name) {
    state.view = name;
    save();
    $$("#sidebar .nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    const isAssistant = name === "assistant";
    $("#view-assistant").classList.toggle("active", isAssistant);
    $("#view-other").classList.toggle("active", !isAssistant);
    if (!isAssistant) renderOtherView(name);
    else setTimeout(() => $("#input").focus(), 50);
    document.body.classList.remove("sidebar-open");
    closePopovers();
  }

  function stats() {
    const chats = state.chats.filter((c) => c.messages.length);
    let user = 0, ai = 0, files = 0, ms = 0, msCount = 0, chars = 0;
    const byPersona = {};
    for (const c of chats) {
      for (const m of c.messages) {
        if (m.role === "user") {
          user++;
          files += (m.attachments || []).length;
        } else {
          ai++;
          chars += (m.text || "").length;
          byPersona[m.persona || "humanoid"] = (byPersona[m.persona || "humanoid"] || 0) + 1;
          if (m.ms) {
            ms += m.ms;
            msCount++;
          }
        }
      }
    }
    return { chats, user, ai, files, avgMs: msCount ? ms / msCount : 0, avgChars: ai ? chars / ai : 0, byPersona };
  }

  const statCard = (label, value, sub = "") => `<div class="stat"><span class="stat-label">${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;

  function renderOtherView(name) {
    const host = $("#view-other");
    const s = stats();
    let html = "";

    if (name === "dashboard") {
      html = `<div class="page"><h1>Dashboard</h1><p class="lead">A quick look at how you've been using ZTI on this device.</p>
        <div class="grid">
          ${statCard("Conversations", s.chats.length)}
          ${statCard("Your messages", s.user)}
          ${statCard("ZTI replies", s.ai)}
          ${statCard("Files shared", s.files)}
        </div>
        <div class="panel"><h3>Jump back in</h3>${chatTable(s.chats.slice(0, 5))}</div></div>`;
    } else if (name === "analytics") {
      const max = Math.max(1, ...Object.values(s.byPersona));
      const rows = PERSONAS.map((p) => {
        const n = s.byPersona[p.id] || 0;
        return `<div class="bar-row"><span>${p.name}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / max) * 100}%"></div></div><b>${n}</b></div>`;
      }).join("");
      html = `<div class="page"><h1>Analytics</h1><p class="lead">Replies by personality.</p>
        <div class="grid">${statCard("Total replies", s.ai)}${statCard("Avg. reply length", Math.round(s.avgChars) + " chars")}</div>
        <div class="panel"><h3>Personality usage</h3><div class="bars">${rows}</div></div></div>`;
    } else if (name === "performance") {
      html = `<div class="page"><h1>Performance</h1><p class="lead">Response speed measured in your browser.</p>
        <div class="grid">${statCard("Avg. response time", s.avgMs ? (s.avgMs / 1000).toFixed(1) + " s" : "—", "Full reply, start to finish")}
        ${statCard("Replies measured", s.ai)}${statCard("Model", "Gemini 2.5 Flash")}</div>
        <div class="panel"><h3>Tips for faster answers</h3><p class="lead" style="margin:0">Turn off Web Search when you don't need live info, keep attachments small, and use Humanoid or Professional for concise replies.</p></div></div>`;
    } else if (name === "conversions") {
      html = `<div class="page"><h1>Conversion List</h1><p class="lead">All your saved conversations. Click one to open it.</p>
        <div class="panel">${chatTable(s.chats)}</div></div>`;
    } else if (name === "alerts") {
      html = `<div class="page"><h1>Alerts</h1><p class="lead">System status and tips.</p><div class="panel" id="alertsPanel"><div class="empty-note">Checking server…</div></div></div>`;
      host.innerHTML = html;
      fetch(`${API_BASE}/api/health`)
        .then((r) => r.json())
        .then((h) => {
          const panel = $("#alertsPanel");
          if (!panel) return;
          panel.innerHTML = `
            <div class="alert-row"><span class="dot ${h.keyConfigured ? "ok" : "warn"}"></span><div><b>${h.keyConfigured ? "Gemini API key detected" : "Gemini API key missing"}</b><small style="display:block;color:var(--muted)">${h.keyConfigured ? `Server is using model ${esc(h.model)}.` : "Add GEMINI_API_KEY to your .env file and restart the server."}</small></div></div>
            <div class="alert-row"><span class="dot info"></span><div><b>Voice input works best in Chrome or Edge</b><small style="display:block;color:var(--muted)">Speech recognition needs a Chromium-based browser and a microphone permission.</small></div></div>
            <div class="alert-row"><span class="dot info"></span><div><b>Chats are stored on this device</b><small style="display:block;color:var(--muted)">Clearing browser data removes your history. Attachment contents aren't kept after a reload.</small></div></div>`;
        })
        .catch(() => {
          const panel = $("#alertsPanel");
          if (panel) panel.innerHTML = `<div class="alert-row"><span class="dot warn"></span><div><b>Can't reach the ZTI server</b><small style="display:block;color:var(--muted)">Make sure "npm start" is running.</small></div></div>`;
        });
      return;
    } else if (name === "settings") {
      html = `<div class="page"><h1>Settings</h1><p class="lead">Personalise ZTI. Everything is saved on this device.</p>
        <div class="panel">
          <div class="setting-row"><div><b>Display name</b><small>Shown in the top-right badge</small></div><input class="text-input" id="setName" value="${esc(state.prefs.userName)}" maxlength="24" /></div>
          <div class="setting-row"><div><b>Default personality</b><small>Used for new replies</small></div>
            <select class="select" id="setPersona">${PERSONAS.map((p) => `<option value="${p.id}" ${p.id === state.prefs.persona ? "selected" : ""}>${p.name}</option>`).join("")}</select></div>
          <div class="setting-row"><div><b>Light theme</b><small>Switch between dark and light</small></div><button class="switch ${state.prefs.theme === "light" ? "on" : ""}" id="setTheme" aria-label="Light theme"></button></div>
          <div class="setting-row"><div><b>Sound effects</b><small>Chimes, pops and clicks</small></div><button class="switch ${A.isMuted() ? "" : "on"}" id="setSound" aria-label="Sound effects"></button></div>
          <div class="setting-row"><div><b>Auto-speak replies</b><small>${A.ttsSupported ? "ZTI reads each answer aloud" : "Not supported in this browser"}</small></div><button class="switch ${A.getAutoSpeak() ? "on" : ""}" id="setSpeak" aria-label="Auto-speak replies"></button></div>
        </div>
        <div class="panel"><h3>Data</h3>
          <div class="setting-row"><div><b>Export all chats</b><small>Download everything as one Markdown file</small></div><button class="btn ghost" id="setExport">${ico("download")}Export</button></div>
          <div class="setting-row"><div><b>Delete all chats</b><small>This can't be undone</small></div><button class="btn danger" id="setClear">${ico("trash")}Delete</button></div>
        </div></div>`;
    } else if (name.startsWith("ch-")) {
      const label = { "ch-instagram": "Instagram", "ch-facebook": "Facebook", "ch-google": "Google" }[name];
      const icon = name.slice(3);
      html = `<div class="page"><h1>${label}</h1><p class="lead">Channel integration</p>
        <div class="panel soon"><span class="starter-ico">${ico(icon)}</span><h3>${label} is not connected</h3>
        <p>Channel integrations are a placeholder in this build. Your AI Assistant works without them.</p>
        <button class="btn ghost" data-go="assistant">Back to AI Assistant</button></div></div>`;
    }
    host.innerHTML = html;
  }

  function chatTable(chats) {
    if (!chats.length) return `<div class="empty-note">No conversations yet. Start one in AI Assistant.</div>`;
    return `<table class="table"><thead><tr><th>Title</th><th>Messages</th><th>Last active</th></tr></thead><tbody>${chats
      .map((c) => `<tr class="clickable" data-open-chat="${c.id}"><td>${esc(c.title)}</td><td>${c.messages.length}</td><td>${new Date(c.updatedAt).toLocaleString()}</td></tr>`)
      .join("")}</tbody></table>`;
  }

  function openChat(id) {
    if (!state.chats.find((c) => c.id === id)) return;
    if (streaming) stopStreaming();
    A.stopSpeaking();
    state.activeId = id;
    save();
    setView("assistant");
    renderChat();
  }

  $("#view-other").addEventListener("click", (e) => {
    const row = e.target.closest("[data-open-chat]");
    if (row) return openChat(row.dataset.openChat);
    const go = e.target.closest("[data-go]");
    if (go) return setView(go.dataset.go);
    const id = e.target.closest("button")?.id;
    if (id === "setTheme") {
      applyTheme(state.prefs.theme === "light" ? "dark" : "light");
      e.target.closest("button").classList.toggle("on", state.prefs.theme === "light");
    } else if (id === "setSound") {
      A.setMuted(!A.isMuted());
      e.target.closest("button").classList.toggle("on", !A.isMuted());
    } else if (id === "setSpeak") {
      A.setAutoSpeak(!A.getAutoSpeak());
      e.target.closest("button").classList.toggle("on", A.getAutoSpeak());
    } else if (id === "setExport") {
      const md = state.chats.filter((c) => c.messages.length).map(chatToMarkdown).join("\n\n---\n\n");
      if (!md) return toast("Nothing to export yet.");
      download("zti-all-chats.md", md);
    } else if (id === "setClear") {
      if (confirm("Delete ALL chats on this device? This can't be undone.")) {
        state.chats = [];
        state.activeId = null;
        newChat();
        save(true);
        renderChat();
        renderOtherView("settings");
        toast("All chats deleted.");
      }
    }
  });
  $("#view-other").addEventListener("input", (e) => {
    if (e.target.id === "setName") {
      state.prefs.userName = e.target.value.trim() || "Nipun";
      renderProfile();
      save();
    }
  });
  $("#view-other").addEventListener("change", (e) => {
    if (e.target.id === "setPersona") setPersona(e.target.value, false);
  });

  /* ------------------------------------------------------------------ */
  /* Header / profile / theme / audio buttons                            */
  /* ------------------------------------------------------------------ */

  function renderProfile() {
    const name = state.prefs.userName || "Nipun";
    $("#profileName").textContent = name;
    $("#profileInitial").textContent = name.charAt(0).toUpperCase();
  }

  function applyTheme(theme) {
    state.prefs.theme = theme;
    document.documentElement.dataset.theme = theme;
    $("#btnTheme").innerHTML = ico(theme === "light" ? "sun" : "moon");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#F4F2FC" : "#0B0914";
    save();
  }

  function renderMuteButton() {
    $("#btnMute").innerHTML = ico(A.isMuted() ? "volume-off" : "volume");
    $("#btnMute").title = A.isMuted() ? "Sounds off — click to unmute" : "Sounds on — click to mute";
  }

  $("#btnMute").addEventListener("click", () => {
    const muted = A.toggleMute();
    if (!muted) A.playClick();
    toast(muted ? "Sounds muted" : "Sounds on");
  });
  $("#btnTheme").addEventListener("click", () => {
    A.playClick();
    applyTheme(state.prefs.theme === "light" ? "dark" : "light");
  });
  $("#btnBell").addEventListener("click", () => setView("alerts"));
  $("#btnMessages").addEventListener("click", () => {
    setView("assistant");
    setTimeout(() => togglePopover("historyMenu"), 30);
  });
  $("#btnProfile").addEventListener("click", () => {
    const n = prompt("What should ZTI call you?", state.prefs.userName);
    if (n && n.trim()) {
      state.prefs.userName = n.trim().slice(0, 24);
      renderProfile();
      save();
    }
  });
  $("#btnUpgrade").addEventListener("click", () => toast("ZTI is free on your machine — nothing to upgrade."));
  $("#btnLogout").addEventListener("click", () => toast("Demo mode: there's no account to log out of."));
  $("#btnMenu").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  $("#backdrop").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  $("#nav").addEventListener("click", navClick);
  $$("#sidebar .nav")[1].addEventListener("click", navClick);
  function navClick(e) {
    const b = e.target.closest("[data-view]");
    if (b) setView(b.dataset.view);
  }

  /* Global search over chats */
  const searchInput = $("#globalSearch");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    const box = $("#searchResults");
    if (!q) return box.classList.add("hidden");
    const hits = state.chats
      .filter((c) => c.messages.length && (c.title.toLowerCase().includes(q) || c.messages.some((m) => (m.text || "").toLowerCase().includes(q))))
      .slice(0, 7);
    closePopovers(box);
    box.innerHTML = hits.length
      ? hits.map((c) => `<div class="hist-item"><button type="button" class="hist-open" data-open-chat="${c.id}"><b>${esc(c.title)}</b><small>${c.messages.length} messages</small></button></div>`).join("")
      : `<div class="empty-note">No chats match “${esc(q)}”</div>`;
    box.classList.remove("hidden");
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("#searchResults [data-open-chat]");
      if (first) {
        openChat(first.dataset.openChat);
        searchInput.value = "";
        $("#searchResults").classList.add("hidden");
      }
    }
  });
  $("#searchResults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-chat]");
    if (b) {
      openChat(b.dataset.openChat);
      searchInput.value = "";
      $("#searchResults").classList.add("hidden");
    }
  });

  /* ------------------------------------------------------------------ */
  /* Sub-header: New Chat, History, Share                                */
  /* ------------------------------------------------------------------ */

  $("#btnNewChat").addEventListener("click", () => {
    A.playClick();
    if (streaming) stopStreaming();
    A.stopSpeaking();
    speakingId = null;
    newChat();
    pending = [];
    renderAttachments();
    renderChat();
    $("#input").value = "";
    autosize();
    $("#input").focus();
  });

  $$("[data-pop]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      A.playClick();
      togglePopover(b.dataset.pop);
    })
  );

  function renderHistory() {
    const list = [...state.chats].filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
    $("#historyMenu").innerHTML = list.length
      ? `<div class="menu-title">Recent chats</div>` +
        list
          .map(
            (c) => `<div class="hist-item ${c.id === state.activeId ? "on" : ""}">
              <button type="button" class="hist-open" data-open-chat="${c.id}"><b>${esc(c.title)}</b><small>${c.messages.length} messages · ${new Date(c.updatedAt).toLocaleDateString()}</small></button>
              <button type="button" class="hist-del" data-del-chat="${c.id}" title="Delete chat">${ico("trash")}</button></div>`
          )
          .join("")
      : `<div class="empty-note">No past chats yet.</div>`;
  }

  $("#historyMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const del = e.target.closest("[data-del-chat]");
    if (del) {
      const id = del.dataset.delChat;
      state.chats = state.chats.filter((c) => c.id !== id);
      if (state.activeId === id) {
        if (streaming) stopStreaming();
        state.activeId = null;
        newChat();
        renderChat();
      }
      save();
      renderHistory();
      return;
    }
    const open = e.target.closest("[data-open-chat]");
    if (open) {
      openChat(open.dataset.openChat);
      closePopovers();
    }
  });

  function chatToMarkdown(chat) {
    const lines = [`# ${chat.title}`, ""];
    for (const m of chat.messages) {
      const att = (m.attachments || []).map((a) => a.name).join(", ");
      lines.push(m.role === "user" ? `**You:** ${m.text}${att ? `\n_(attached: ${att})_` : ""}` : `**ZTI:** ${m.text}`, "");
    }
    return lines.join("\n");
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $("#shareMenu").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-share]");
    if (!b) return;
    const chat = activeChat();
    if (!chat.messages.length) return toast("Nothing to share yet — send a message first.");
    const md = chatToMarkdown(chat);
    if (b.dataset.share === "copy") toast((await copyText(md)) ? "Chat copied to clipboard" : "Couldn't copy", "");
    else download(chat.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".md", md);
    closePopovers();
  });

  /* ------------------------------------------------------------------ */
  /* Composer: toggles, personality menu, quick actions                  */
  /* ------------------------------------------------------------------ */

  const input = $("#input");

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });

  function renderPills() {
    $("#pillSearch").setAttribute("aria-pressed", String(state.prefs.webSearch));
    $("#pillCode").setAttribute("aria-pressed", String(state.prefs.codeExec));
    $("#pillJson").setAttribute("aria-pressed", String(state.prefs.json));
    $("#personaBadge").textContent = personaName(state.prefs.persona);
  }

  [["#pillSearch", "webSearch"], ["#pillCode", "codeExec"], ["#pillJson", "json"]].forEach(([sel, key]) =>
    $(sel).addEventListener("click", () => {
      state.prefs[key] = !state.prefs[key];
      A.playClick();
      renderPills();
      save();
      if (key === "webSearch" && state.prefs.webSearch && state.prefs.codeExec) toast("Web Search takes priority over Code Run for this message.");
      if (key === "json" && state.prefs.json) toast("JSON mode on — tools are paused while it's active.");
    })
  );

  function setPersona(id, sound = true) {
    state.prefs.persona = id;
    if (sound) A.playClick();
    renderPills();
    save();
  }

  function renderPlusMenu() {
    $("#plusMenu").innerHTML = `
      <div class="menu-title">Personality</div>
      ${PERSONAS.map((p) => `<button type="button" class="menu-item persona-opt ${p.id === state.prefs.persona ? "on" : ""}" data-persona="${p.id}"><span class="radio"></span><span><b>${p.name}</b><small>${p.desc}</small></span></button>`).join("")}
      <div class="menu-sep"></div>
      <div class="menu-title">Quick actions</div>
      <div class="chips">${QUICK_ACTIONS.map((q, i) => `<button type="button" class="chip" data-quick="${i}">${q.label}</button>`).join("")}</div>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item switch-row" data-toggle-speak><span>Auto-Speak Replies</span><span class="switch ${A.getAutoSpeak() ? "on" : ""}"></span></button>`;
  }

  $("#plusMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    const p = e.target.closest("[data-persona]");
    if (p) {
      setPersona(p.dataset.persona);
      renderPlusMenu();
      return;
    }
    const q = e.target.closest("[data-quick]");
    if (q) {
      A.playClick();
      fillInput(QUICK_ACTIONS[Number(q.dataset.quick)].text);
      closePopovers();
      return;
    }
    if (e.target.closest("[data-toggle-speak]")) {
      if (!A.ttsSupported) return toast("Voice replies aren't supported in this browser.", "error");
      A.setAutoSpeak(!A.getAutoSpeak());
      A.playClick();
      renderPlusMenu();
      toast(A.getAutoSpeak() ? "Auto-speak on" : "Auto-speak off");
    }
  });

  function fillInput(text, focusEnd = true) {
    input.value = text;
    autosize();
    input.focus();
    if (focusEnd) {
      const pos = text.endsWith("```") ? text.length - 4 : text.length;
      input.setSelectionRange(pos, pos);
    }
  }

  $$("[data-starter]").forEach((card) =>
    card.addEventListener("click", () => {
      const s = STARTERS[card.dataset.starter];
      A.playClick();
      if (s.persona) setPersona(s.persona, false);
      if (s.webSearch) {
        state.prefs.webSearch = true;
        renderPills();
        save();
      }
      fillInput(s.text);
    })
  );

  /* ------------------------------------------------------------------ */
  /* Attachments                                                         */
  /* ------------------------------------------------------------------ */

  $("#btnFile").addEventListener("click", () => $("#fileInput").click());
  $("#btnImage").addEventListener("click", () => $("#imageInput").click());
  $("#fileInput").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
  $("#imageInput").addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  const toBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  async function addFiles(fileList) {
    for (const f of fileList) {
      if (pending.length >= MAX_FILES) {
        toast(`You can attach up to ${MAX_FILES} files per message.`, "error");
        break;
      }
      if (f.size > MAX_BYTES) {
        toast(`${f.name} is over 10 MB.`, "error");
        continue;
      }
      let mime = f.type;
      if (!mime && /\.pdf$/i.test(f.name)) mime = "application/pdf";
      try {
        if (IMAGE_TYPES.includes(mime) || mime === "application/pdf") {
          pending.push({
            id: uid(), name: f.name, mimeType: mime, kind: "inline", size: f.size,
            data: await toBase64(f), previewUrl: mime.startsWith("image/") ? URL.createObjectURL(f) : null,
          });
        } else if (mime.startsWith("text/") || TEXT_EXT.test(f.name) || mime === "application/json") {
          pending.push({ id: uid(), name: f.name, mimeType: mime || "text/plain", kind: "text", size: f.size, text: (await f.text()).slice(0, 200000) });
        } else {
          toast(`${f.name}: unsupported type. Use PNG, JPG, WEBP, PDF or a text file.`, "error");
        }
      } catch (_) {
        toast(`Couldn't read ${f.name}.`, "error");
      }
    }
    renderAttachments();
  }

  function renderAttachments() {
    $("#attachments").innerHTML = pending
      .map(
        (a) => `<div class="att" data-id="${a.id}">
          ${a.previewUrl ? `<img src="${a.previewUrl}" alt="" />` : `<span class="att-ico">${ico("file")}</span>`}
          <span class="att-meta"><b>${esc(a.name)}</b><small>${a.mimeType === "application/pdf" ? "PDF" : a.previewUrl ? "Image" : "Text"} · ${fmtSize(a.size)}</small></span>
          <button type="button" class="att-x" data-rm="${a.id}" aria-label="Remove">${ico("x")}</button></div>`
      )
      .join("");
  }
  $("#attachments").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (b) {
      pending = pending.filter((a) => a.id !== b.dataset.rm);
      renderAttachments();
    }
  });

  // Drag & drop and paste
  const composer = $("#composer");
  ["dragenter", "dragover"].forEach((t) =>
    composer.addEventListener(t, (e) => {
      e.preventDefault();
      composer.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((t) => composer.addEventListener(t, () => composer.classList.remove("dragging")));
  composer.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Voice input                                                         */
  /* ------------------------------------------------------------------ */

  const wave = $("#wave");
  for (let i = 0; i < 28; i++) {
    const s = document.createElement("span");
    s.style.setProperty("--i", i);
    wave.appendChild(s);
  }

  $("#btnMic").addEventListener("click", () => {
    if (!A.voiceInputSupported) return toast("Voice input isn't supported here. Try Chrome or Edge.", "error");
    if (A.isListening()) return A.stopListening();
    const base = input.value.trim();
    const ok = A.startListening({
      onStart: () => {
        A.playToggle(true);
        $("#btnMic").classList.add("active");
        $("#listening").classList.remove("hidden");
      },
      onTranscript: (text) => {
        input.value = base ? base + " " + text : text;
        autosize();
      },
      onEnd: () => {
        A.playToggle(false);
        $("#btnMic").classList.remove("active");
        $("#listening").classList.add("hidden");
        input.focus();
      },
      onError: (err) => {
        if (err === "not-allowed" || err === "service-not-allowed") toast("Microphone permission was blocked.", "error");
        else if (err === "no-speech") toast("Didn't catch anything — try again.");
        else if (err === "network") toast("Voice input needs an internet connection.", "error");
        else if (err !== "aborted") toast("Voice input error: " + err, "error");
      },
    });
    if (!ok) toast("Couldn't start voice input.", "error");
  });

  /* ------------------------------------------------------------------ */
  /* Sending + streaming                                                 */
  /* ------------------------------------------------------------------ */

  function setSendState(isStreaming) {
    const b = $("#btnSend");
    b.classList.toggle("stop", isStreaming);
    b.innerHTML = ico(isStreaming ? "stop" : "send");
    b.setAttribute("aria-label", isStreaming ? "Stop generating" : "Send");
  }

  function stopStreaming() {
    if (controller) controller.abort();
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (streaming) return stopStreaming();
    send();
  });

  function toWire(m) {
    return {
      role: m.role,
      text: m.text || "",
      attachments: (m.attachments || [])
        .filter((a) => a.data || a.text)
        .map((a) => (a.kind === "inline" ? { kind: "inline", mimeType: a.mimeType, data: a.data } : { kind: "text", name: a.name, text: a.text })),
    };
  }

  async function send() {
    let text = input.value.trim();
    const atts = pending.slice();
    if (!text && !atts.length) return;

    let json = state.prefs.json;
    if (/^\/json\b/i.test(text)) {
      json = true;
      text = text.replace(/^\/json\s*/i, "");
      if (!text && !atts.length) return toast("Add a request after /json, e.g. “/json list 3 fruits”.");
    }

    const chat = activeChat();
    $$(".error-note").forEach((n) => n.remove());
    const userMsg = { id: uid(), role: "user", text: text || "Please analyse the attached file(s).", attachments: atts, ts: Date.now() };
    chat.messages.push(userMsg);
    if (chat.messages.length === 1) chat.title = userMsg.text.replace(/\s+/g, " ").slice(0, 48) || "New chat";
    chat.updatedAt = Date.now();

    input.value = "";
    autosize();
    pending = [];
    renderAttachments();
    A.stopSpeaking();
    speakingId = null;
    A.playSend();

    $("#stage").classList.remove("empty");
    thread().appendChild(buildUserEl(userMsg));
    scrollBottom(true);
    save();
    await streamReply(chat, { json });
  }

  async function streamReply(chat, { json }) {
    const aiMsg = { id: uid(), role: "model", text: "", ts: Date.now(), persona: state.prefs.persona, json: !!json, sources: [] };
    const history = chat.messages.map(toWire).filter((m) => m.text || m.attachments.length);
    chat.messages.push(aiMsg);
    // Only the newest AI message shows "Retry"; rebuild earlier ones without it.
    $$(".msg.ai [data-act='regen']", thread()).forEach((b) => b.remove());
    const el = buildAiEl(aiMsg, true);
    thread().appendChild(el);
    updateAiEl(el, aiMsg, true);
    scrollBottom(true);

    streaming = true;
    controller = new AbortController();
    setSendState(true);
    const t0 = Date.now();
    let raf = 0;
    const paint = () => {
      raf = 0;
      const stick = nearBottom();
      updateAiEl(el, aiMsg, true);
      if (stick) scrollBottom(true);
    };

    let failed = null;
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: history,
          persona: state.prefs.persona,
          webSearch: state.prefs.webSearch,
          codeExec: state.prefs.codeExec,
          json: !!json,
        }),
      });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          msg = (await res.json()).error || msg;
        } catch (_) {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch (_) {
            continue;
          }
          if (evt.type === "text") {
            aiMsg.text += evt.text;
            if (!raf) raf = requestAnimationFrame(paint);
          } else if (evt.type === "sources") {
            aiMsg.sources = evt.sources;
          } else if (evt.type === "error") {
            throw new Error(evt.message || "Something went wrong.");
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") aiMsg.stopped = true;
      else failed = err.message || "Something went wrong.";
    } finally {
      if (raf) cancelAnimationFrame(raf);
      streaming = false;
      controller = null;
      setSendState(false);
    }

    // Finalise
    aiMsg.ms = Date.now() - t0;
    if (json && aiMsg.text) {
      try {
        aiMsg.text = JSON.stringify(JSON.parse(aiMsg.text), null, 2);
      } catch (_) {}
    }

    if (!aiMsg.text) {
      chat.messages = chat.messages.filter((m) => m.id !== aiMsg.id);
      el.remove();
      if (failed) showError(chat, failed, json);
      else if (aiMsg.stopped) toast("Stopped.");
      save();
      return;
    }
    chat.updatedAt = Date.now();
    updateAiEl(el, aiMsg, false);
    scrollBottom(true);
    save();
    if (failed) showError(chat, failed, json);
    else if (!aiMsg.stopped) {
      A.playDone();
      if (A.getAutoSpeak()) speakMessage(aiMsg, false);
    }
  }

  function showError(chat, message, json) {
    toast(message, "error");
    const n = document.createElement("div");
    n.className = "error-note";
    n.innerHTML = `<span>${esc(message)}</span><button type="button">Retry</button>`;
    $("button", n).addEventListener("click", () => {
      n.remove();
      streamReply(chat, { json });
    });
    thread().appendChild(n);
    scrollBottom(true);
  }

  /* ------------------------------------------------------------------ */
  /* Message actions (copy, speak, regenerate, copy code)                */
  /* ------------------------------------------------------------------ */

  function refreshSpeakButtons() {
    $$(".msg.ai", thread()).forEach((el) => $('[data-act="speak"]', el)?.classList.toggle("speaking", el.dataset.id === speakingId));
  }

  function speakMessage(msg, force = true) {
    if (!A.ttsSupported) return toast("Voice replies aren't supported in this browser.", "error");
    speakingId = msg.id;
    refreshSpeakButtons();
    const ok = A.speak(msg.text, {
      force,
      onEnd: () => {
        if (speakingId === msg.id) speakingId = null;
        refreshSpeakButtons();
      },
    });
    if (!ok) {
      speakingId = null;
      refreshSpeakButtons();
    }
  }

  thread().addEventListener("click", async (e) => {
    const codeBtn = e.target.closest(".copy-code");
    if (codeBtn) {
      const code = $("pre", codeBtn.closest(".code-block"))?.innerText || "";
      const ok = await copyText(code);
      const label = $("span", codeBtn);
      label.textContent = ok ? "Copied!" : "Failed";
      setTimeout(() => (label.textContent = "Copy Code"), 1600);
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const msgEl = btn.closest(".msg");
    const chat = activeChat();
    const msg = chat.messages.find((m) => m.id === msgEl.dataset.id);
    if (!msg) return;

    if (btn.dataset.act === "copy") {
      const ok = await copyText(msg.text);
      toast(ok ? "Reply copied" : "Couldn't copy");
    } else if (btn.dataset.act === "speak") {
      if (speakingId === msg.id) {
        A.stopSpeaking();
        speakingId = null;
        refreshSpeakButtons();
      } else speakMessage(msg, true);
    } else if (btn.dataset.act === "regen" && !streaming) {
      A.stopSpeaking();
      chat.messages = chat.messages.filter((m) => m.id !== msg.id);
      msgEl.remove();
      save();
      A.playClick();
      streamReply(chat, { json: msg.json });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  function init() {
    if (!activeChat()) {
      if (state.chats.length) state.activeId = state.chats[0].id;
      else newChat();
    }
    // Drop transient empty chats from earlier sessions (keep the active one)
    state.chats = state.chats.filter((c) => c.messages.length || c.id === state.activeId);
    applyTheme(state.prefs.theme);
    renderProfile();
    renderPills();
    renderMuteButton();
    setSendState(false);
    A.onChange(renderMuteButton);
    renderChat();
    const view = state.view && state.view !== "assistant" ? state.view : "assistant";
    setView(view);
    if (!window.marked || !window.DOMPurify) console.warn("Markdown libraries failed to load (offline?). Using plain text rendering.");
  }

  window.addEventListener("beforeunload", () => save(true));
  init();
})();
