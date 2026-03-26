"""
Backend for agol-mcp-proxy.

The AI chatbot is now powered entirely by the ArcGIS Maps SDK 5.0
arcgis-assistant component on the frontend. This server's only job is
to serve the static web files and provide a health check endpoint.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return FileResponse("index.html")

@app.get("/app.js")
async def serve_js():
    return FileResponse("app.js", media_type="application/javascript")

@app.get("/oauth-callback.html")
async def serve_oauth_callback():
    """OAuth popup redirect URI — must be registered in your ArcGIS app settings."""
    return FileResponse("oauth-callback.html")
