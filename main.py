import os
import json
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# ── Groq API key from Render environment variable ────────────────────────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL   = "llama-3.3-70b-versatile"
GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions"

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

SYSTEM_PROMPT = f"""You are a spatial AI assistant for a US phosphorus mapping dashboard.

The dashboard displays an embedded ArcGIS Online dashboard covering:
- USA WWTPs treatment design capacity and agricultural P fertilizer consumption
- Largest 200 WWTPs sewage sludge phosphorus overlaid on US agricultural belts
- P Use Ratio by individual county and by neighborhood county

Available data layers you can query: {', '.join(AGOL_LAYERS.keys())}

Use query_arcgis to retrieve data and give precise, quantitative answers.
You cannot control the map view — focus on answering data questions clearly.

IMPORTANT — keep queries small to avoid token limits:
- For "how many" questions always set return_count_only=true.
- Specify only the fields you need in out_fields (never use * unless necessary).
- Use a specific where_clause to filter rows; avoid returning thousands of records.
"""

# ── Groq tool definitions (OpenAI-compatible format) ─────────────────────────
GROQ_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_arcgis",
            "description": (
                "Query an ArcGIS Feature Layer to retrieve attribute data. "
                "Use return_count_only=true for 'how many' questions (returns just a count, no records). "
                "Use a specific where_clause and limited out_fields to keep responses concise. "
                f"Valid layer_name values: {', '.join(AGOL_LAYERS.keys())}."
            ),
            "parameters": {
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
MAX_HISTORY_MSGS = 6      # only last 3 user+assistant pairs sent to Groq


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
    return {"status": "ok", "ai_ready": bool(GROQ_API_KEY)}


@app.post("/chat")
async def chat(request: Request):
    if not GROQ_API_KEY:
        return JSONResponse(
            {"error": "GROQ_API_KEY is not set on the server. Add it in your Render environment variables."},
            status_code=503,
        )

    body = await request.json()
    history = body.get("messages", [])[-MAX_HISTORY_MSGS:]

    # Build OpenAI-compatible messages list with system prompt prepended
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }

    for _ in range(10):
        payload = {
            "model":      GROQ_MODEL,
            "messages":   messages,
            "tools":      GROQ_TOOLS,
            "max_tokens": 1024,
        }

        resp = requests.post(GROQ_URL, json=payload, headers=headers, timeout=60)
        if not resp.ok:
            try:
                err_msg = resp.json().get("error", {}).get("message") or resp.text
            except Exception:
                err_msg = resp.text
            return JSONResponse({"error": err_msg}, status_code=resp.status_code)

        data         = resp.json()
        choice       = data["choices"][0]
        message      = choice["message"]
        finish_reason = choice.get("finish_reason")
        tool_calls   = message.get("tool_calls") or []

        if not tool_calls:
            return {"reply": message.get("content", "").strip()}

        # Add assistant message (with tool calls) to history
        messages.append(message)

        # Execute each tool call and append results
        for tc in tool_calls:
            fn   = tc["function"]
            name = fn["name"]
            try:
                args = json.loads(fn["arguments"])
            except Exception:
                args = {}
            print(f"[TOOL] {name} {args}")

            if name == "query_arcgis":
                result = run_arcgis_query(
                    args.get("layer_name"),
                    args.get("where_clause", "1=1"),
                    args.get("out_fields", "*"),
                    return_count_only=args.get("return_count_only", False),
                    max_records=min(int(args.get("max_records", 50)), 200),
                )
            else:
                result = f"Unknown tool: {name}"

            messages.append({
                "role":         "tool",
                "tool_call_id": tc["id"],
                "content":      result,
            })

    return {"reply": "Max tool iterations reached."}


@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")
