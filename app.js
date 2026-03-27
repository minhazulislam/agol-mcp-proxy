/**
 * app.js — Claude AI-powered chat sidebar
 *
 * The dashboard is an embedded ArcGIS Online iframe; this file handles
 * only the chat UI and communication with the /chat backend.
 */

// ── State ────────────────────────────────────────────────────────────────────
let conversationHistory = [];

// ── Chat UI helpers ───────────────────────────────────────────────────────────
const messagesEl = document.getElementById("chat-messages");
const typingEl   = document.getElementById("typing");
const inputEl    = document.getElementById("chat-input");
const sendBtn    = document.getElementById("send-btn");

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : role === "system-msg" ? "system-msg" : "assistant"}`;
  div.textContent = text;
  if (role === "user") {
    document.getElementById("suggestions").style.display = "none";
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setTyping(visible) {
  typingEl.classList.toggle("visible", visible);
  sendBtn.disabled = visible;
  inputEl.disabled = visible;
  if (visible) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Send a message ────────────────────────────────────────────────────────────
async function sendMessage(text) {
  text = text.trim();
  if (!text) return;

  appendMessage("user", text);
  inputEl.value = "";
  inputEl.style.height = "auto";
  setTyping(true);

  conversationHistory.push({ role: "user", content: text });

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversationHistory }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = (typeof body?.error === "string" ? body.error : null)
               ?? body?.detail
               ?? res.statusText
               ?? `HTTP ${res.status}`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }

    const data = await res.json();
    const reply = data.reply ?? "";

    conversationHistory.push({ role: "assistant", content: reply });
    appendMessage("assistant", reply);

  } catch (err) {
    const msg = (err instanceof Error) ? err.message : JSON.stringify(err);
    appendMessage("assistant", `Error: ${msg}`);
    conversationHistory.pop();
  } finally {
    setTyping(false);
    inputEl.focus();
  }
}

// ── Input event listeners ─────────────────────────────────────────────────────
sendBtn.addEventListener("click", () => sendMessage(inputEl.value));

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
});

// ── Suggestion chips ──────────────────────────────────────────────────────────
document.querySelectorAll(".suggestion-chip").forEach(chip => {
  chip.addEventListener("click", () => sendMessage(chip.textContent.trim()));
});

// ── Clear conversation ────────────────────────────────────────────────────────
document.getElementById("clear-btn").addEventListener("click", () => {
  conversationHistory = [];
  messagesEl.innerHTML = `<div class="msg assistant">I can help you explore phosphorus cycling and agricultural data. Ask me to query statistics, explain the data, or answer questions about facilities and counties.</div>`;
  document.getElementById("suggestions").style.display = "";
});

// ── Health check on load ──────────────────────────────────────────────────────
(async () => {
  const dot  = document.getElementById("ai-dot");
  const text = document.getElementById("ai-status-text");
  try {
    const res  = await fetch("/health");
    const data = await res.json();
    if (data.ai_ready) {
      dot.className    = "ai-status-dot ready";
      text.textContent = "AI ready";
    } else {
      dot.className    = "ai-status-dot error";
      text.textContent = "AI key missing";
    }
  } catch {
    dot.className    = "ai-status-dot error";
    text.textContent = "Server unreachable";
  }
})();
