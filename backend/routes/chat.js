const express = require("express");
const axios = require("axios");
const configStore = require("../lib/configStore");

const router = express.Router();

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const MAX_TOKENS_CAP = 300; // safety cap regardless of what the client requests

/**
 * POST /api/chat
 * body: { messages: [{role, content}, ...], model?, temperature?, max_tokens? }
 *
 * The frontend NEVER sees or sends the API key. This endpoint resolves
 * the currently active key server-side (dynamic admin-configured key,
 * falling back to AI_API_KEY from the environment) and proxies the
 * request to the AI provider.
 */
router.post("/", async (req, res) => {
    const { messages, model, temperature, max_tokens } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ success: false, error: "messages array is required" });
    }

    const apiKey = configStore.getActiveApiKey();
    if (!apiKey) {
        console.error("[chat] No AI API key configured (no dynamic key and AI_API_KEY is unset)");
        return res.status(503).json({
            success: false,
            error: "AI service is temporarily unavailable. Please contact the administrator.",
        });
    }

    try {
        const response = await axios.post(
            GROQ_ENDPOINT,
            {
                model: model || DEFAULT_MODEL,
                messages,
                temperature: typeof temperature === "number" ? temperature : 0.7,
                max_tokens: Math.min(Number(max_tokens) || 60, MAX_TOKENS_CAP),
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                timeout: 20000,
            }
        );

        const reply = response.data?.choices?.[0]?.message?.content;
        return res.json({ success: true, reply });
    } catch (err) {
        const status = err.response?.status;
        // Log full detail server-side only; never forward provider error
        // bodies (which can include the key, account info, etc.) to the client.
        console.error("[chat] AI provider request failed:", status, err.response?.data || err.message);

        if (status === 401 || status === 403) {
            return res.status(503).json({
                success: false,
                error: "AI service is temporarily unavailable. Please contact the administrator.",
            });
        }
        if (status === 429) {
            return res.status(503).json({
                success: false,
                error: "AI service is busy right now. Please try again in a moment.",
            });
        }
        return res.status(502).json({
            success: false,
            error: "AI service is temporarily unavailable. Please contact the administrator.",
        });
    }
});

module.exports = router;
