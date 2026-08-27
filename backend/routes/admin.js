const express = require("express");
const { verifyAdminCredentials, issueToken, requireAdmin } = require("../lib/auth");
const configStore = require("../lib/configStore");

const router = express.Router();

/**
 * POST /api/admin/login
 * body: { username, password }
 * Returns a short-lived JWT used for the other /api/admin/* routes.
 */
router.post("/login", async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ success: false, error: "Username and password are required" });
    }

    try {
        const isValid = await verifyAdminCredentials(username, password);
        if (!isValid) {
            // Deliberately generic message — don't reveal which field was wrong.
            return res.status(401).json({ success: false, error: "Invalid username or password" });
        }
        const token = issueToken(username);
        return res.json({ success: true, token, expiresIn: "12h" });
    } catch (err) {
        console.error("[admin/login] Configuration error:", err.message);
        return res.status(500).json({ success: false, error: "Admin login is not configured on the server" });
    }
});

/**
 * GET /api/admin/ai-config
 * Auth required. Returns the provider + a masked key, never the raw key.
 */
router.get("/ai-config", requireAdmin, (req, res) => {
    try {
        const summary = configStore.getConfigSummary();
        const maskedKey = configStore.getMaskedActiveKey();
        return res.json({
            success: true,
            provider: summary.provider,
            maskedKey,
            source: summary.hasDynamicKey ? "dynamic" : "environment",
            updatedAt: summary.updatedAt || null,
        });
    } catch (err) {
        console.error("[admin/ai-config GET] Error:", err.message);
        return res.status(500).json({ success: false, error: "Failed to load AI configuration" });
    }
});

/**
 * PUT /api/admin/ai-config
 * Auth required. body: { apiKey, provider? }
 * Stores the new key server-side (encrypted). The chatbot endpoint
 * picks it up on the very next request — no restart needed.
 */
router.put("/ai-config", requireAdmin, (req, res) => {
    const { apiKey, provider } = req.body || {};

    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        return res.status(400).json({ success: false, error: "API key cannot be empty" });
    }

    try {
        const result = configStore.setApiKey(apiKey, provider || "groq");
        return res.json({
            success: true,
            message: "API key updated successfully. The chatbot is now using the new configuration.",
            provider: result.provider,
            maskedKey: configStore.getMaskedActiveKey(),
            updatedAt: result.updatedAt,
        });
    } catch (err) {
        console.error("[admin/ai-config PUT] Error:", err.message);
        return res.status(500).json({ success: false, error: "Failed to save the new API key" });
    }
});

module.exports = router;
