/* ═══════════════════════════════════════════════════════════
   NAVIS – Admin Settings Page Logic
   ═══════════════════════════════════════════════════════════
   Handles admin login and dynamic AI API key management.
   The API key itself is NEVER stored in localStorage/sessionStorage
   or kept in this file — only the short-lived admin session token is
   (in sessionStorage, cleared when the tab closes).
*/

const API_BASE = (window.NAVIS_CONFIG && window.NAVIS_CONFIG.BACKEND_URL) || "";
const SESSION_KEY = "navis_admin_token"; // holds the admin JWT session token only

const els = {
    loginCard: document.getElementById("loginCard"),
    adminApp: document.getElementById("adminApp"),
    loginForm: document.getElementById("loginForm"),
    loginUsername: document.getElementById("loginUsername"),
    loginPassword: document.getElementById("loginPassword"),
    loginBtn: document.getElementById("loginBtn"),
    loginStatus: document.getElementById("loginStatus"),
    configForm: document.getElementById("configForm"),
    providerInput: document.getElementById("providerInput"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    saveKeyBtn: document.getElementById("saveKeyBtn"),
    configStatus: document.getElementById("configStatus"),
    currentKeyDisplay: document.getElementById("currentKeyDisplay"),
    logoutBtn: document.getElementById("logoutBtn"),
    toastContainer: document.getElementById("toastContainer"),
};

function toast(msg, type = "info") {
    if (!els.toastContainer) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

function getToken() {
    return sessionStorage.getItem(SESSION_KEY);
}

function setToken(token) {
    sessionStorage.setItem(SESSION_KEY, token);
}

function clearToken() {
    sessionStorage.removeItem(SESSION_KEY);
}

function showLogin() {
    els.loginCard.style.display = "block";
    els.adminApp.style.display = "none";
}

function showAdminApp() {
    els.loginCard.style.display = "none";
    els.adminApp.style.display = "block";
}

async function apiRequest(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
}

async function loadCurrentConfig() {
    els.currentKeyDisplay.textContent = "Loading…";
    try {
        const data = await apiRequest("/api/admin/ai-config", {
            headers: { Authorization: `Bearer ${getToken()}` },
        });
        els.currentKeyDisplay.textContent = data.maskedKey
            ? `${data.maskedKey} (${data.source})`
            : "No key configured yet";
        if (data.provider) els.providerInput.value = data.provider;
    } catch (err) {
        els.currentKeyDisplay.textContent = "Unable to load";
        if (/expired|invalid/i.test(err.message)) {
            clearToken();
            showLogin();
            toast("Session expired, please log in again", "error");
        }
    }
}

els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.loginStatus.textContent = "";
    els.loginStatus.className = "status-text";
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "Signing in…";

    try {
        const data = await apiRequest("/api/admin/login", {
            method: "POST",
            body: JSON.stringify({
                username: els.loginUsername.value.trim(),
                password: els.loginPassword.value,
            }),
        });
        setToken(data.token);
        els.loginPassword.value = "";
        showAdminApp();
        await loadCurrentConfig();
    } catch (err) {
        els.loginStatus.textContent = err.message;
        els.loginStatus.className = "status-text error";
    } finally {
        els.loginBtn.disabled = false;
        els.loginBtn.textContent = "Sign In";
    }
});

els.configForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.configStatus.textContent = "";
    els.configStatus.className = "status-text";

    const apiKey = els.apiKeyInput.value.trim();
    if (!apiKey) {
        els.configStatus.textContent = "API key cannot be empty.";
        els.configStatus.className = "status-text error";
        return;
    }

    els.saveKeyBtn.disabled = true;
    els.saveKeyBtn.textContent = "Saving…";

    try {
        const data = await apiRequest("/api/admin/ai-config", {
            method: "PUT",
            headers: { Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({
                apiKey,
                provider: els.providerInput.value.trim() || "groq",
            }),
        });
        els.apiKeyInput.value = "";
        els.configStatus.textContent = data.message;
        els.configStatus.className = "status-text success";
        toast("API key updated successfully", "success");
        await loadCurrentConfig();
    } catch (err) {
        els.configStatus.textContent = err.message;
        els.configStatus.className = "status-text error";
        if (/expired|invalid/i.test(err.message)) {
            clearToken();
            showLogin();
        }
    } finally {
        els.saveKeyBtn.disabled = false;
        els.saveKeyBtn.textContent = "Save / Update API Key";
    }
});

els.logoutBtn.addEventListener("click", () => {
    clearToken();
    showLogin();
});

// ── Init ─────────────────────────────────────────────────────────
(async function init() {
    if (getToken()) {
        showAdminApp();
        await loadCurrentConfig();
    } else {
        showLogin();
    }
})();
