import os
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# ── Claude API key from Render environment variable ─────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── ArcGIS feature service endpoints ────────────────────────────────────────
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

SYSTEM_PROMPT = f"""You are a spatial AI assistant for an interactive 4-panel phosphorus mapping dashboard.

The dashboard shows 4 synchronized map panels:
- Top-left:     USA WWTPs Treatment Design Capacity overlaid on Agricultural P Fertilizer Consumption
                (layers: wwtp_phosphorus, county_p_consumption)
- Top-right:    Largest 200 WWTPs Sewage Sludge Phosphorus overlaid on US Agricultural Belts
                (layers: largest_200, corn_belt, cotton_belt, soybean_belt, spring_wheat_belt, winter_wheat_belt)
- Bottom-left:  P Use Ratio (Individual County)
                (layer: p_use_ratio_ind)
- Bottom-right: P Use Ratio (Neighborhood County)
                (layer: p_use_ratio_neighbor)

Available layers: {', '.join(AGOL_LAYERS.keys())}

When a user asks about a place or region, use zoom_to_location to move all maps there.
When asked about specific facilities or counties, use highlight_features to highlight them.
Use query_arcgis to retrieve data and give precise, quantitative answers.
Chain multiple tools in a single turn when needed (e.g. zoom + highlight + query).

IMPORTANT — keep queries small to avoid token limits:
- For "how many" questions always set return_count_only=true.
- Always specify only the fields you need in out_fields (never use * unless necessary).
- Use a specific where_clause to filter rows; avoid returning thousands of records.
"""

CLAUDE_TOOLS = [
    {
        "name": "query_arcgis",
        "description": (
            "Query an ArcGIS Feature Layer to retrieve attribute data. "
            "Use return_count_only=true for 'how many' questions (returns just a count, no records). "
            "Use a specific where_clause and limited out_fields to keep responses concise. "
            f"Valid layer_name values: {', '.join(AGOL_LAYERS.keys())}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":        {"type": "string"},
                "where_clause":      {"type": "string", "description": "SQL WHERE clause, default '1=1'"},
                "out_fields":        {"type": "string", "description": "Comma-separated field names, default '*'. Use only the fields you need."},
                "return_count_only": {"type": "boolean", "description": "Return only the feature count — use for 'how many' questions"},
                "max_records":       {"type": "integer", "description": "Max records to return (default 50, max 200)"},
            },
            "required": ["layer_name"],
        },
    },
    {
        "name": "zoom_to_location",
        "description": "Zoom all 4 map panels to a named location or coordinates.",
        "input_schema": {
            "type": "object",
            "properties": {
                "place_name": {"type": "string", "description": "e.g. 'Iowa', 'Gulf Coast', 'Mississippi River Basin'"},
                "longitude":  {"type": "number"},
                "latitude":   {"type": "number"},
                "zoom":       {"type": "integer", "description": "Zoom level 3–18, default 6"},
            },
        },
    },
    {
        "name": "highlight_features",
        "description": "Highlight features matching a SQL filter on the relevant map panel.",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer_name":   {"type": "string"},
                "where_clause": {"type": "string"},
            },
            "required": ["layer_name", "where_clause"],
        },
    },
    {
        "name": "clear_map",
        "description": "Remove all highlights from the maps.",
        "input_schema": {"type": "object", "properties": {}},
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

# ── Helpers ──────────────────────────────────────────────────────────────────
MAX_QUERY_CHARS = 4_000   # keep tool results small
MAX_HISTORY_MSGS = 6      # only last 3 user+assistant pairs sent to Claude

def run_arcgis_query(
    layer_name: str,
    where_clause: str = "1=1",
    out_fields: str = "*",
    return_count_only: bool = False,
    max_records: int = 50,
) -> str:
    if layer_name not in AGOL_LAYERS:
        return f"Error: unknown layer '{layer_name}'. Available: {', '.join(AGOL_LAYERS.keys())}"
    params = {
        "where": where_clause,
        "outFields": out_fields,
        "f": "pjson",
        "returnGeometry": "false",
        "resultRecordCount": max_records,
    }
    if return_count_only:
        params["returnCountOnly"] = "true"
        params.pop("resultRecordCount", None)
    try:
        text = requests.get(AGOL_LAYERS[layer_name], params=params, timeout=30).text
        if len(text) > MAX_QUERY_CHARS:
            text = text[:MAX_QUERY_CHARS] + f"\n...[truncated — first {max_records} records shown]"
        return text
    except Exception as e:
        return f"Request error: {e}"


def get_object_ids(layer_name: str, where_clause: str = "1=1") -> list:
    if layer_name not in AGOL_LAYERS:
        return []
    try:
        resp = requests.get(
            AGOL_LAYERS[layer_name],
            params={"where": where_clause, "returnIdsOnly": "true", "f": "json"},
            timeout=30,
        )
        return resp.json().get("objectIds") or []
    except Exception:
        return []


def geocode_place(place_name: str):
    url = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"
    try:
        resp = requests.get(
            url,
            params={"singleLine": place_name, "f": "json", "maxLocations": 1,
                    "outFields": "*", "sourceCountry": "USA"},
            timeout=15,
        )
        candidates = resp.json().get("candidates", [])
        if candidates:
            c = candidates[0]
            return c.get("location"), c.get("extent")
    except Exception:
        pass
    return None, None


# ── Endpoints ────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ai_ready": bool(ANTHROPIC_API_KEY)}


@app.post("/chat")
async def chat(request: Request):
    if not ANTHROPIC_API_KEY:
        return JSONResponse(
            {"error": "ANTHROPIC_API_KEY is not set on the server. Add it in your Render environment variables."},
            status_code=503,
        )

    body = await request.json()
    # Trim history to last MAX_HISTORY_MSGS messages to stay under rate limits.
    # The system prompt provides enough context; old turns are not needed.
    messages = body.get("messages", [])[-MAX_HISTORY_MSGS:]

    headers = {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    }

    pending_actions = []

    for _ in range(10):
        payload = {
            "model":      "claude-sonnet-4-6",
            "max_tokens": 1024,
            "system":     SYSTEM_PROMPT,
            "tools":      CLAUDE_TOOLS,
            "messages":   messages,
        }

        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            json=payload, headers=headers, timeout=60,
        )
        if not resp.ok:
            try:
                err_body = resp.json()
                err_msg = err_body.get("error", {}).get("message") or resp.text
            except Exception:
                err_msg = resp.text
            return JSONResponse({"error": err_msg}, status_code=resp.status_code)

        data        = resp.json()
        stop_reason = data.get("stop_reason")

        if stop_reason != "tool_use":
            final = next((b["text"] for b in data["content"] if b["type"] == "text"), "")
            return {"reply": final, "actions": pending_actions}

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
                    return_count_only=inp.get("return_count_only", False),
                    max_records=min(int(inp.get("max_records", 50)), 200),
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
                            "type": "zoom", "longitude": loc["x"],
                            "latitude": loc["y"], "zoom": inp.get("zoom", 7),
                        })
                    result_text = f"Zoomed to {place}"
                elif inp.get("longitude") is not None:
                    pending_actions.append({
                        "type": "zoom", "longitude": inp["longitude"],
                        "latitude": inp["latitude"], "zoom": inp.get("zoom", 6),
                    })
                    result_text = "Zoomed to coordinates"
                else:
                    result_text = "No location provided"

            elif name == "highlight_features":
                oids = get_object_ids(inp.get("layer_name", ""), inp.get("where_clause", "1=1"))
                if oids:
                    pending_actions.append({
                        "type": "highlight",
                        "layer_name": inp["layer_name"],
                        "objectIds":  oids,
                    })
                    result_text = f"Highlighting {len(oids)} features in {inp['layer_name']}"
                else:
                    result_text = f"No features matched: {inp.get('where_clause')}"

            elif name == "clear_map":
                pending_actions.append({"type": "clear"})
                result_text = "Map cleared"

            else:
                result_text = f"Unknown tool: {name}"

            tool_results.append({
                "type": "tool_result", "tool_use_id": tu["id"], "content": result_text,
            })

        messages.append({"role": "user", "content": tool_results})

    return {"reply": "Max tool iterations reached.", "actions": pending_actions}


@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")
