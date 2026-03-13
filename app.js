// Global variables
let Client, SseClientTransport;
let mcpClient = null;

// Immediate logging to verify script loads
console.log("===== APP.JS SCRIPT LOADED =====");
console.log("Timestamp:", new Date().toISOString());
console.log("User Agent:", navigator.userAgent.substring(0, 50));

// UI Elements (will be populated on DOMContentLoaded)
let chatHistory, connectBtn, sendBtn, userInput, renderUrlInput, apiKeyInput;

// Store the conversation history (Claude format)
let conversationHistory = [];

// Helper to add messages to the UI
function appendMessage(role, text) {
    console.log(`appendMessage called: role=${role}, text=${text}`);
    if (!chatHistory) {
        console.warn("chatHistory not available yet");
        return;
    }
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    console.log("Message appended to UI");
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', async () => {
    console.log("DOMContentLoaded fired at", new Date().toISOString());
    
    // Get DOM elements
    chatHistory = document.getElementById('chat-history');
    connectBtn = document.getElementById('connect-btn');
    sendBtn = document.getElementById('send-btn');
    userInput = document.getElementById('user-input');
    renderUrlInput = document.getElementById('render-url');
    apiKeyInput = document.getElementById('api-key');
    
    console.log("DOM elements loaded:", { 
        chatHistory: !!chatHistory, 
        connectBtn: !!connectBtn,
        sendBtn: !!sendBtn,
        userInput: !!userInput,
        renderUrlInput: !!renderUrlInput,
        apiKeyInput: !!apiKeyInput
    });
    
    // Clear initial message and add ready message
    if (chatHistory) {
        chatHistory.innerHTML = '';
        appendMessage('system', 'Page loaded. Loading SDK...');
    }
    
    try {
        console.log("Loading MCP SDK from https://esm.sh/...");
        const sdk = await import("https://esm.sh/@modelcontextprotocol/sdk@1.10.1/client/index.js");
        Client = sdk.Client;
        console.log("Client loaded:", !!Client);
        
        const sse = await import("https://esm.sh/@modelcontextprotocol/sdk@1.10.1/client/sse.js");
        SseClientTransport = sse.SseClientTransport;
        console.log("SseClientTransport loaded:", !!SseClientTransport);
        
        appendMessage('system', 'SDK loaded successfully! Ready to connect.');
        
        // Set up event listeners
        setupEventListeners();
    } catch (error) {
        console.error("Failed to load MCP SDK:", error);
        appendMessage('system', `Failed to load MCP SDK: ${error.message}. Check browser console.`);
    }
});

// Setup all event listeners
function setupEventListeners() {
    console.log("setupEventListeners called");
    
    // 1. Connect to the Python Server on Render
    connectBtn.addEventListener('click', async () => {
        console.log("=== CONNECT BUTTON CLICKED ===");
        
        let renderUrl = renderUrlInput.value.trim();
        console.log("Render URL entered:", renderUrl);
        
        if (!renderUrl) {
            alert("Please enter your Render SSE URL.");
            return;
        }

        // Ensure URL has proper format
        if (!renderUrl.includes("://")) {
            renderUrl = "https://" + renderUrl;
        }
        if (!renderUrl.endsWith("/sse")) {
            renderUrl = renderUrl.replace(/\/$/, "") + "/sse";
        }

        console.log("Normalized URL:", renderUrl);
        appendMessage('system', 'Connecting to MCP Server...');
        connectBtn.disabled = true;

        try {
            if (!Client || !SseClientTransport) {
                throw new Error("MCP SDK not loaded yet. Please wait a moment and try again.");
            }

            console.log("Attempting to connect to:", renderUrl);
            
            // Create SSE transport
            const transport = new SseClientTransport(new URL(renderUrl));
            console.log("SSE transport created successfully");
            
            mcpClient = new Client(
                { name: "spatial-ai-client", version: "1.0.0" },
                { capabilities: {} }
            );
            console.log("MCP Client created");

            await mcpClient.connect(transport);
            appendMessage('system', 'Connected to MCP Server!');
            console.log("Connected successfully!");
            
            const toolsResponse = await mcpClient.listTools();
            console.log("Tools received:", toolsResponse);
            
            if (toolsResponse.tools && toolsResponse.tools.length > 0) {
                const toolNames = toolsResponse.tools.map(t => t.name).join(', ');
                appendMessage('system', `Ready! Available tools: ${toolNames}`);
            } else {
                appendMessage('system', 'Connected but no tools available');
            }

            // Enable input
            userInput.disabled = false;
            sendBtn.disabled = false;

        } catch (error) {
            console.error("=== CONNECTION ERROR ===");
            console.error("Error message:", error.message);
            console.error("Error stack:", error.stack);
            appendMessage('system', `Connection failed: ${error.message}. Check browser console for details.`);
            connectBtn.disabled = false;
            mcpClient = null;
            
            // Health check for diagnostics
            try {
                const baseUrl = renderUrlInput.value.trim().replace(/\/sse$/, '').replace(/\/$/, '');
                const healthUrl = baseUrl.includes("://") ? baseUrl : "https://" + baseUrl;
                console.log("Attempting health check at:", healthUrl + "/health");
                const healthResponse = await fetch(healthUrl + "/health");
                const healthData = await healthResponse.json();
                console.log("Health check response:", healthData);
                appendMessage('system', `Server is reachable (/health OK) but SSE connection failed. This is likely a CORS or protocol issue.`);
            } catch (healthError) {
                console.error("Health check also failed:", healthError);
                appendMessage('system', `Cannot reach server. Check URL and ensure your Render service is running.`);
            }
        }
    });

    // Handle Enter key in user input
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });

    // 2. Handle sending messages (Claude Integration)
    sendBtn.addEventListener('click', async () => {
        const prompt = userInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        
        if (!prompt) return;
        if (!apiKey) return alert("Please enter your Anthropic API Key first.");
        if (!mcpClient) return alert("Please connect to the MCP server first.");

        appendMessage('user', prompt);
        userInput.value = '';
        sendBtn.disabled = true;
        userInput.disabled = true;
        
        // Add user message to history
        conversationHistory.push({ role: "user", content: prompt });
        appendMessage('system', 'Claude is thinking...');

        try {
            console.log("Sending prompt to Claude...");
            
            // Fetch and format tools for Claude
            const mcpToolsResult = await mcpClient.listTools();
            const claudeTools = mcpToolsResult.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema
            }));

            // Make the initial request to Claude
            let response = await makeAnthropicRequest(apiKey, conversationHistory, claudeTools);

            // Agentic loop: keep running while Claude wants to use tools
            while (response.stop_reason === "tool_use") {
                const toolUseBlocks = response.content.filter(block => block.type === "tool_use");
                const textBlocks = response.content.filter(block => block.type === "text");
                
                if (textBlocks.length > 0) {
                    appendMessage('assistant', textBlocks[0].text);
                }

                appendMessage('system', `Claude is using tool: ${toolUseBlocks.map(t => t.name).join(', ')}. Fetching GIS data...`);
                
                conversationHistory.push({ role: "assistant", content: response.content });

                const toolResults = [];

                for (const toolUse of toolUseBlocks) {
                    try {
                        console.log("Executing tool:", toolUse.name, "with arguments:", toolUse.input);
                        const toolResult = await mcpClient.callTool({
                            name: toolUse.name,
                            arguments: toolUse.input
                        });

                        console.log("Tool result received:", toolResult);

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: toolResult.content[0].text
                        });
                    } catch (toolError) {
                        console.error("Tool execution error:", toolError);
                        appendMessage('system', `Tool error for ${toolUse.name}: ${toolError.message}`);
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: toolUse.id,
                            content: `Error: ${toolError.message}`,
                            is_error: true
                        });
                    }
                }

                conversationHistory.push({ role: "user", content: toolResults });

                appendMessage('system', 'Data retrieved. Claude is analyzing the results...');
                response = await makeAnthropicRequest(apiKey, conversationHistory, claudeTools);
            }

            // Extract and display the final text answer
            const finalContent = response.content.find(block => block.type === "text");
            if (finalContent) {
                appendMessage('assistant', finalContent.text);
                conversationHistory.push({ role: "assistant", content: finalContent.text });
            } else {
                appendMessage('system', 'No text response from Claude');
            }

        } catch (error) {
            console.error("User prompt error:", error);
            appendMessage('system', `Error: ${error.message}`);
        } finally {
            sendBtn.disabled = false;
            userInput.disabled = false;
            userInput.focus();
        }
    });
}

// Helper function to handle the raw fetch request to Anthropic
async function makeAnthropicRequest(apiKey, messages, tools) {
    try {
        console.log("Making Anthropic request with", messages.length, "messages and", tools.length, "tools");
        
        const body = {
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 2048,
            messages: messages,
        };

        // Only include tools if there are any (avoids API error on empty array)
        if (tools && tools.length > 0) {
            body.tools = tools;
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-allow-browser": "true"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.json();
            console.error("Anthropic API error response:", err);
            throw new Error(err.error?.message || `HTTP ${response.status}: Failed to connect to Claude`);
        }

        const data = await response.json();
        console.log("Anthropic response received:", data);
        return data;
    } catch (error) {
        console.error("Anthropic request failed:", error);
        throw error;
    }
}