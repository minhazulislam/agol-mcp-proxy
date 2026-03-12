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
    const renderUrl = renderUrlInput.value.trim();
    if (!renderUrl) return alert("Please enter your Render SSE URL.");

    appendMessage('system', 'Connecting to MCP Server...');
    connectBtn.disabled = true;

    try {
        // Set up the SSE transport pointing to your FastAPI backend
        const transport = new SseClientTransport(new URL(renderUrl));
        
        mcpClient = new Client(
            { name: "github-pages-client", version: "1.0.0" },
            { capabilities: {} }
        );

        await mcpClient.connect(transport);
        appendMessage('system', 'Connected to MCP Server successfully!');
        
        // Fetch the available tools (e.g., query_arcgis) to verify it works
        const tools = await mcpClient.listTools();
        appendMessage('system', `Available spatial tools: ${tools.tools.map(t => t.name).join(', ')}`);

        // Enable the chat input
        userInput.disabled = false;
        sendBtn.disabled = false;

    } catch (error) {
        appendMessage('system', `Connection failed: ${error.message}`);
        connectBtn.disabled = false;
    }
});

// Store the conversation history
let conversationHistory = [];

sendBtn.addEventListener('click', async () => {
    const prompt = userInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    
    if (!prompt) return;
    if (!apiKey) return alert("Please enter your OpenAI API Key first.");

    // Display user message
    appendMessage('user', prompt);
    userInput.value = '';
    
    // Add to history
    conversationHistory.push({ role: "user", content: prompt });
    appendMessage('system', 'Thinking...');

    try {
        // 1. Fetch available tools from your Render server
        const mcpToolsResult = await mcpClient.listTools();
        
        // 2. Format MCP tools into the format OpenAI expects
        const openAITools = mcpToolsResult.tools.map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema // MCP uses standard JSON schema, which OpenAI loves
            }
        }));

        // 3. Make the initial request to the LLM
        let response = await makeOpenAIRequest(apiKey, conversationHistory, openAITools);
        let message = response.choices[0].message;

        // 4. Check if the LLM wants to use your ArcGIS tool
        if (message.tool_calls) {
            appendMessage('system', `LLM requested tool: ${message.tool_calls[0].function.name}. Fetching spatial data...`);
            
            // Add the LLM's tool request to the history
            conversationHistory.push(message);

            for (const toolCall of message.tool_calls) {
                // Parse the arguments the LLM generated (e.g., layer_name: "watersheds")
                const toolArgs = JSON.parse(toolCall.function.arguments);
                
                // 5. Execute the tool on your Render server via MCP
                const toolResult = await mcpClient.callTool({
                    name: toolCall.function.name,
                    arguments: toolArgs
                });

                // Extract the text content from the MCP result
                const resultText = toolResult.content[0].text;

                // 6. Add the ArcGIS data back into the conversation history
                conversationHistory.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: resultText
                });
            }

            // 7. Send the data back to the LLM for the final answer
            appendMessage('system', 'Data retrieved. Formulating final answer...');
            response = await makeOpenAIRequest(apiKey, conversationHistory, openAITools);
            message = response.choices[0].message;
        }

        // 8. Display the final answer
        appendMessage('assistant', message.content);
        conversationHistory.push({ role: "assistant", content: message.content });

    } catch (error) {
        console.error(error);
        appendMessage('system', `Error: ${error.message}`);
    }
});

// Helper function to handle the raw fetch request to OpenAI
async function makeOpenAIRequest(apiKey, messages, tools) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "gpt-4o-mini", // Fast and cheap for tool calling
            messages: messages,
            tools: tools,
            tool_choice: "auto"
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Failed to connect to LLM");
    }

    return await response.json();
}