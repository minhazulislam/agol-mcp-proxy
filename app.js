// Import the MCP SDK directly via URL for static hosting
import { Client } from "https://esm.sh/@modelcontextprotocol/sdk/client/index.js";
import { SseClientTransport } from "https://esm.sh/@modelcontextprotocol/sdk/client/sse.js";

// UI Elements
const chatHistory = document.getElementById('chat-history');
const connectBtn = document.getElementById('connect-btn');
const sendBtn = document.getElementById('send-btn');
const userInput = document.getElementById('user-input');
const renderUrlInput = document.getElementById('render-url');
const apiKeyInput = document.getElementById('api-key');

let mcpClient = null;

// Helper to add messages to the UI
function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

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
        console.log("Attempting to connect to:", renderUrl);
        
        // Create SSE transport correctly - pass the URL string to fetch
        const transport = new SseClientTransport({
            url: new URL(renderUrl)
        });
        
        mcpClient = new Client(
            { name: "github-pages-client", version: "1.0.0" },
            { capabilities: {} }
        );

        await mcpClient.connect(transport);
        appendMessage('system', 'Connected to MCP Server successfully!');
        
        const tools = await mcpClient.listTools();
        appendMessage('system', `Available spatial tools: ${tools.tools.map(t => t.name).join(', ')}`);

        userInput.disabled = false;
        sendBtn.disabled = false;

    } catch (error) {
        console.error("Connection error details:", error);
        appendMessage('system', `Connection failed: ${error.message}. Check browser console for details.`);
        connectBtn.disabled = false;
    }
});

// Store the conversation history (Claude format)
let conversationHistory = [];

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
            input_schema: tool.inputSchema // MCP schema maps cleanly to Claude's input_schema
        }));

        // Make the initial request to Claude
        let response = await makeAnthropicRequest(apiKey, conversationHistory, claudeTools);

        // Check if Claude decided to use a tool
        if (response.stop_reason === "tool_use") {
            // Find the specific tool use blocks (Claude can return text + tool blocks together)
            const toolUseBlocks = response.content.filter(block => block.type === "tool_use");
            const textBlocks = response.content.filter(block => block.type === "text");
            
            // If Claude included conversational text before using the tool, display it
            if (textBlocks.length > 0) {
                appendMessage('assistant', textBlocks[0].text);
            }

            appendMessage('system', `Claude requested tool: ${toolUseBlocks[0].name}. Fetching GIS data...`);
            
            // Claude requires the exact tool request added to the history as an 'assistant' role
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

                    // Package the result in Claude's specific tool_result format
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

            // Append the raw GIS data back to the history as a 'user' message
            conversationHistory.push({ role: "user", content: toolResults });

            // Send the data back to Claude for the final synthesized answer
            appendMessage('system', 'Data retrieved. Claude is analyzing the results...');
            response = await makeAnthropicRequest(apiKey, conversationHistory, claudeTools);
        }

        // Extract and display the final text answer
        const finalContent = response.content.find(block => block.type === "text");
        if (finalContent) {
            appendMessage('assistant', finalContent.text);
            
            // Save the final answer to history
            conversationHistory.push({ role: "assistant", content: finalContent.text });
        } else {
            appendMessage('system', 'No text response from Claude');
        }

    } catch (error) {
        console.error("User prompt error:", error);
        appendMessage('system', `Error: ${error.message}`);
    }
});

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
