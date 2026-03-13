// ============================================================
// MCP SDK is imported at the TOP LEVEL of the module.
// This guarantees Client and SseClientTransport are available
// before any button click can fire.
// ============================================================
import { Client } from "https://esm.sh/@modelcontextprotocol/sdk@1.10.1/client/index.js";
import { SseClientTransport } from "https://esm.sh/@modelcontextprotocol/sdk@1.10.1/client/sse.js";

console.log("===== APP.JS MODULE LOADED =====");
console.log("Client:", typeof Client);
console.log("SseClientTransport:", typeof SseClientTransport);

let mcpClient = null;
let conversationHistory = [];

// UI element references (set after DOM is ready)
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
    appendMessage('system', 'Ready — enter your API key and Render URL, then click Connect.');

    // ── Connect button ─────────────────────────────────────────
    connectBtn.addEventListener('click', async () => {
        let renderUrl = renderUrlInput.value.trim();
        if (!renderUrl) { alert("Please enter your Render Server URL."); return; }

        if (!renderUrl.includes("://")) renderUrl = "https://" + renderUrl;
        renderUrl = renderUrl.replace(/\/+$/, "");
        if (!renderUrl.endsWith("/sse")) renderUrl += "/sse";

        console.log("Connecting to:", renderUrl);
        appendMessage('system', `Connecting to ${renderUrl} ...`);
        connectBtn.disabled = true;

        try {
            // Dispose previous client if any
            if (mcpClient) {
                try { await mcpClient.close(); } catch (_) {}
                mcpClient = null;
            }

            const transport = new SseClientTransport(new URL(renderUrl));
            mcpClient = new Client(
                { name: "spatial-ai-client", version: "1.0.0" },
                { capabilities: {} }
            );

            await mcpClient.connect(transport);
            console.log("MCP connected!");

            const { tools } = await mcpClient.listTools();
            const names = tools.map(t => t.name).join(', ');
            appendMessage('system', `Connected! Tools available: ${names}`);

            userInput.disabled = false;
            sendBtn.disabled   = false;
            userInput.focus();

        } catch (err) {
            console.error("Connection error:", err);
            appendMessage('system', `Connection failed: ${err.message}`);
            connectBtn.disabled = false;
            mcpClient = null;
        }
    });

    // ── Enter key sends message ────────────────────────────────
    userInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    // ── Send button ────────────────────────────────────────────
    sendBtn.addEventListener('click', async () => {
        const prompt = userInput.value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!prompt) return;
        if (!apiKey)    { alert("Please enter your Anthropic API Key."); return; }
        if (!mcpClient) { alert("Please connect to the MCP server first."); return; }

        appendMessage('user', prompt);
        userInput.value    = '';
        sendBtn.disabled   = true;
        userInput.disabled = true;

        conversationHistory.push({ role: "user", content: prompt });
        appendMessage('system', 'Claude is thinking...');

        try {
            // Build tools list from MCP server
            const { tools: mcpTools } = await mcpClient.listTools();
            const claudeTools = mcpTools.map(t => ({
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
                        console.log("Calling tool:", toolUse.name, toolUse.input);
                        const result = await mcpClient.callTool({ name: toolUse.name, arguments: toolUse.input });
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: result.content[0].text
                        });
                    } catch (toolErr) {
                        console.error("Tool error:", toolErr);
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

            // Final answer
            const finalText = response.content.find(b => b.type === "text");
            if (finalText) {
                appendMessage('assistant', finalText.text);
                conversationHistory.push({ role: "assistant", content: finalText.text });
            }

        } catch (err) {
            console.error("Send error:", err);
            appendMessage('system', `Error: ${err.message}`);
        } finally {
            sendBtn.disabled   = false;
            userInput.disabled = false;
            userInput.focus();
        }
    });
});

// ── Anthropic API helper ───────────────────────────────────────
async function callClaude(apiKey, messages, tools) {
    const body = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 2048,
        messages
    };
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