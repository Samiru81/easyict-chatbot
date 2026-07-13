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
    quickPrompts: Array.from(document.querySelectorAll(".quick-prompts button"))
  };

  const STORAGE_PREFIX = "easyict-chat-v2";
  const THEME_KEY = "easyict-chat-theme";
  const GRADE_KEY = "easyict-chat-grade";

  let history = [];
  let storageKey = "";
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
    elements.grade.addEventListener("change", () => localStorage.setItem(GRADE_KEY, elements.grade.value));

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
    history = [];
    clearRenderedHistory();

    if (!activeUser) {
      storageKey = "";
      setComposerEnabled(false);
      elements.input.placeholder = "Chat Bot භාවිතා කිරීමට Google account එකෙන් Login වන්න...";
      return;
    }

    storageKey = `${STORAGE_PREFIX}:${activeUser.uid}`;
    history = loadHistory();
    renderStoredHistory();
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

    const recentHistory = history.slice(-4).map(({ role, text }) => ({ role, text }));

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
    const requestTimeout = window.setTimeout(() => requestController.abort(), 100000);

    try {
      let response = await requestChat(question, recentHistory, false, requestController.signal);
      if (response.status === 401) {
        response = await requestChat(question, recentHistory, true, requestController.signal);
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) showAuthModal();
        throw new Error(data.error || `සේවා දෝෂයක් (${response.status})`);
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
        streamNode.remove();
        appendMessage("assistant", `පිළිතුර ලබාගැනීමට නොහැකි විය. ${friendlyError(error)}`, [], true);
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

    return fetch(`${API_URL}/chat`, {
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

  function setComposerEnabled(enabled) {
    elements.input.disabled = !enabled;
    elements.send.disabled = !enabled || sending;
    elements.quickPrompts.forEach((button) => { button.disabled = !enabled; });
    elements.clear.disabled = !enabled;
    elements.form.classList.toggle("auth-locked", !enabled);
  }

  function appendMessage(role, text, sources = [], isError = false) {
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

  function saveTurn(turn) {
    if (!storageKey) return;
    history.push(turn);
    while (history.length > 20) history.shift();
    localStorage.setItem(storageKey, JSON.stringify(history));
  }

  function loadHistory() {
    if (!storageKey) return [];
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(stored)
        ? stored.filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.text === "string")
        : [];
    } catch {
      return [];
    }
  }

  function renderStoredHistory() {
    history.forEach((turn) => appendMessage(turn.role, turn.text));
  }

  function clearRenderedHistory() {
    elements.messages.querySelectorAll(".message:not(.welcome-message)").forEach((node) => node.remove());
    scrollToBottom();
  }

  function clearChat() {
    if (!activeUser || !history.length) return;
    const ok = window.confirm("මෙම account එකේ සංවාද ඉතිහාසය සම්පූර්ණයෙන් මකා දමන්නද?");
    if (!ok) return;
    history.splice(0, history.length);
    localStorage.removeItem(storageKey);
    clearRenderedHistory();
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
    if (/AbortError|aborted/i.test(message)) return "පිළිතුර සඳහා කාලය ඉක්මවා ගියේය. නැවත උත්සාහ කරන්න.";
    if (/Failed to fetch|NetworkError/i.test(message)) return "අන්තර්ජාල සම්බන්ධතාවය හෝ API URL එක පරීක්ෂා කරන්න.";
    if (/401|Login session/i.test(message)) return "Google Login session එක අවසන් වී ඇත. නැවත Login වන්න.";
    return message;
  }
})();
