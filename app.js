// Global variables
let Client, SseClientTransport;
let mcpClient = null;

// UI Elements (will be populated on DOMContentLoaded)
let chatHistory, connectBtn, sendBtn, userInput, renderUrlInput, apiKeyInput;

// Store the conversation history (Claude format)
let conversationHistory = [];

// Helper to add messages to the UI
function appendMessage(role, text) {
    if (!chatHistory) return; // UI not ready yet
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', async () => {
    console.log("DOMContentLoaded fired");
    
    // Get DOM elements
    chatHistory = document.getElementById('chat-history');
    connectBtn = document.getElementById('connect-btn');
    sendBtn = document.getElementById('send-btn');
    userInput = document.getElementById('user-input');
    renderUrlInput = document.getElementById('render-url');
    apiKeyInput = document.getElementById('api-key');
    
    console.log("DOM elements loaded:", { chatHistory: !!chatHistory, connectBtn: !!connectBtn });
    
    try {
        console.log("Loading MCP SDK...");
        const sdk = await import("https://esm.sh/@modelcontextprotocol/sdk/client/index.js");
        Client = sdk.Client;
        
        const sse = await import("https://esm.sh/@modelcontextprotocol/sdk/client/sse.js");
        SseClientTransport = sse.SseClientTransport;
        
        console.log("MCP SDK loaded successfully:", { Client: !!Client, SseClientTransport: !!SseClientTransport });
        appendMessage('system', 'SDK loaded. Ready to connect!');
        
        // Set up event listeners
        setupEventListeners();
    } catch (error) {
        console.error("Failed to load MCP SDK:", error);
        appendMessage('system', `Failed to load MCP SDK: ${error.message}`);
    }
});

// Setup all event listeners
function setupEventListeners() {
    // 1. Connect to the Python Server on Render
    connectBtn.addEventListener('click', async () => {
        let renderUrl = renderUrlInput.value.trim();
        if (!renderUrl) return alert("Please enter your Render SSE URL.");

        // Ensure URL has proper format
        if (!renderUrl.includes("://")) {
            renderUrl = "https://" + renderUrl;
        }
        if (!renderUrl.endsWith("/sse")) {
            renderUrl = renderUrl.replace(/\/$/, "") + "/sse";
        }

        appendMessage('system', 'Connecting to MCP Server...');
        connectBtn.disabled = true;

        try {
            if (!Client || !SseClientTransport) {
                throw new Error("MCP SDK not loaded yet. Please wait a moment and try again.");
            }

            console.log("Attempting to connect to:", renderUrl);
            console.log("Creating SSE transport with URL");
            
            // Create SSE transport - it should fetch from the URL
            const transport = new SseClientTransport(new URL(renderUrl));
            console.log("SSE transport created:", transport);
            
            console.log("Creating MCP Client");
            mcpClient = new Client(
                { name: "github-pages-client", version: "1.0.0" },
                { capabilities: {} }
            );
            console.log("MCP Client created");

            console.log("Connecting transport...");
            await mcpClient.connect(transport);
            console.log("Connected successfully!");
            
            appendMessage('system', 'Connected to MCP Server successfully!');
            
            console.log("Listing tools...");
            const tools = await mcpClient.listTools();
            console.log("Tools received:", tools);
            
            appendMessage('system', `Available spatial tools: ${tools.tools.map(t => t.name).join(', ')}`);

            userInput.disabled = false;
            sendBtn.disabled = false;

        } catch (error) {
            console.error("Connection error details:", error);
            console.error("Error stack:", error.stack);
            appendMessage('system', `Connection failed: ${error.message}. Check browser console for details.`);
            connectBtn.disabled = false;
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

            // Check if Claude decided to use a tool
            if (response.stop_reason === "tool_use") {
                // Find the specific tool use blocks
                const toolUseBlocks = response.content.filter(block => block.type === "tool_use");
                const textBlocks = response.content.filter(block => block.type === "text");
                
                if (textBlocks.length > 0) {
                    appendMessage('assistant', textBlocks[0].text);
                }

                appendMessage('system', `Claude requested tool: ${toolUseBlocks[0].name}. Fetching GIS data...`);
                
                conversationHistory.push({ role: "assistant", content: response.content });

                let toolResults = [];

                // Execute the tools via your Render server
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
        }
    });
}

// Helper function to handle the raw fetch request to Anthropic
async function makeAnthropicRequest(apiKey, messages, tools) {
    try {
        console.log("Making Anthropic request with", messages.length, "messages and", tools.length, "tools");
        
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                // CRITICAL: Required for frontend browser calls to Claude
                "anthropic-dangerously-allow-browser": "true" 
            },
            body: JSON.stringify({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 2048,
                messages: messages,
                tools: tools
            })
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
