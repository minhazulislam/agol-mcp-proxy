import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from mcp.server import Server
from mcp.server.sse import SseServerTransport
import mcp.types as types # Added to handle strict tool typing

# 1. Initialize the MCP Server
mcp = Server("agol-proxy")

# 2. Define your layers using a dictionary
AGOL_LAYERS = {
    "wwtp_phosphorus": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0/query",
    "largest_200": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0/query",
    "county_p_consumption": "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0/query",
    "p_use_ratio_ind":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0/query",
    "p_use_ratio_neighbor":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0/query",
    "corn_belt":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0/query",
    "cotton_belt":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0/query",
    "soybean_belt":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0/query",
    "spring_wheat_belt":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0/query",
    "winter_wheat_belt":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0/query"
}

# 3. Explicitly define the tool schema so the LLM knows how to use it
@mcp.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
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

# 4. Handle the actual execution when the LLM calls the tool
@mcp.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    if name != "query_arcgis":
        raise ValueError(f"Unknown tool: {name}")

    if not arguments or "layer_name" not in arguments:
        raise ValueError("Missing required argument: layer_name")

    layer_name = arguments["layer_name"]
    where_clause = arguments.get("where_clause", "1=1")
    out_fields = arguments.get("out_fields", "*")

    if layer_name not in AGOL_LAYERS:
        available = ", ".join(AGOL_LAYERS.keys())
        return [types.TextContent(type="text", text=f"Error: Layer '{layer_name}' not found. Available layers are: {available}")]
        
    target_url = AGOL_LAYERS[layer_name]
    
    params = {
        "where": where_clause,
        "outFields": out_fields,
        "f": "pjson",
        "returnGeometry": "false" 
    }
    
    response = requests.get(target_url, params=params)
    
    if response.status_code == 200:
        return [types.TextContent(type="text", text=response.text)]
    return [types.TextContent(type="text", text=f"Error hitting ArcGIS API: {response.status_code} - {response.text}")]


# 5. Configure FastAPI
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

transport = SseServerTransport("/messages")

@app.get("/sse")
async def sse(request: Request):
    async with transport.connect_sse(request.scope, request.receive, request._send) as (read_stream, write_stream):
        await mcp.run(read_stream, write_stream, mcp.create_initialization_options())

@app.post("/messages")
async def messages(request: Request):
    await transport.handle_post_message(request.scope, request.receive, request._send)
