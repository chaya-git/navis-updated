/**
 * configStore.js
 * ─────────────────────────────────────────────────────────────
 * Minimal, file-based, encrypted-at-rest storage for the AI
 * provider configuration (currently just the active API key).
 *
 * WHY A FILE AND NOT A REAL DATABASE?
 * This project didn't have a database before this change, and adding
 * one is out of scope for "wire up dynamic API key management".
 * This module isolates all persistence behind a small API
 * (getConfig / setApiKey / getActiveApiKey / getMaskedKey), so it can
 * be swapped for a real database later (Postgres, MongoDB, etc.)
 * without touching any route or the chatbot logic.
 *
 * IMPORTANT (deployment): the file lives in backend/data/config.json.
 * Some hosts (e.g. Vercel serverless, most free-tier containers) wipe
 * the local filesystem on every deploy/restart. If you deploy there,
 * mount a persistent disk / volume at backend/data, or swap this
 * module for a real database. See README section "Persistence".
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const ALGORITHM = "aes-256-gcm";

/**
 * Derives a stable 32-byte encryption key from the ENCRYPTION_KEY env
 * var. Accepts either a 64-char hex string (32 bytes) or an arbitrary
 * passphrase (in which case it's stretched via scrypt). Throws if the
 * env var is missing so we never silently store the key in plaintext.
 */
function getEncryptionKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
        throw new Error(
            "ENCRYPTION_KEY environment variable is not set. Set it to a long random " +
            "string (e.g. `openssl rand -hex 32`) before storing an AI API key."
        );
    }
    if (/^[0-9a-fA-F]{64}$/.test(secret)) {
        return Buffer.from(secret, "hex");
    }
    // Fallback: stretch an arbitrary passphrase into a 32-byte key.
    return crypto.scryptSync(secret, "navis-ai-config-salt", 32);
}

function encrypt(plainText) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        data: encrypted.toString("hex"),
    };
}

function decrypt(payload) {
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "hex"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.data, "hex")),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function readRawConfig() {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        console.error("[configStore] Failed to read/parse config.json:", err.message);
        return null;
    }
}

function writeRawConfig(obj) {
    ensureDataDir();
    // Restrict permissions to the owner where the OS supports it.
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/**
 * Persists a new active API key (encrypted) + provider name.
 * Never logs or returns the raw key.
 */
function setApiKey(apiKey, provider = "groq") {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("apiKey must be a non-empty string");
    }
    const encrypted = encrypt(apiKey.trim());
    const record = {
        provider,
        apiKey: encrypted,
        updatedAt: new Date().toISOString(),
    };
    writeRawConfig(record);
    return { provider, updatedAt: record.updatedAt };
}

/**
 * Returns { provider, hasDynamicKey } without ever exposing the raw key.
 */
function getConfigSummary() {
    const record = readRawConfig();
    if (!record) {
        return { provider: process.env.AI_PROVIDER || "groq", hasDynamicKey: false };
    }
    return { provider: record.provider || "groq", hasDynamicKey: true, updatedAt: record.updatedAt };
}

/**
 * Resolves the API key that should actually be used for the next
 * chatbot request: dynamic (admin-configured) key first, environment
 * variable fallback second.
 */
function getActiveApiKey() {
    const record = readRawConfig();
    if (record && record.apiKey) {
        try {
            return decrypt(record.apiKey);
        } catch (err) {
            console.error("[configStore] Failed to decrypt stored API key:", err.message);
            // fall through to env fallback rather than crashing the chatbot
        }
    }
    return process.env.AI_API_KEY || null;
}

/**
 * Returns a masked version of the currently active key for display in
 * the admin UI, e.g. "sk-************abcd". Never returns the full key.
 */
function getMaskedActiveKey() {
    const key = getActiveApiKey();
    if (!key) return null;
    if (key.length <= 8) return "*".repeat(key.length);
    const prefix = key.slice(0, key.startsWith("gsk_") ? 4 : 3);
    const suffix = key.slice(-4);
    return `${prefix}${"*".repeat(Math.max(4, key.length - prefix.length - 4))}${suffix}`;
}

module.exports = {
    setApiKey,
    getConfigSummary,
    getActiveApiKey,
    getMaskedActiveKey,
};
