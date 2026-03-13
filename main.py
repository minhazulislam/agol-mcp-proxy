import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import os

# ── Layer registry ────────────────────────────────────────────
AGOL_LAYERS = {
    "wwtp_phosphorus":    "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0/query",
    "largest_200":        "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0/query",
    "county_p_consumption":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0/query",
    "p_use_ratio_ind":    "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0/query",
    "p_use_ratio_neighbor":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0/query",
    "corn_belt":          "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0/query",
    "cotton_belt":        "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0/query",
    "soybean_belt":       "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0/query",
    "spring_wheat_belt":  "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0/query",
    "winter_wheat_belt":  "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0/query",
}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Health check ──────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "message": "Server is running"}

# ── List available tools (so the browser knows what's available) ──
@app.get("/tools")
async def list_tools():
    return {
        "tools": [
            {
                "name": "query_arcgis",
                "description": "Query an ArcGIS Feature Layer.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "layer_name": {
                            "type": "string",
                            "description": f"Layer to query. Options: {', '.join(AGOL_LAYERS.keys())}"
                        },
                        "where_clause": {"type": "string", "default": "1=1"},
                        "out_fields":   {"type": "string", "default": "*"}
                    },
                    "required": ["layer_name"]
                }
            }
        ]
    }

# ── Execute a tool call ───────────────────────────────────────
@app.post("/call-tool")
async def call_tool(request: Request):
    body = await request.json()
    name      = body.get("name")
    arguments = body.get("arguments", {})

    print(f"[TOOL] {name} called with {arguments}")

    if name != "query_arcgis":
        return JSONResponse({"error": f"Unknown tool: {name}"}, status_code=400)

    layer_name   = arguments.get("layer_name")
    where_clause = arguments.get("where_clause", "1=1")
    out_fields   = arguments.get("out_fields", "*")

    if not layer_name or layer_name not in AGOL_LAYERS:
        available = ", ".join(AGOL_LAYERS.keys())
        return JSONResponse({
            "content": [{"type": "text", "text": f"Error: Layer '{layer_name}' not found. Available: {available}"}]
        })

    url = AGOL_LAYERS[layer_name]
    params = {"where": where_clause, "outFields": out_fields, "f": "pjson", "returnGeometry": "false"}

    try:
        resp = requests.get(url, params=params, timeout=30)
        return {"content": [{"type": "text", "text": resp.text}]}
    except Exception as e:
        return JSONResponse({"content": [{"type": "text", "text": f"Request error: {str(e)}"}]})

# ── Serve static frontend files ───────────────────────────────
@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")