const express = require("express");
const axios = require("axios");
const configStore = require("../lib/configStore");

const router = express.Router();

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const MAX_TOKENS_CAP = 500; // safety cap regardless of what the client requests

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
                max_tokens: Math.min(Number(max_tokens) || 400, MAX_TOKENS_CAP),
                // Groq's gpt-oss reasoning models spend part of max_tokens on
                // internal "thinking" before writing the visible reply. Keeping
                // reasoning effort low leaves more of that budget for the
                // actual answer (important for short, snappy chatbot replies).
                // Harmless no-op if the selected model doesn't support it.
                reasoning_effort: "low",
                // gpt-oss models put their internal reasoning in a separate
                // `reasoning` field on the response by default; we only ever
                // want the visible answer, never the raw chain-of-thought.
                include_reasoning: false,
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

        if (!reply || !reply.trim()) {
            // The model returned no visible content (e.g. it spent its whole
            // token budget on internal reasoning). Treat this the same as a
            // provider failure rather than sending an empty chat bubble.
            console.error("[chat] Model returned empty content:", JSON.stringify(response.data?.choices?.[0]));
            return res.status(502).json({
                success: false,
                error: "AI service is temporarily unavailable. Please contact the administrator.",
            });
        }

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