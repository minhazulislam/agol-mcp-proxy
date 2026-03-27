/**
 * app.js — ArcGIS Maps SDK 5.0 + AI Components
 *
 * Responsibilities:
 *  1. Configure the ArcGIS portal URL (ASU ArcGIS Online)
 *  2. Register OAuth so sign-in goes to asu.maps.arcgis.com
 *  3. Manage the sign-in / sign-out header buttons
 *  4. Switch the arcgis-assistant's context when the user clicks a map label
 */

// These bare specifiers resolve via the <script type="importmap"> in index.html
import esriConfig    from "@arcgis/core/config.js";
import OAuthInfo     from "@arcgis/core/identity/OAuthInfo.js";
import IdentityManager from "@arcgis/core/identity/IdentityManager.js";

// ── Configuration ──────────────────────────────────────────────────────────────
const PORTAL_URL = "https://asu.maps.arcgis.com";

/**
 * OAuth Client ID registered for this application.
 * Register your app at https://asu.maps.arcgis.com/home/content.html
 * (Content → My Content → New Item → Application → Register) or at
 * https://developers.arcgis.com/
 *
 * The redirect URI must include: <your-app-origin>/oauth-callback.html
 */
const OAUTH_CLIENT_ID = "sSGEaOtbBSAPN0Ht";

// Point the SDK at the ASU portal
esriConfig.portalUrl = PORTAL_URL;

// ── OAuth registration ─────────────────────────────────────────────────────────
const oauthInfo = new OAuthInfo({
  appId:            OAUTH_CLIENT_ID,
  portalUrl:        PORTAL_URL,
  popup:            true,
  // Resolves correctly regardless of subdirectory (e.g. GitHub Pages /agol-mcp-proxy/)
  popupCallbackUrl: new URL("oauth-callback.html", location.href).href,
});
IdentityManager.registerOAuthInfos([oauthInfo]);

// ── Auth UI ────────────────────────────────────────────────────────────────────
const signInBtn  = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const userNameEl = document.getElementById("user-name");

async function refreshAuthState() {
  try {
    const cred = await IdentityManager.checkSignInStatus(`${PORTAL_URL}/sharing/rest`);
    signInBtn.hidden  = true;
    signOutBtn.hidden = false;
    userNameEl.textContent = cred.userId;
  } catch {
    signInBtn.hidden  = false;
    signOutBtn.hidden = true;
    userNameEl.textContent = "";
  }
}

signInBtn.addEventListener("click", async () => {
  try {
    const cred = await IdentityManager.getCredential(`${PORTAL_URL}/sharing/rest`);
    signInBtn.hidden  = true;
    signOutBtn.hidden = false;
    userNameEl.textContent = cred.userId;
  } catch (err) {
    console.error("ArcGIS sign-in error:", err);
  }
});

signOutBtn.addEventListener("click", () => {
  IdentityManager.destroyCredentials();
  window.location.reload();
});

// Check sign-in on load (restores session from a previous visit)
refreshAuthState();

// ── AI Assistant suggested prompts ────────────────────────────────────────────
// Set after the element is defined (custom elements may not be ready during
// module evaluation, so we defer to DOMContentLoaded).
document.addEventListener("DOMContentLoaded", () => {
  const assistant = document.getElementById("assistant");
  if (assistant) {
    assistant.suggestedPrompts = [
      "How many WWTPs are in Iowa?",
      "What counties have the highest phosphorus fertilizer consumption?",
      "Where is the corn belt region?",
      "Filter to show only high phosphorus use counties",
      "Find the top 10 facilities by phosphorus output",
    ];
  }
});

// ── Map-panel focus switching ──────────────────────────────────────────────────
// Clicking a map's label (the white bar at the top of each panel) switches
// the arcgis-assistant to interact with that map's data and layers.
document.querySelectorAll(".map-cell .map-label").forEach(label => {
  label.addEventListener("click", () => {
    const cell  = label.closest(".map-cell");
    const mapId = cell.dataset.mapId;

    // Update assistant context
    const assistant = document.getElementById("assistant");
    if (assistant) assistant.referenceElement = `#${mapId}`;

    // Update active visual state
    document.querySelectorAll(".map-cell").forEach(c => c.classList.remove("active"));
    cell.classList.add("active");
  });
});
