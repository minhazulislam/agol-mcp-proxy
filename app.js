/**
 * app.js — Claude AI-powered spatial assistant
 *
 * Responsibilities:
 *  1. Collect MapView references from all 4 <arcgis-map> panels
 *  2. Send chat messages to the /chat backend (Claude API proxy)
 *  3. Apply map actions returned by the backend (zoom, highlight, clear)
 *  4. Render conversation messages in the chat sidebar
 */

// ── Layer URL patterns for finding layers inside loaded web map items ────────
const LAYER_URL_PATTERNS = {
  wwtp_phosphorus:      "WWTP_Phosphorus",
  largest_200:          "Largest_200",
  county_p_consumption: "County_P_Fertilizer",
  p_use_ratio_ind:      "County_P_Use_Ratio_Individual",
  p_use_ratio_neighbor: "County_P_Use_Ratio_Neighborhood",
  corn_belt:            "Corn_Belt",
  cotton_belt:          "Cotton_Belt",
  soybean_belt:         "Soybean_Belt",
  spring_wheat_belt:    "Spring_Wheat_Belt",
  winter_wheat_belt:    "Winter_Wheat_Belt",
};

// ── Which map panels contain each layer ─────────────────────────────────────
const LAYER_TO_MAPS = {
  wwtp_phosphorus:      ["map-tl"],
  county_p_consumption: ["map-tl"],
  largest_200:          ["map-tr"],
  corn_belt:            ["map-tr"],
  cotton_belt:          ["map-tr"],
  soybean_belt:         ["map-tr"],
  spring_wheat_belt:    ["map-tr"],
  winter_wheat_belt:    ["map-tr"],
  p_use_ratio_ind:      ["map-bl"],
  p_use_ratio_neighbor: ["map-br"],
};

// ── Map panel IDs ────────────────────────────────────────────────────────────
const MAP_IDS = ["map-tl", "map-tr", "map-bl", "map-br"];

// ── State ────────────────────────────────────────────────────────────────────
const mapViews = {};            // mapId → MapView
const activeHighlights = [];   // highlight handles to clear on "clear"
let conversationHistory = [];  // multi-turn messages array for /chat

// ── Collect MapView references from web component events ─────────────────────
MAP_IDS.forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;

  el.addEventListener("arcgisViewReadyChange", (evt) => {
    const view = evt.detail?.view ?? evt.target?.view;
    if (view) {
      mapViews[id] = view;
      console.log(`[Map] ${id} ready`);
    }
  });
});

// ── Apply actions returned by the backend ─────────────────────────────────────
async function applyMapActions(actions) {
  if (!actions || actions.length === 0) return;

  for (const action of actions) {
    if (action.type === "zoom") {
      const { longitude, latitude, zoom = 7 } = action;
      for (const view of Object.values(mapViews)) {
        view.goTo({ center: [longitude, latitude], zoom }).catch(() => {});
      }

    } else if (action.type === "zoom_extent") {
      const { xmin, ymin, xmax, ymax } = action;
      for (const view of Object.values(mapViews)) {
        const { default: Extent } = await import("@arcgis/core/geometry/Extent.js");
        const extent = new Extent({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } });
        view.goTo(extent).catch(() => {});
      }

    } else if (action.type === "highlight") {
      const { layer_name, objectIds } = action;
      if (!objectIds || objectIds.length === 0) continue;

      const urlPattern = LAYER_URL_PATTERNS[layer_name];
      if (!urlPattern) continue;

      const targetMapIds = LAYER_TO_MAPS[layer_name] ?? MAP_IDS;
      for (const mapId of targetMapIds) {
        const view = mapViews[mapId];
        if (!view) continue;

        const layer = view.map.allLayers.find(
          l => l.url && l.url.includes(urlPattern)
        );
        if (!layer) continue;

        try {
          const layerView = await view.whenLayerView(layer);
          const handle = layerView.highlight(objectIds);
          activeHighlights.push(handle);
        } catch (err) {
          console.warn(`[Highlight] ${layer_name}:`, err);
        }
      }

    } else if (action.type === "clear") {
      activeHighlights.forEach(h => h.remove());
      activeHighlights.length = 0;
    }
  }
}

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
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? res.statusText);
    }

    const data = await res.json();
    const reply = data.reply ?? "";

    conversationHistory.push({ role: "assistant", content: reply });
    appendMessage("assistant", reply);

    if (data.actions?.length) {
      applyMapActions(data.actions);
      const n = data.actions.length;
      appendMessage("system-msg", `↳ Applied ${n} map action${n > 1 ? "s" : ""}`);
    }

  } catch (err) {
    appendMessage("assistant", `Error: ${err.message}`);
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
  messagesEl.innerHTML = `<div class="msg assistant">I can help you explore phosphorus cycling and agricultural data. Ask me to navigate the maps, highlight facilities or counties, query statistics, or explain what you see.</div>`;
  document.getElementById("suggestions").style.display = "";
  activeHighlights.forEach(h => h.remove());
  activeHighlights.length = 0;
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
