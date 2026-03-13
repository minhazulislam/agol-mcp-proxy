import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.requests import Request
from mcp.server import Server
from mcp.server.sse import SseServerTransport
import mcp.types as types
import os

# 1. Initialize the MCP Server
mcp = Server("agol-proxy")

# 2. Define your layers using a dictionary
AGOL_LAYERS = {
    "wwtp_phosphorus": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0/query",
    "largest_200": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0/query",
    "county_p_consumption": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0/query",
    "p_use_ratio_ind": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0/query",
    "p_use_ratio_neighbor": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0/query",
    "corn_belt": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0/query",
    "cotton_belt": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0/query",
    "soybean_belt": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0/query",
    "spring_wheat_belt": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0/query",
    "winter_wheat_belt": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0/query"
}

# 3. Define tool schema
@mcp.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    print("[MCP] Listing tools...")
    tools = [
        types.Tool(
            name="query_arcgis",
            description="Query an ArcGIS Feature Layer. Valid layer_name options: 'wwtp_phosphorus', 'largest_200', 'county_p_consumption', 'p_use_ratio_ind', 'p_use_ratio_neighbor', 'corn_belt', 'cotton_belt', 'soybean_belt', 'spring_wheat_belt', 'winter_wheat_belt'. Use standard SQL for the where_clause.",
            inputSchema={
                "type": "object",
                "properties": {
                    "layer_name": {
                        "type": "string",
                        "description": "The name of the layer to query."
                    },
                    "where_clause": {
                        "type": "string",
                        "description": "SQL where clause, default is '1=1'",
                        "default": "1=1"
                    },
                    "out_fields": {
                        "type": "string",
                        "description": "Fields to return, default is '*'",
                        "default": "*"
                    }
                },
                "required": ["layer_name"]
            }
        )
    ]
    print(f"[MCP] Returning {len(tools)} tools")
    return tools

# 4. Handle tool execution
@mcp.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    print(f"[MCP] Tool called: {name} with arguments: {arguments}")
    
    if name != "query_arcgis":
        raise ValueError(f"Unknown tool: {name}")

    if not arguments or "layer_name" not in arguments:
        raise ValueError("Missing required argument: layer_name")

    layer_name = arguments["layer_name"]
    where_clause = arguments.get("where_clause", "1=1")
    out_fields = arguments.get("out_fields", "*")

    if layer_name not in AGOL_LAYERS:
        available = ", ".join(AGOL_LAYERS.keys())
        error_msg = f"Error: Layer '{layer_name}' not found. Available layers are: {available}"
        return [types.TextContent(type="text", text=error_msg)]
        
    target_url = AGOL_LAYERS[layer_name]
    print(f"[MCP] Querying {target_url} with where={where_clause}, fields={out_fields}")
    
    params = {
        "where": where_clause,
        "outFields": out_fields,
        "f": "pjson",
        "returnGeometry": "false"
    }
    
    response = requests.get(target_url, params=params)
    
    if response.status_code == 200:
        return [types.TextContent(type="text", text=response.text)]
    
    error_msg = f"Error hitting ArcGIS API: {response.status_code} - {response.text}"
    return [types.TextContent(type="text", text=error_msg)]


# 5. Configure FastAPI
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health check endpoint (define BEFORE static mount to avoid conflicts)
@app.get("/health")
async def health():
    return {"status": "ok", "message": "MCP Server is running"}

# SSE transport
transport = SseServerTransport("/messages")

@app.get("/sse")
async def sse_endpoint(request: Request):
    print(f"[SSE] New SSE connection from {request.client}")
    try:
        async with transport.connect_sse(request.scope, request.receive, request._send) as (read_stream, write_stream):
            print("[SSE] Transport connected, running MCP server...")
            await mcp.run(read_stream, write_stream, mcp.create_initialization_options())
            print("[SSE] MCP run completed")
    except Exception as e:
        print(f"[SSE] Error during SSE connection: {e}")
        import traceback
        traceback.print_exc()
        raise

@app.post("/messages")
async def messages_endpoint(request: Request):
    print(f"[SSE] POST /messages from {request.client}")
    try:
        await transport.handle_post_message(request.scope, request.receive, request._send)
    except Exception as e:
        print(f"[SSE] Error handling POST message: {e}")
        import traceback
        traceback.print_exc()
        raise

# Root endpoint - serve index.html
@app.get("/")
async def root():
    return FileResponse("index.html")

# Serve app.js directly at /app.js (so index.html's <script src="app.js"> works)
@app.get("/app.js")
async def serve_app_js():
    return FileResponse("app.js", media_type="application/javascript")

# Serve any other static files from current directory as fallback
@app.get("/{filename}")
async def serve_static(filename: str):
    if os.path.exists(filename) and not filename.startswith("."):
        return FileResponse(filename)
    return {"error": "File not found"}, 404