import os
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# ── Claude API key from Render environment variable ──────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL      = "claude-haiku-4-5-20251001"
CLAUDE_URL        = "https://api.anthropic.com/v1/messages"

# ── ArcGIS feature service endpoints ────────────────────────────────────────
AGOL_LAYERS = {
    "wwtp_phosphorus":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0/query",
    "largest_200":         "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0/query",
    "county_p_consumption":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0/query",
    "p_use_ratio_ind":     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0/query",
    "p_use_ratio_neighbor":"https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0/query",
}

SYSTEM_PROMPT = f"""You are a spatial AI assistant for a US phosphorus mapping dashboard.

The dashboard displays an embedded ArcGIS Online dashboard covering:
- USA WWTPs treatment design capacity and agricultural P fertilizer consumption
- Largest 200 WWTPs sewage sludge phosphorus overlaid on US agricultural belts
- P Use Ratio by individual county and by neighborhood county

Available data layers you can query: {', '.join(AGOL_LAYERS.keys())}

Use query_arcgis to retrieve data and give precise, quantitative answers.
You cannot control the map view — focus on answering data questions clearly.

IMPORTANT — keep every query minimal to conserve tokens:
- For "how many" questions always set return_count_only=true.
- Always filter with a specific where_clause (state, county, or facility name). Never query all records.
- Request only 1–3 relevant fields in out_fields, never *.
- Never sort, rank, or aggregate across the full dataset. Answer single-location lookups only.
- Keep max_records at 10 or below.
"""

# ── Claude tool definitions ───────────────────────────────────────────────────
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
                "layer_name":        {"type": "string", "description": "Name of the layer to query."},
                "where_clause":      {"type": "string", "description": "SQL WHERE clause, default '1=1'"},
                "out_fields":        {"type": "string", "description": "Comma-separated field names. Use only the fields you need."},
                "return_count_only": {"type": "boolean", "description": "Return only the feature count — use for 'how many' questions"},
                "max_records":       {"type": "integer", "description": "Max records to return (default 50, max 200)"},
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

# ── Helpers ──────────────────────────────────────────────────────────────────
MAX_QUERY_CHARS  = 4_000  # keep tool results small
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

    body     = await request.json()
    messages = body.get("messages", [])[-MAX_HISTORY_MSGS:]

    headers = {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
    }

    for _ in range(10):
        payload = {
            "model":      CLAUDE_MODEL,
            "max_tokens": 1024,
            "system":     SYSTEM_PROMPT,
            "tools":      CLAUDE_TOOLS,
            "messages":   messages,
        }

        resp = requests.post(CLAUDE_URL, json=payload, headers=headers, timeout=60)
        if not resp.ok:
            try:
                err_msg = resp.json().get("error", {}).get("message") or resp.text
            except Exception:
                err_msg = resp.text
            return JSONResponse({"error": err_msg}, status_code=resp.status_code)

        data        = resp.json()
        stop_reason = data.get("stop_reason")

        if stop_reason != "tool_use":
            final = next((b["text"] for b in data["content"] if b["type"] == "text"), "")
            return {"reply": final}

        # Append assistant turn with tool_use blocks
        tool_use_blocks = [b for b in data["content"] if b["type"] == "tool_use"]
        messages.append({"role": "assistant", "content": data["content"]})

        # Execute each tool and collect results
        tool_results = []
        for tu in tool_use_blocks:
            inp  = tu["input"]
            name = tu["name"]
            print(f"[TOOL] {name} {inp}")

            if name == "query_arcgis":
                result = run_arcgis_query(
                    inp.get("layer_name"),
                    inp.get("where_clause", "1=1"),
                    inp.get("out_fields", "*"),
                    return_count_only=inp.get("return_count_only", False),
                    max_records=min(int(inp.get("max_records", 50)), 200),
                )
            else:
                result = f"Unknown tool: {name}"

            tool_results.append({
                "type":        "tool_result",
                "tool_use_id": tu["id"],
                "content":     result,
            })

        messages.append({"role": "user", "content": tool_results})

    return {"reply": "Max tool iterations reached."}


@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")
