console.log("===== APP.JS LOADED =====");

let serverBaseUrl = null;
let conversationHistory = [];

let chatHistory, connectBtn, sendBtn, userInput, renderUrlInput, apiKeyInput;

function appendMessage(role, text) {
    if (!chatHistory) return;
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

window.addEventListener('DOMContentLoaded', () => {
    chatHistory    = document.getElementById('chat-history');
    connectBtn     = document.getElementById('connect-btn');
    sendBtn        = document.getElementById('send-btn');
    userInput      = document.getElementById('user-input');
    renderUrlInput = document.getElementById('render-url');
    apiKeyInput    = document.getElementById('api-key');

    chatHistory.innerHTML = '';
    appendMessage('system', 'Enter your API key and server URL, then click Connect.');

    // ── Connect ───────────────────────────────────────────────
    connectBtn.addEventListener('click', async () => {
        let url = renderUrlInput.value.trim();
        if (!url) { alert("Please enter your Render Server URL."); return; }
        if (!url.includes("://")) url = "https://" + url;
        url = url.replace(/\/+$/, "").replace(/\/sse$/, ""); // strip /sse or trailing slash

        appendMessage('system', `Connecting to ${url} ...`);
        connectBtn.disabled = true;

        try {
            const healthRes = await fetch(`${url}/health`);
            if (!healthRes.ok) throw new Error(`Server returned ${healthRes.status}`);

            const toolsRes = await fetch(`${url}/tools`);
            if (!toolsRes.ok) throw new Error(`Could not load tools: ${toolsRes.status}`);
            const toolsData = await toolsRes.json();
            const names = toolsData.tools.map(t => t.name).join(', ');

            serverBaseUrl = url;
            appendMessage('system', `Connected! Tools: ${names}`);
            userInput.disabled = false;
            sendBtn.disabled   = false;
            userInput.focus();

        } catch (err) {
            console.error("Connection error:", err);
            appendMessage('system', `Connection failed: ${err.message}`);
            connectBtn.disabled = false;
            serverBaseUrl = null;
        }
    });

    userInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    // ── Send ─────────────────────────────────────────────────
    sendBtn.addEventListener('click', async () => {
        const prompt = userInput.value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!prompt) return;
        if (!apiKey)        { alert("Please enter your Anthropic API Key."); return; }
        if (!serverBaseUrl) { alert("Please connect to the server first."); return; }

        appendMessage('user', prompt);
        userInput.value    = '';
        sendBtn.disabled   = true;
        userInput.disabled = true;
        conversationHistory.push({ role: "user", content: prompt });
        appendMessage('system', 'Claude is thinking...');

        try {
            // Send to our Render server — it handles Anthropic + ArcGIS server-side
            const res = await fetch(`${serverBaseUrl}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: apiKey,
                    messages: conversationHistory
                })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || err.error || `Server error ${res.status}`);
            }

            const data = await res.json();
            if (data.error) throw new Error(JSON.stringify(data.error));

            appendMessage('assistant', data.reply);
            conversationHistory.push({ role: "assistant", content: data.reply });

        } catch (err) {
            console.error("Error:", err);
            appendMessage('system', `Error: ${err.message}`);
        } finally {
            sendBtn.disabled   = false;
            userInput.disabled = false;
            userInput.focus();
        }
    });
});