import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

AGOL_LAYERS = {
    "wwtp_phosphorus":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0/query",
    "largest_200":         "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0/query",
    "county_p_consumption":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0/query",
    "p_use_ratio_ind":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0/query",
    "p_use_ratio_neighbor":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0/query",
    "corn_belt":           "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0/query",
    "cotton_belt":         "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0/query",
    "soybean_belt":        "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0/query",
    "spring_wheat_belt":   "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0/query",
    "winter_wheat_belt":   "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0/query",
}

SYSTEM_PROMPT = f"""You are a spatial AI assistant for an interactive ArcGIS map focused on phosphorus \
cycling, agricultural production regions, and water quality across the United States.

You can both query data AND directly control the map using your tools. When a user asks about a \
region or specific features, proactively use map control tools to zoom, highlight, or filter \
relevant layers — don't just return text.

Available layers: {', '.join(AGOL_LAYERS.keys())}

Layer descriptions:
- wwtp_phosphorus: Wastewater treatment plant phosphorus discharge data
- largest_200: Top 200 largest phosphorus-discharging facilities
- county_p_consumption: County-level average phosphorus fertilizer consumption
- p_use_ratio_ind: County phosphorus use ratio (individual facility context)
- p_use_ratio_neighbor: County phosphorus use ratio (neighborhood/surrounding context)
- corn_belt, cotton_belt, soybean_belt, spring_wheat_belt, winter_wheat_belt: Agricultural production regions

Guidance:
- Always zoom to the geographic area being discussed
- Highlight specific features when the user asks about them
- Filter layers to narrow focus when helpful
- Query data to answer quantitative questions, then summarize key insights
- Chain multiple tool calls in a single turn when appropriate (e.g. zoom + highlight + query)
"""

CLAUDE_TOOLS = [
    {
        "name": "query_arcgis",
        "description": (
            "Query an ArcGIS Feature Layer to retrieve attribute data and statistics. "
            f"Valid layer_name options: {', '.join(AGOL_LAYERS.keys())}. "
            "Use standard SQL for the where_clause."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":   {"type": "string", "description": "Name of the layer to query."},
                "where_clause": {"type": "string", "description": "SQL WHERE clause, default '1=1'"},
                "out_fields":   {"type": "string", "description": "Comma-separated field names, default '*'"},
            },
            "required": ["layer_name"],
        },
    },
    {
        "name": "zoom_to_location",
        "description": (
            "Pan and zoom the interactive map to a named geographic location or explicit WGS84 coordinates. "
            "Use this whenever the user asks about a specific place or region."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "place_name": {"type": "string", "description": "Named place to zoom to (e.g. 'Iowa', 'Mississippi River Basin', 'Gulf Coast'). Geocoded automatically."},
                "longitude":  {"type": "number", "description": "Center longitude in WGS84 (alternative to place_name)"},
                "latitude":   {"type": "number", "description": "Center latitude in WGS84 (alternative to place_name)"},
                "zoom":       {"type": "integer", "description": "Zoom level 3–18, default 6"},
            },
        },
    },
    {
        "name": "highlight_features",
        "description": (
            "Query and visually highlight matching features on the map. "
            "The map will automatically zoom to show the highlighted features."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":   {"type": "string", "description": "Layer to highlight features in."},
                "where_clause": {"type": "string", "description": "SQL WHERE clause to select features."},
            },
            "required": ["layer_name", "where_clause"],
        },
    },
    {
        "name": "filter_layer",
        "description": "Apply a definition filter to a map layer so only matching features are rendered. Use '1=1' to clear the filter.",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":   {"type": "string"},
                "where_clause": {"type": "string", "description": "SQL WHERE clause. Use '1=1' to show all features."},
            },
            "required": ["layer_name", "where_clause"],
        },
    },
    {
        "name": "toggle_layer",
        "description": "Show or hide a specific map layer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name": {"type": "string"},
                "visible":    {"type": "boolean"},
            },
            "required": ["layer_name", "visible"],
        },
    },
    {
        "name": "clear_map",
        "description": "Clear all highlights, reset all layer filters to show everything, and restore default layer visibility.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
]

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Health ──────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}

# ── Tools list ──────────────────────────────────────────────────────────────
@app.get("/tools")
async def list_tools():
    return {"tools": [{"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]} for t in CLAUDE_TOOLS]}

# ── ArcGIS helpers ──────────────────────────────────────────────────────────
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


def get_object_ids(layer_name: str, where_clause: str = "1=1") -> list:
    """Return the list of OBJECTIDs matching a where clause for a layer."""
    if layer_name not in AGOL_LAYERS:
        return []
    url = AGOL_LAYERS[layer_name]
    params = {"where": where_clause, "returnIdsOnly": "true", "f": "json"}
    try:
        resp = requests.get(url, params=params, timeout=30)
        data = resp.json()
        return data.get("objectIds") or []
    except Exception:
        return []


def geocode_place(place_name: str):
    """Return (location_dict, extent_dict) from the ArcGIS World Geocoder, or (None, None)."""
    url = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"
    params = {
        "singleLine":  place_name,
        "f":           "json",
        "maxLocations": 1,
        "outFields":   "*",
        "sourceCountry": "USA",
    }
    try:
        resp = requests.get(url, params=params, timeout=15)
        candidates = resp.json().get("candidates", [])
        if candidates:
            c = candidates[0]
            return c.get("location"), c.get("extent")
    except Exception:
        pass
    return None, None


# ── Main chat endpoint ──────────────────────────────────────────────────────
@app.post("/chat")
async def chat(request: Request):
    body     = await request.json()
    api_key  = body.get("api_key")
    messages = body.get("messages", [])

    if not api_key:
        return JSONResponse({"error": "Missing api_key"}, status_code=400)

    headers = {
        "Content-Type":      "application/json",
        "x-api-key":         api_key,
        "anthropic-version": "2023-06-01",
    }

    pending_actions = []  # map actions to send to the frontend

    for _ in range(10):
        payload = {
            "model":      "claude-3-5-sonnet-20241022",
            "max_tokens": 4096,
            "system":     SYSTEM_PROMPT,
            "tools":      CLAUDE_TOOLS,
            "messages":   messages,
        }

        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            json=payload, headers=headers, timeout=60
        )
        if not resp.ok:
            return JSONResponse({"error": resp.json()}, status_code=resp.status_code)

        data        = resp.json()
        stop_reason = data.get("stop_reason")

        if stop_reason != "tool_use":
            final = next((b["text"] for b in data["content"] if b["type"] == "text"), "")
            return {"reply": final, "actions": pending_actions}

        # Claude wants to call tools
        tool_use_blocks = [b for b in data["content"] if b["type"] == "tool_use"]
        messages.append({"role": "assistant", "content": data["content"]})

        tool_results = []
        for tu in tool_use_blocks:
            inp  = tu["input"]
            name = tu["name"]
            print(f"[TOOL] {name} {inp}")

            if name == "query_arcgis":
                result_text = run_arcgis_query(
                    inp.get("layer_name"),
                    inp.get("where_clause", "1=1"),
                    inp.get("out_fields", "*"),
                )

            elif name == "zoom_to_location":
                place = inp.get("place_name")
                if place and not inp.get("longitude"):
                    loc, ext = geocode_place(place)
                    if ext and all(k in ext for k in ("xmin", "ymin", "xmax", "ymax")):
                        pending_actions.append({
                            "type": "zoom_extent",
                            "xmin": ext["xmin"], "ymin": ext["ymin"],
                            "xmax": ext["xmax"], "ymax": ext["ymax"],
                        })
                    elif loc:
                        pending_actions.append({
                            "type":      "zoom",
                            "longitude": loc["x"],
                            "latitude":  loc["y"],
                            "zoom":      inp.get("zoom", 7),
                        })
                    result_text = f"Zoomed map to {place}"
                elif inp.get("longitude") is not None:
                    pending_actions.append({
                        "type":      "zoom",
                        "longitude": inp["longitude"],
                        "latitude":  inp["latitude"],
                        "zoom":      inp.get("zoom", 6),
                    })
                    result_text = "Zoomed map to coordinates"
                else:
                    result_text = "No location provided to zoom_to_location"

            elif name == "highlight_features":
                oids = get_object_ids(inp.get("layer_name", ""), inp.get("where_clause", "1=1"))
                if oids:
                    pending_actions.append({
                        "type":       "highlight",
                        "layer_name": inp["layer_name"],
                        "objectIds":  oids,
                    })
                    result_text = f"Highlighting {len(oids)} features in {inp['layer_name']}"
                else:
                    result_text = f"No features matched: {inp.get('where_clause', '1=1')}"

            elif name == "filter_layer":
                pending_actions.append({
                    "type":       "filter",
                    "layer_name": inp.get("layer_name"),
                    "where":      inp.get("where_clause", "1=1"),
                })
                result_text = f"Filter applied to {inp.get('layer_name')}: {inp.get('where_clause')}"

            elif name == "toggle_layer":
                pending_actions.append({
                    "type":       "toggle",
                    "layer_name": inp.get("layer_name"),
                    "visible":    inp.get("visible", True),
                })
                state       = "shown" if inp.get("visible", True) else "hidden"
                result_text = f"Layer {inp.get('layer_name')} {state}"

            elif name == "clear_map":
                pending_actions.append({"type": "clear"})
                result_text = "Map cleared"

            else:
                result_text = f"Unknown tool: {name}"

            tool_results.append({
                "type":        "tool_result",
                "tool_use_id": tu["id"],
                "content":     result_text,
            })

        messages.append({"role": "user", "content": tool_results})

    return {"reply": "Max tool iterations reached.", "actions": pending_actions}


# ── Serve frontend files ────────────────────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")
