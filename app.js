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
    setupNotice: document.getElementById("setupNotice"),
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

    const recentHistory = history.slice(-8).map(({ role, text }) => ({ role, text }));

    appendMessage("user", question);
    saveTurn({ role: "user", text: question });
    elements.input.value = "";
    autoResize();
    updateCounter();

    if (!isConfigured) {
      elements.setupNotice.hidden = false;
      appendMessage("assistant", "මෙම වෙබ් අඩවියේ API සැකසුම තවම අවසන් කර නැත. README ගොනුවේ පියවර අනුව Cloudflare Worker එක deploy කර `site/config.js` ගොනුවට URL එක දමන්න.", [], true);
      return;
    }

    sending = true;
    elements.send.disabled = true;
    const typingNode = appendTyping();

    try {
      let response = await requestChat(question, recentHistory, false);
      if (response.status === 401) {
        response = await requestChat(question, recentHistory, true);
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) showAuthModal();
        throw new Error(data.error || `සේවා දෝෂයක් (${response.status})`);
      }

      typingNode.remove();
      const answer = data.answer || "පිළිතුරක් ලැබුණේ නැත.";
      appendMessage("assistant", answer, Array.isArray(data.sources) ? data.sources : []);
      saveTurn({ role: "assistant", text: answer });
      setStatus(true, "AI සේවාව සක්‍රියයි");
    } catch (error) {
      typingNode.remove();
      appendMessage("assistant", `පිළිතුර ලබාගැනීමට නොහැකි විය. ${friendlyError(error)}`, [], true);
      setStatus(false, "AI සේවාව සම්බන්ධ නැත");
    } finally {
      sending = false;
      elements.send.disabled = !activeUser;
      if (activeUser) elements.input.focus();
    }
  }

  async function requestChat(question, recentHistory, forceRefresh) {
    const token = await getIdToken(forceRefresh);
    if (!token) throw new Error("Google Login session එක අවසන් වී ඇත. නැවත Login වන්න.");

    return fetch(`${API_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        question,
        grade: elements.grade.value,
        history: recentHistory
      })
    });
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
      elements.setupNotice.hidden = false;
      setStatus(false, "API URL එක සකසා නැත");
      return;
    }
    try {
      const response = await fetch(`${API_URL}/health`, { method: "GET" });
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
    if (/Failed to fetch|NetworkError/i.test(message)) return "අන්තර්ජාල සම්බන්ධතාවය හෝ API URL එක පරීක්ෂා කරන්න.";
    if (/401|Login session/i.test(message)) return "Google Login session එක අවසන් වී ඇත. නැවත Login වන්න.";
    return message;
  }
})();
