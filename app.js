// ArcGIS Maps SDK for JavaScript 4.29 — AMD modules
require([
    "esri/Map",
    "esri/views/MapView",
    "esri/layers/FeatureLayer",
    "esri/widgets/Legend",
    "esri/widgets/LayerList",
    "esri/geometry/Extent",
    "esri/geometry/SpatialReference",
], function (Map, MapView, FeatureLayer, Legend, LayerList, Extent, SpatialReference) {

    // ── Layer definitions (service base URLs without /query) ─────────────────
    const LAYER_CONFIGS = {
        "wwtp_phosphorus": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/WWTP_Phosphorus/FeatureServer/0",
            title:   "WWTP Phosphorus",
            visible: true,
        },
        "largest_200": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Largest_200/FeatureServer/0",
            title:   "Largest 200 Facilities",
            visible: true,
        },
        "county_p_consumption": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Fertilizer_Avg/FeatureServer/0",
            title:   "County P Fertilizer Avg",
            visible: true,
        },
        "p_use_ratio_ind": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Individual/FeatureServer/0",
            title:   "County P Use Ratio (Individual)",
            visible: false,
        },
        "p_use_ratio_neighbor": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/County_P_Use_Ratio_Neighborhood/FeatureServer/0",
            title:   "County P Use Ratio (Neighborhood)",
            visible: false,
        },
        "corn_belt": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Corn_Belt/FeatureServer/0",
            title:   "Corn Belt",
            visible: true,
        },
        "cotton_belt": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Cotton_Belt/FeatureServer/0",
            title:   "Cotton Belt",
            visible: true,
        },
        "soybean_belt": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Soybean_Belt/FeatureServer/0",
            title:   "Soybean Belt",
            visible: true,
        },
        "spring_wheat_belt": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Spring_Wheat_Belt/FeatureServer/0",
            title:   "Spring Wheat Belt",
            visible: false,
        },
        "winter_wheat_belt": {
            url:     "https://services3.arcgis.com/0OPQIK59PJJqLK0A/arcgis/rest/services/Winter_Wheat_Belt/FeatureServer/0",
            title:   "Winter Wheat Belt",
            visible: false,
        },
    };

    // ── Build Map & View ──────────────────────────────────────────────────────
    const mapLayers = {};

    const map = new Map({ basemap: "gray-vector" });

    for (const [key, cfg] of Object.entries(LAYER_CONFIGS)) {
        const layer = new FeatureLayer({
            url:       cfg.url,
            title:     cfg.title,
            visible:   cfg.visible,
            outFields: ["*"],
        });
        mapLayers[key] = layer;
        map.add(layer);
    }

    const mapView = new MapView({
        container: "mapDiv",
        map:       map,
        center:    [-96, 38],   // continental US
        zoom:      4,
    });

    mapView.when(() => {
        mapView.ui.add(new Legend({ view: mapView }), "bottom-left");
        mapView.ui.add(new LayerList({ view: mapView }), "top-right");
    });

    // ── Highlight state ───────────────────────────────────────────────────────
    let highlightHandles = [];

    // ── Map action dispatcher ─────────────────────────────────────────────────
    async function applyMapActions(actions) {
        if (!actions || actions.length === 0) return;

        for (const action of actions) {
            try {
                switch (action.type) {

                    case "zoom": {
                        await mapView.goTo(
                            { center: [action.longitude, action.latitude], zoom: action.zoom || 6 },
                            { duration: 800 }
                        );
                        break;
                    }

                    case "zoom_extent": {
                        await mapView.goTo(
                            new Extent({
                                xmin: action.xmin, ymin: action.ymin,
                                xmax: action.xmax, ymax: action.ymax,
                                spatialReference: SpatialReference.WGS84,
                            }),
                            { duration: 800 }
                        );
                        break;
                    }

                    case "highlight": {
                        // Remove any previous highlights
                        highlightHandles.forEach(h => h.remove());
                        highlightHandles = [];

                        const layer = mapLayers[action.layer_name];
                        if (!layer || !action.objectIds || action.objectIds.length === 0) break;

                        // Ensure the layer is visible before trying to get a LayerView
                        layer.visible = true;

                        const layerView = await mapView.whenLayerView(layer);
                        highlightHandles.push(layerView.highlight(action.objectIds));

                        // Zoom to the highlighted features
                        const query = layer.createQuery();
                        query.objectIds           = action.objectIds;
                        query.returnGeometry      = true;
                        query.outSpatialReference = mapView.spatialReference;
                        const result = await layer.queryFeatures(query);

                        const geoms = result.features.map(f => f.geometry).filter(Boolean);
                        if (geoms.length > 0) {
                            await mapView.goTo(geoms, { duration: 800, padding: 60 });
                        }
                        break;
                    }

                    case "filter": {
                        const layer = mapLayers[action.layer_name];
                        if (layer) layer.definitionExpression = action.where || "1=1";
                        break;
                    }

                    case "toggle": {
                        const layer = mapLayers[action.layer_name];
                        if (layer) layer.visible = action.visible;
                        break;
                    }

                    case "clear": {
                        highlightHandles.forEach(h => h.remove());
                        highlightHandles = [];
                        for (const [key, layer] of Object.entries(mapLayers)) {
                            layer.definitionExpression = "1=1";
                            layer.visible = LAYER_CONFIGS[key].visible;
                        }
                        break;
                    }
                }
            } catch (err) {
                console.warn(`applyMapActions [${action.type}] error:`, err);
            }
        }
    }

    // ── Chat state & UI refs ──────────────────────────────────────────────────
    let serverBaseUrl       = null;
    let conversationHistory = [];

    const chatHistory    = document.getElementById("chat-history");
    const connectBtn     = document.getElementById("connect-btn");
    const sendBtn        = document.getElementById("send-btn");
    const userInput      = document.getElementById("user-input");
    const renderUrlInput = document.getElementById("render-url");
    const apiKeyInput    = document.getElementById("api-key");

    function appendMessage(role, text) {
        const div = document.createElement("div");
        div.className   = `message ${role}`;
        div.textContent = text;
        chatHistory.appendChild(div);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    // Clear the placeholder set in HTML and show initial prompt
    chatHistory.innerHTML = "";
    appendMessage("system", "Enter your API key and server URL, then click Connect.");

    // ── Connect ───────────────────────────────────────────────────────────────
    connectBtn.addEventListener("click", async () => {
        let url = renderUrlInput.value.trim();
        if (!url) { alert("Please enter your Server URL."); return; }
        if (!url.includes("://")) url = "https://" + url;
        url = url.replace(/\/+$/, "").replace(/\/sse$/, "");

        appendMessage("system", `Connecting to ${url} ...`);
        connectBtn.disabled = true;

        try {
            const healthRes = await fetch(`${url}/health`);
            if (!healthRes.ok) throw new Error(`Server returned ${healthRes.status}`);

            const toolsRes  = await fetch(`${url}/tools`);
            if (!toolsRes.ok) throw new Error(`Could not load tools: ${toolsRes.status}`);
            const toolsData = await toolsRes.json();
            const names     = toolsData.tools.map(t => t.name).join(", ");

            serverBaseUrl = url;
            appendMessage("system", `Connected! Tools: ${names}`);
            userInput.disabled = false;
            sendBtn.disabled   = false;
            userInput.focus();

        } catch (err) {
            console.error("Connection error:", err);
            appendMessage("system", `Connection failed: ${err.message}`);
            connectBtn.disabled = false;
            serverBaseUrl = null;
        }
    });

    userInput.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    // ── Send ──────────────────────────────────────────────────────────────────
    sendBtn.addEventListener("click", async () => {
        const prompt = userInput.value.trim();
        const apiKey = apiKeyInput.value.trim();

        if (!prompt) return;
        if (!apiKey)        { alert("Please enter your Anthropic API Key."); return; }
        if (!serverBaseUrl) { alert("Please connect to the server first."); return; }

        appendMessage("user", prompt);
        userInput.value    = "";
        sendBtn.disabled   = true;
        userInput.disabled = true;
        conversationHistory.push({ role: "user", content: prompt });
        appendMessage("system", "Thinking...");

        try {
            const res = await fetch(`${serverBaseUrl}/chat`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ api_key: apiKey, messages: conversationHistory }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || err.error || `Server error ${res.status}`);
            }

            const data = await res.json();
            if (data.error) throw new Error(JSON.stringify(data.error));

            // Remove the "Thinking..." status bubble
            const thinkingEl = [...chatHistory.querySelectorAll(".system")]
                .findLast(el => el.textContent === "Thinking...");
            if (thinkingEl) thinkingEl.remove();

            appendMessage("assistant", data.reply);
            conversationHistory.push({ role: "assistant", content: data.reply });

            // Apply map actions the LLM requested (zoom, highlight, filter, etc.)
            if (data.actions && data.actions.length > 0) {
                await applyMapActions(data.actions);
            }

        } catch (err) {
            console.error("Error:", err);
            appendMessage("system", `Error: ${err.message}`);
        } finally {
            sendBtn.disabled   = false;
            userInput.disabled = false;
            userInput.focus();
        }
    });

}); // end require()
