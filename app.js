// No MCP SDK needed — we talk directly to our FastAPI REST endpoints
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
        url = url.replace(/\/+$/, "");  // strip trailing slashes

        appendMessage('system', `Connecting to ${url} ...`);
        connectBtn.disabled = true;

        try {
            // Hit /health to verify server is up
            const healthRes = await fetch(`${url}/health`);
            if (!healthRes.ok) throw new Error(`Server returned ${healthRes.status}`);
            await healthRes.json();

            // Fetch available tools
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

    // Enter key support
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
            // Load tools from server
            const toolsData = await fetch(`${serverBaseUrl}/tools`).then(r => r.json());
            const claudeTools = toolsData.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema
            }));

            let response = await callClaude(apiKey, conversationHistory, claudeTools);

            // Agentic tool-use loop
            while (response.stop_reason === "tool_use") {
                const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
                const textBlocks    = response.content.filter(b => b.type === "text");

                if (textBlocks.length > 0) appendMessage('assistant', textBlocks[0].text);
                appendMessage('system', `Using tool: ${toolUseBlocks.map(t => t.name).join(', ')}...`);

                conversationHistory.push({ role: "assistant", content: response.content });

                const toolResults = [];
                for (const toolUse of toolUseBlocks) {
                    try {
                        // Call our simple REST endpoint instead of MCP SSE
                        const res = await fetch(`${serverBaseUrl}/call-tool`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: toolUse.name, arguments: toolUse.input })
                        });
                        const result = await res.json();
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: result.content[0].text
                        });
                    } catch (toolErr) {
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: `Error: ${toolErr.message}`,
                            is_error: true
                        });
                    }
                }

                conversationHistory.push({ role: "user", content: toolResults });
                appendMessage('system', 'Data received. Claude is analyzing...');
                response = await callClaude(apiKey, conversationHistory, claudeTools);
            }

            const finalText = response.content.find(b => b.type === "text");
            if (finalText) {
                appendMessage('assistant', finalText.text);
                conversationHistory.push({ role: "assistant", content: finalText.text });
            }

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

async function callClaude(apiKey, messages, tools) {
    const body = { model: "claude-3-5-sonnet-20241022", max_tokens: 2048, messages };
    if (tools && tools.length > 0) body.tools = tools;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-allow-browser": "true"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    return res.json();
}