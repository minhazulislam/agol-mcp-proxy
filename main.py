import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import os

AGOL_LAYERS = {
    "wwtp_phosphorus":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0",
    "largest_200":         "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0",
    "county_p_consumption":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0",
    "p_use_ratio_ind":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0",
    "p_use_ratio_neighbor":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0",
    "corn_belt":           "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0",
    "cotton_belt":         "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0",
    "soybean_belt":        "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0",
    "spring_wheat_belt":   "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0",
    "winter_wheat_belt":   "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0",
}

CLAUDE_TOOLS = [
    {
        "name": "query_arcgis",
        "description": (
            "Query an ArcGIS Feature Layer. "
            f"Valid layer_name options: {', '.join(AGOL_LAYERS.keys())}. "
            "Use standard SQL for the where_clause."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":   {"type": "string", "description": "Layer to query."},
                "where_clause": {"type": "string", "default": "1=1"},
                "out_fields":   {"type": "string", "default": "*"},
            },
            "required": ["layer_name"],
        },
    }
]

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Health ────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}

# ── Tools list (for the browser to show what's available) ─────
@app.get("/tools")
async def list_tools():
    return {"tools": [{"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]} for t in CLAUDE_TOOLS]}

# ── ArcGIS query (internal helper, also called by /chat) ──────
def run_arcgis_query(layer_name: str, where_clause: str = "1=1", out_fields: str = "*") -> str:
    if layer_name not in AGOL_LAYERS:
        return f"Error: Layer '{layer_name}' not found. Available: {', '.join(AGOL_LAYERS.keys())}"
    url = AGOL_LAYERS[layer_name]
    params = {"where": where_clause, "outFields": out_fields, "f": "pjson", "returnGeometry": "false"}
    try:
        resp = requests.get(url, params=params, timeout=30)
        return resp.text
    except Exception as e:
        return f"Request error: {str(e)}"

# ── Main chat endpoint — proxies Anthropic API server-side ────
@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    api_key  = body.get("api_key")
    messages = body.get("messages", [])

    if not api_key:
        return JSONResponse({"error": "Missing api_key"}, status_code=400)

    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }

    # Agentic loop: keep going while Claude wants to use tools
    for _ in range(10):  # max 10 tool calls per turn
        payload = {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 2048,
            "tools": CLAUDE_TOOLS,
            "messages": messages,
        }

        resp = requests.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers, timeout=60)
        if not resp.ok:
            return JSONResponse({"error": resp.json()}, status_code=resp.status_code)

        data = resp.json()
        stop_reason = data.get("stop_reason")

        if stop_reason != "tool_use":
            # Final answer — return it
            final = next((b["text"] for b in data["content"] if b["type"] == "text"), "")
            return {"reply": final}

        # Claude wants to use a tool — execute it server-side
        tool_use_blocks = [b for b in data["content"] if b["type"] == "tool_use"]
        messages.append({"role": "assistant", "content": data["content"]})

        tool_results = []
        for tu in tool_use_blocks:
            print(f"[TOOL] {tu['name']} {tu['input']}")
            if tu["name"] == "query_arcgis":
                result_text = run_arcgis_query(
                    tu["input"].get("layer_name"),
                    tu["input"].get("where_clause", "1=1"),
                    tu["input"].get("out_fields", "*"),
                )
            else:
                result_text = f"Unknown tool: {tu['name']}"

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu["id"],
                "content": result_text,
            })

        messages.append({"role": "user", "content": tool_results})

    return {"reply": "Max tool iterations reached."}

# ── Serve frontend files ──────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")