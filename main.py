import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from mcp.server import Server
from mcp.server.sse import SseServerTransport

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

# 3. Update the tool to require a 'layer_name'
@mcp.tool()
async def query_arcgis(layer_name: str, where_clause: str = "1=1", out_fields: str = "*") -> str:
    """
    Query an ArcGIS Feature Layer. 
    Valid layer_name options: 'wwtp_phosphorus', 'largest_200', 'county_p_consumption', 'p_use_ratio_ind', 'p_use_ratio_neighbor', 'corn_belt', 'cotton_belt', 'soybean_belt', 'spring_wheat_belt', 'winter_wheat_belt'.
    Use standard SQL for the where_clause.
    """
    if layer_name not in AGOL_LAYERS:
        available = ", ".join(AGOL_LAYERS.keys())
        return f"Error: Layer '{layer_name}' not found. Available layers are: {available}"
        
    target_url = AGOL_LAYERS[layer_name]
    
    params = {
        "where": where_clause,
        "outFields": out_fields,
        "f": "pjson",
        "returnGeometry": "false" 
    }
    
    response = requests.get(target_url, params=params)
    
    if response.status_code == 200:
        return response.text
    return f"Error hitting ArcGIS API: {response.status_code} - {response.text}"


# 4. Configure FastAPI
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