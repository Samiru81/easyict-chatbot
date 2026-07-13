import { getIdToken, showAuthModal, subscribeAuth } from "./auth.js";

(() => {
  "use strict";

  const config = window.APP_CONFIG || {};
  const API_URL = String(config.API_URL || "").replace(/\/$/, "");
  const isConfigured = /^https:\/\/.+\.workers\.dev$/i.test(API_URL) && !API_URL.includes("YOUR-WORKER-URL");

  const elements = {
    form: document.getElementById("chatForm"),
    input: document.getElementById("questionInput"),
    send: document.getElementById("sendButton"),
    messages: document.getElementById("messages"),
    template: document.getElementById("messageTemplate"),
    grade: document.getElementById("gradeSelect"),
    theme: document.getElementById("themeToggle"),
    clear: document.getElementById("clearChat"),
    charCount: document.getElementById("charCount"),
    status: document.getElementById("apiStatus"),
    statusDot: document.getElementById("statusDot"),
    quickPrompts: Array.from(document.querySelectorAll(".quick-prompts button")),
    newChat: document.getElementById("newChat"),
    recentList: document.getElementById("recentList"),
    recentEmpty: document.getElementById("recentEmpty"),
    chatSearch: document.getElementById("chatSearch"),
    sidebar: document.getElementById("appSidebar"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    sidebarClose: document.getElementById("sidebarClose"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    booksTab: document.getElementById("booksTab"),
    booksShortcut: document.getElementById("booksShortcut"),
    welcomeTitle: document.getElementById("welcomeTitle")
  };

  const LEGACY_STORAGE_PREFIX = "easyict-chat-v2";
  const CONVERSATIONS_PREFIX = "easyict-conversations-v1";
  const MIGRATION_PREFIX = "easyict-history-migrated-v1";
  const THEME_KEY = "easyict-chat-theme";
  const GRADE_KEY = "easyict-chat-grade";
  const MAX_CONVERSATIONS = 30;
  const MAX_MESSAGES_PER_CONVERSATION = 40;

  let conversations = [];
  let currentMessages = [];
  let conversationStorageKey = "";
  let activeConversationId = null;
  let activeUser = null;
  let sending = false;

  initializeTheme();
  initializeGrade();
  bindEvents();
  autoResize();
  updateCounter();
  setComposerEnabled(false);
  subscribeAuth(handleAuthChanged);
  checkService();
  window.addEventListener("online", checkService);
  window.setInterval(checkService, 60000);

  function bindEvents() {
    elements.form.addEventListener("submit", onSubmit);
    elements.input.addEventListener("input", () => {
      autoResize();
      updateCounter();
    });
    elements.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        elements.form.requestSubmit();
      }
    });
    elements.theme.addEventListener("click", toggleTheme);
    elements.clear.addEventListener("click", clearChat);
    elements.newChat?.addEventListener("click", () => { startNewConversation(true); setSidebar(false); });
    elements.recentList?.addEventListener("click", handleRecentClick);
    elements.chatSearch?.addEventListener("input", filterRecentList);
    elements.sidebarToggle?.addEventListener("click", toggleSidebar);
    elements.sidebarClose?.addEventListener("click", () => setSidebar(false));
    elements.sidebarBackdrop?.addEventListener("click", () => setSidebar(false));
    elements.booksTab?.addEventListener("click", () => setSidebar(true));
    elements.booksShortcut?.addEventListener("click", () => setSidebar(true));
    elements.grade.addEventListener("change", () => {
      localStorage.setItem(GRADE_KEY, elements.grade.value);
      const active = getActiveConversation();
      if (active) {
        active.grade = elements.grade.value;
        active.updatedAt = Date.now();
        persistConversations();
        renderRecentList();
      }
    });

    elements.quickPrompts.forEach((button) => {
      button.addEventListener("click", () => {
        if (!activeUser) {
          showAuthModal();
          return;
        }
        elements.input.value = button.textContent.trim();
        autoResize();
        updateCounter();
        elements.input.focus();
      });
    });
  }

  function handleAuthChanged(user) {
    activeUser = user || null;
    conversations = [];
    currentMessages = [];
    conversationStorageKey = "";
    activeConversationId = null;
    clearRenderedHistory();
    renderRecentList();

    if (!activeUser) {
      if (elements.welcomeTitle) elements.welcomeTitle.textContent = "ආයුබෝවන්.";
      setComposerEnabled(false);
      elements.input.placeholder = "Chat Bot භාවිතා කිරීමට Google account එකෙන් Login වන්න...";
      return;
    }

    const firstName = String(activeUser.displayName || "").trim().split(/\s+/)[0];
    if (elements.welcomeTitle) elements.welcomeTitle.textContent = firstName ? `ආයුබෝවන්, ${firstName}.` : "ආයුබෝවන්.";

    conversationStorageKey = `${CONVERSATIONS_PREFIX}:${activeUser.uid}`;
    conversations = loadConversations();
    migrateLegacyHistory(activeUser.uid);
    renderRecentList();

    // Every fresh page open starts with a clean, empty conversation.
    startNewConversation(false);
    setComposerEnabled(true);
    elements.input.placeholder = "ඔබේ ප්‍රශ්නය මෙහි ලියන්න...";
    elements.input.focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (sending) return;

    if (!activeUser) {
      showAuthModal();
      return;
    }

    const question = elements.input.value.trim();
    if (!question) {
      elements.input.focus();
      return;
    }

    const recentHistory = currentMessages.slice(-4).map(({ role, text }) => ({ role, text }));

    ensureActiveConversation(question);
    appendMessage("user", question);
    saveTurn({ role: "user", text: question });
    elements.input.value = "";
    autoResize();
    updateCounter();

    if (!isConfigured) {
      appendMessage("assistant", "මෙම වෙබ් අඩවියේ API සැකසුම තවම අවසන් කර නැත. Cloudflare Worker URL එක `config.js` ගොනුවේ පරීක්ෂා කරන්න.", [], true);
      return;
    }

    sending = true;
    elements.send.disabled = true;
    const streamNode = appendTyping();
    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(() => requestController.abort(), 150000);

    try {
      let response = await requestChat(question, recentHistory, false, requestController.signal);
      if (response.status === 401) {
        response = await requestChat(question, recentHistory, true, requestController.signal);
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) showAuthModal();
        const requestError = new Error(data.error || `සේවා දෝෂයක් (${response.status})`);
        requestError.status = response.status;
        requestError.code = data.code || "";
        throw requestError;
      }

      const contentType = response.headers.get("content-type") || "";
      let result;

      if (contentType.includes("text/event-stream") && response.body) {
        result = await consumeChatStream(response, streamNode);
      } else {
        const data = await response.json().catch(() => ({}));
        const answer = data.answer || "පිළිතුරක් ලැබුණේ නැත.";
        updateStreamingNode(streamNode, answer, Array.isArray(data.sources) ? data.sources : []);
        result = { answer, sources: Array.isArray(data.sources) ? data.sources : [] };
      }

      if (!result.answer.trim()) throw new Error("පිළිතුරක් ලැබුණේ නැත.");
      saveTurn({ role: "assistant", text: result.answer });
      setStatus(true, "AI සේවාව සක්‍රියයි");
    } catch (error) {
      const existingText = streamNode.dataset.answer || "";
      if (existingText.trim()) {
        const note = "\n\n⚠️ සම්බන්ධතාවය අතරමඟ නතර විය. නැවත Send කර උත්සාහ කරන්න.";
        updateStreamingNode(streamNode, existingText + note, [], true);
      } else {
        showRetryError(streamNode, question, error);
      }

      const message = error instanceof Error ? error.message : String(error || "");
      setStatus(false, /Failed to fetch|NetworkError|fetch failed/i.test(message)
        ? "AI සේවාව සම්බන්ධ නැත"
        : "AI සේවාවේ තාවකාලික දෝෂයක්");
    } finally {
      window.clearTimeout(requestTimeout);
      sending = false;
      elements.send.disabled = !activeUser;
      if (activeUser) elements.input.focus();
    }
  }

  async function requestChat(question, recentHistory, forceRefresh, signal) {
    const token = await getIdToken(forceRefresh);
    if (!token) throw new Error("Google Login session එක අවසන් වී ඇත. නැවත Login වන්න.");

    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(`${API_URL}/chat`, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Authorization": `Bearer ${token}`
          },
          signal,
          body: JSON.stringify({
            question,
            grade: elements.grade.value,
            history: recentHistory
          })
        });

        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
        try { await response.body?.cancel(); } catch { /* no-op */ }
        await delay(900 * attempt);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 2) throw error;
        await delay(900 * attempt);
      }
    }
    throw lastError || new Error("AI සේවාවට සම්බන්ධ වීමට නොහැකි විය.");
  }

  async function consumeChatStream(response, node) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let sources = [];
    let streamError = null;
    let renderQueued = false;

    const queueRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        updateStreamingNode(node, answer, sources);
      });
    };

    const processBlock = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed) return;
      let payload = {};
      try { payload = JSON.parse(parsed.data || "{}"); } catch { return; }

      if (parsed.event === "delta" && typeof payload.text === "string") {
        answer += payload.text;
        node.dataset.answer = answer;
        queueRender();
      } else if (parsed.event === "sources" && Array.isArray(payload.sources)) {
        sources = payload.sources;
        queueRender();
      } else if (parsed.event === "status" && !answer) {
        setStreamingStatus(node, payload.message || "පිළිතුර සකස් කරමින්...");
      } else if (parsed.event === "error") {
        streamError = new Error(payload.error || "AI stream error");
        streamError.status = Number(payload.status || 0);
        streamError.code = payload.code || "";
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          processBlock(block);
        }
      }

      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.trim()) processBlock(buffer);
    } finally {
      try { reader.releaseLock(); } catch { /* no-op */ }
    }

    updateStreamingNode(node, answer, sources, Boolean(streamError));
    if (streamError) throw streamError;
    return { answer, sources };
  }

  function parseSseBlock(block) {
    let event = "message";
    const dataLines = [];
    for (const line of String(block || "").split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return null;
    return { event, data: dataLines.join("\n") };
  }

  function setStreamingStatus(node, message) {
    const bubble = node.querySelector(".bubble");
    bubble.innerHTML = `<span class="stream-status"><span class="typing"><i></i><i></i><i></i></span>${escapeHtml(message)}</span>`;
    scrollToBottom();
  }

  function updateStreamingNode(node, answer, sources = [], isError = false) {
    const bubble = node.querySelector(".bubble");
    const sourceBox = node.querySelector(".sources");
    node.dataset.answer = answer || "";
    bubble.innerHTML = answer ? renderMarkdown(answer) : '<span class="typing"><i></i><i></i><i></i></span>';
    bubble.classList.toggle("error-bubble", Boolean(isError));

    sourceBox.innerHTML = "";
    if (sources.length) {
      sourceBox.hidden = false;
      sources.slice(0, 8).forEach((source) => {
        const chip = document.createElement("span");
        chip.className = "source-chip";
        const page = source.page ? ` • පිටුව ${source.page}` : "";
        chip.textContent = `${source.file || "පාඩම් පොත"}${page}`;
        if (source.snippet) chip.title = source.snippet;
        sourceBox.appendChild(chip);
      });
    } else {
      sourceBox.hidden = true;
    }
    scrollToBottom();
  }


  function showRetryError(node, question, error) {
    const bubble = node.querySelector(".bubble");
    const sourceBox = node.querySelector(".sources");
    const message = friendlyError(error);
    const code = error?.code || (error?.status ? `HTTP ${error.status}` : "");

    node.dataset.answer = "";
    bubble.classList.add("error-bubble");
    bubble.innerHTML = `
      <div class="request-error-content">
        <strong>පිළිතුර ලබාගැනීමට නොහැකි විය</strong>
        <p>${escapeHtml(message)}</p>
        ${code ? `<small>${escapeHtml(String(code))}</small>` : ""}
        <button type="button" class="retry-answer-btn">↻ නැවත උත්සාහ කරන්න</button>
      </div>`;
    sourceBox.hidden = true;
    sourceBox.innerHTML = "";

    bubble.querySelector(".retry-answer-btn")?.addEventListener("click", () => {
      if (sending) return;
      node.remove();
      elements.input.value = question;
      autoResize();
      updateCounter();
      elements.form.requestSubmit();
    });
    scrollToBottom();
  }

  function setComposerEnabled(enabled) {
    elements.input.disabled = !enabled;
    elements.send.disabled = !enabled || sending;
    elements.quickPrompts.forEach((button) => { button.disabled = !enabled; });
    elements.clear.disabled = !enabled;
    if (elements.newChat) elements.newChat.disabled = !enabled;
    elements.form.classList.toggle("auth-locked", !enabled);
  }

  function appendMessage(role, text, sources = [], isError = false) {
    elements.messages.classList.add("has-conversation");
    const node = elements.template.content.firstElementChild.cloneNode(true);
    const avatar = node.querySelector(".avatar");
    const bubble = node.querySelector(".bubble");
    const sourceBox = node.querySelector(".sources");

    node.classList.add(role);
    avatar.textContent = role === "user" ? "ඔබ" : "AI";
    bubble.innerHTML = role === "assistant" ? renderMarkdown(text) : escapeHtml(text).replace(/\n/g, "<br>");
    if (isError) bubble.classList.add("error-bubble");

    if (sources.length) {
      sourceBox.hidden = false;
      sources.slice(0, 8).forEach((source) => {
        const chip = document.createElement("span");
        chip.className = "source-chip";
        const page = source.page ? ` • පිටුව ${source.page}` : "";
        chip.textContent = `${source.file || "පාඩම් පොත"}${page}`;
        if (source.snippet) chip.title = source.snippet;
        sourceBox.appendChild(chip);
      });
    }

    elements.messages.appendChild(node);
    scrollToBottom();
    return node;
  }

  function appendTyping() {
    elements.messages.classList.add("has-conversation");
    const node = elements.template.content.firstElementChild.cloneNode(true);
    node.classList.add("assistant");
    node.querySelector(".avatar").textContent = "AI";
    node.querySelector(".bubble").innerHTML = '<span class="typing" aria-label="පිළිතුර සකස් කරමින්"><i></i><i></i><i></i></span>';
    elements.messages.appendChild(node);
    scrollToBottom();
    return node;
  }

  function renderMarkdown(value) {
    let text = escapeHtml(String(value || ""));
    const codeBlocks = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      const token = `%%CODEBLOCK_${codeBlocks.length}%%`;
      codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
      return token;
    });
    text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");

    const lines = text.split("\n");
    const output = [];
    let listType = null;

    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = null;
    };

    for (const line of lines) {
      const unordered = line.match(/^\s*[-•]\s+(.+)/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
      if (unordered) {
        if (listType !== "ul") { closeList(); output.push("<ul>"); listType = "ul"; }
        output.push(`<li>${unordered[1]}</li>`);
      } else if (ordered) {
        if (listType !== "ol") { closeList(); output.push("<ol>"); listType = "ol"; }
        output.push(`<li>${ordered[1]}</li>`);
      } else {
        closeList();
        if (!line.trim()) continue;
        if (/^<h[23]>/.test(line) || /^%%CODEBLOCK_/.test(line)) output.push(line);
        else output.push(`<p>${line}</p>`);
      }
    }
    closeList();
    let html = output.join("");
    codeBlocks.forEach((block, index) => { html = html.replace(`%%CODEBLOCK_${index}%%`, block); });
    return html;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[char]));
  }

  function ensureActiveConversation(firstQuestion = "") {
    let conversation = getActiveConversation();
    if (conversation) return conversation;

    const now = Date.now();
    conversation = {
      id: createId(),
      title: makeConversationTitle(firstQuestion),
      grade: elements.grade.value,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
    currentMessages = conversation.messages;
    trimConversations();
    persistConversations();
    renderRecentList();
    return conversation;
  }

  function saveTurn(turn) {
    if (!conversationStorageKey || !activeUser) return;
    const conversation = ensureActiveConversation(turn.role === "user" ? turn.text : "");
    conversation.messages.push({ role: turn.role, text: turn.text });
    while (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) conversation.messages.shift();
    conversation.updatedAt = Date.now();
    if (!conversation.title || conversation.title === "නව සංවාදය") {
      const firstQuestion = conversation.messages.find((item) => item.role === "user")?.text || "";
      conversation.title = makeConversationTitle(firstQuestion);
    }
    currentMessages = conversation.messages;
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    persistConversations();
    renderRecentList();
  }

  function loadConversations() {
    if (!conversationStorageKey) return [];
    try {
      const stored = JSON.parse(localStorage.getItem(conversationStorageKey) || "[]");
      if (!Array.isArray(stored)) return [];
      return stored.map(normalizeConversation).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    } catch {
      return [];
    }
  }

  function normalizeConversation(value) {
    if (!value || typeof value !== "object") return null;
    const messages = Array.isArray(value.messages)
      ? value.messages
          .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.text === "string")
          .slice(-MAX_MESSAGES_PER_CONVERSATION)
      : [];
    if (!messages.length) return null;
    const createdAt = Number(value.createdAt) || Date.now();
    const updatedAt = Number(value.updatedAt) || createdAt;
    const grade = ["all", "7", "8", "9", "10", "11"].includes(String(value.grade)) ? String(value.grade) : "all";
    const firstQuestion = messages.find((item) => item.role === "user")?.text || "";
    return {
      id: String(value.id || createId()),
      title: String(value.title || makeConversationTitle(firstQuestion)).slice(0, 80),
      grade,
      createdAt,
      updatedAt,
      messages
    };
  }

  function migrateLegacyHistory(uid) {
    const migrationKey = `${MIGRATION_PREFIX}:${uid}`;
    if (localStorage.getItem(migrationKey) === "1") return;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}:${uid}`;
    try {
      const legacy = JSON.parse(localStorage.getItem(legacyKey) || "[]");
      if (Array.isArray(legacy)) {
        const messages = legacy
          .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.text === "string")
          .slice(-MAX_MESSAGES_PER_CONVERSATION);
        if (messages.length) {
          const firstQuestion = messages.find((item) => item.role === "user")?.text || "පැරණි සංවාදය";
          const now = Date.now() - 1000;
          conversations.unshift({
            id: createId(),
            title: makeConversationTitle(firstQuestion),
            grade: localStorage.getItem(GRADE_KEY) || "all",
            createdAt: now,
            updatedAt: now,
            messages
          });
          trimConversations();
          persistConversations();
        }
      }
      localStorage.removeItem(legacyKey);
      localStorage.setItem(migrationKey, "1");
    } catch {
      localStorage.setItem(migrationKey, "1");
    }
  }

  function persistConversations() {
    if (!conversationStorageKey) return;
    try {
      localStorage.setItem(conversationStorageKey, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
    } catch {
      // Ignore storage quota errors; the active chat still continues in memory.
    }
  }

  function trimConversations() {
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    if (conversations.length > MAX_CONVERSATIONS) conversations.length = MAX_CONVERSATIONS;
  }

  function getActiveConversation() {
    return conversations.find((item) => item.id === activeConversationId) || null;
  }

  function startNewConversation(focusInput = true) {
    if (sending) return;
    activeConversationId = null;
    currentMessages = [];
    clearRenderedHistory();
    renderRecentList();
    if (focusInput && activeUser) elements.input.focus();
  }

  function openConversation(id) {
    if (sending) return;
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    activeConversationId = conversation.id;
    currentMessages = conversation.messages;
    if (["all", "7", "8", "9", "10", "11"].includes(conversation.grade)) {
      elements.grade.value = conversation.grade;
      localStorage.setItem(GRADE_KEY, conversation.grade);
    }
    clearRenderedHistory();
    currentMessages.forEach((turn) => appendMessage(turn.role, turn.text));
    renderRecentList();
    elements.input.focus();
  }

  function deleteConversation(id) {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return;
    const ok = window.confirm(`“${conversation.title}” සංවාදය මකා දමන්නද?`);
    if (!ok) return;
    conversations = conversations.filter((item) => item.id !== id);
    if (activeConversationId === id) {
      activeConversationId = null;
      currentMessages = [];
      clearRenderedHistory();
    }
    persistConversations();
    renderRecentList();
  }

  function handleRecentClick(event) {
    const deleteButton = event.target.closest("[data-delete-conversation]");
    if (deleteButton) {
      event.stopPropagation();
      deleteConversation(deleteButton.dataset.deleteConversation || "");
      return;
    }
    const openButton = event.target.closest("[data-open-conversation]");
    if (openButton) {
      openConversation(openButton.dataset.openConversation || "");
      setSidebar(false);
    }
  }

  function renderRecentList() {
    if (!elements.recentList) return;
    elements.recentList.innerHTML = "";
    if (!activeUser || !conversations.length) {
      const empty = document.createElement("p");
      empty.className = "recent-empty";
      empty.textContent = activeUser ? "මෑත සංවාද තවම නැත." : "Login වූ පසු සංවාද මෙහි පෙන්වයි.";
      elements.recentList.appendChild(empty);
      return;
    }

    conversations.slice(0, 12).forEach((conversation) => {
      const row = document.createElement("div");
      row.className = "recent-item";
      row.classList.toggle("active", conversation.id === activeConversationId);

      const open = document.createElement("button");
      open.type = "button";
      open.className = "recent-open";
      open.dataset.openConversation = conversation.id;
      open.innerHTML = `<span class="recent-title">${escapeHtml(conversation.title)}</span><span class="recent-meta">${formatRecentDate(conversation.updatedAt)} · ${conversation.grade === "all" ? "7-11" : conversation.grade + " ශ්‍රේණිය"}</span>`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "recent-delete";
      remove.dataset.deleteConversation = conversation.id;
      remove.title = "සංවාදය මකන්න";
      remove.setAttribute("aria-label", `${conversation.title} සංවාදය මකන්න`);
      remove.textContent = "×";

      row.append(open, remove);
      elements.recentList.appendChild(row);
    });
    filterRecentList();
  }

  function filterRecentList() {
    if (!elements.recentList) return;
    const query = String(elements.chatSearch?.value || "").trim().toLocaleLowerCase("si-LK");
    elements.recentList.querySelectorAll(".recent-item").forEach((item) => {
      const title = String(item.querySelector(".recent-title")?.textContent || "").toLocaleLowerCase("si-LK");
      item.hidden = Boolean(query && !title.includes(query));
    });
  }

  function setSidebar(open) {
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    if (mobile) {
      document.body.classList.toggle("sidebar-open", Boolean(open));
      if (elements.sidebarBackdrop) elements.sidebarBackdrop.hidden = !open;
      elements.sidebarToggle?.setAttribute("aria-expanded", String(Boolean(open)));
      return;
    }
    document.body.classList.toggle("sidebar-collapsed", !open);
    elements.sidebarToggle?.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function toggleSidebar() {
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    if (mobile) setSidebar(!document.body.classList.contains("sidebar-open"));
    else setSidebar(document.body.classList.contains("sidebar-collapsed"));
  }

  function clearRenderedHistory() {
    elements.messages.querySelectorAll(".message:not(.welcome-message)").forEach((node) => node.remove());
    elements.messages.classList.remove("has-conversation");
    elements.messages.scrollTop = 0;
  }

  function clearChat() {
    if (!activeUser || sending) return;
    if (!activeConversationId) {
      startNewConversation(true);
      return;
    }
    deleteConversation(activeConversationId);
  }

  function createId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function makeConversationTitle(question) {
    const text = String(question || "").replace(/\s+/g, " ").trim();
    if (!text) return "නව සංවාදය";
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }

  function formatRecentDate(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString("si-LK", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("si-LK", { month: "short", day: "numeric" });
  }

  function initializeTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  }

  function initializeGrade() {
    const saved = localStorage.getItem(GRADE_KEY);
    if (["all", "7", "8", "9", "10", "11"].includes(saved)) elements.grade.value = saved;
  }

  function autoResize() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 170)}px`;
  }

  function updateCounter() {
    elements.charCount.textContent = `${elements.input.value.length}/1500`;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { elements.messages.scrollTop = elements.messages.scrollHeight; });
  }

  async function checkService() {
    if (!isConfigured) {
      setStatus(false, "API URL එක සකසා නැත");
      return;
    }
    try {
      const response = await fetch(`${API_URL}/health?t=${Date.now()}`, { method: "GET", mode: "cors", cache: "no-store" });
      if (!response.ok) throw new Error("offline");
      setStatus(true, "AI සේවාව සක්‍රියයි");
    } catch {
      setStatus(false, "AI සේවාව සම්බන්ධ නැත");
    }
  }

  function setStatus(online, label) {
    elements.status.textContent = label;
    elements.statusDot.classList.toggle("online", online);
    elements.statusDot.classList.toggle("offline", !online);
  }

  function friendlyError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    const status = Number(error?.status || 0);
    const code = String(error?.code || "");
    if (/AbortError|aborted/i.test(message) || status === 504) return "පිළිතුර සඳහා කාලය ඉක්මවා ගියේය. නැවත උත්සාහ කරන්න.";
    if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) return "අන්තර්ජාල සම්බන්ධතාවය හෝ Cloudflare Worker සම්බන්ධතාවය පරීක්ෂා කරන්න.";
    if (status === 401 || /INVALID_LOGIN|Login session/i.test(code + message)) return "Google Login session එක අවසන් වී ඇත. නැවත Login වන්න.";
    if (status === 403 || /AUTH_ERROR/i.test(code)) return "Gemini API key එක හෝ API permission එක පරීක්ෂා කරන්න.";
    if (status === 429 || /RATE_LIMIT|rate|quota/i.test(code + message)) return "AI භාවිත සීමාව තාවකාලිකව ඉක්මවා ඇත. මිනිත්තුවකින් නැවත උත්සාහ කරන්න.";
    if ([500, 502, 503, 504].includes(status) || /TEMPORARY_ERROR|temporary|තාවකාලික/i.test(code + message)) return "AI සේවාවේ තාවකාලික දෝෂයක් ඇතිවිය. ටික වේලාවකින් නැවත උත්සාහ කරන්න.";
    return message || "AI සේවාවට සම්බන්ධ වීමට නොහැකි විය.";
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
