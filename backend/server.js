require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const chatRouter = require("./routes/chat");
const adminRouter = require("./routes/admin");

const path = require("path");

const app = express();

// Restrict CORS to configured origins when provided; otherwise stay open
// (matches the project's previous behavior for the /fetch endpoint).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors(
        allowedOrigins.length
            ? {
                  origin: (origin, callback) => {
                      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
                      return callback(new Error("Not allowed by CORS"));
                  },
              }
            : undefined
    )
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..")));

// ── Existing endpoint (unchanged) ──────────────────────────────────
app.get("/fetch", async (req, res) => {

    const url = req.query.url;

    console.log("Fetching:", url);

    try {

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            },
            timeout: 15000
        });

        console.log("Downloaded successfully");

        const $ = cheerio.load(response.data);

        $("script,style,nav,footer,header,noscript").remove();

        const text = $("body").text().replace(/\s+/g, " ").trim();

        console.log("Extracted text length:", text.length);

        res.json({
            success: true,
            text
        });

    } catch (err) {

        console.error("ERROR:", err.message);

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

});

// ── New endpoints ───────────────────────────────────────────────────
// Chatbot proxy: frontend calls this, never the AI provider directly.
app.use("/api/chat", chatRouter);

// Admin: login + dynamic AI API key management.
app.use("/api/admin", adminRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
});
