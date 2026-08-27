/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Minimal admin authentication. This project had no existing
 * auth/admin system, so this adds the smallest thing that is
 * still secure: a single admin account defined via environment
 * variables, issuing short-lived JWTs for the admin API-key
 * management endpoints.
 *
 * If you later add a full user/admin database, replace
 * `verifyAdminCredentials` with a real lookup — nothing else in
 * this file (or the routes that use it) needs to change.
 */

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const TOKEN_TTL = "12h";

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET environment variable is not set.");
    }
    return secret;
}

/**
 * Verifies admin credentials against environment configuration.
 * Supports either:
 *  - ADMIN_PASSWORD_HASH (a bcrypt hash) — recommended for production
 *  - ADMIN_PASSWORD (plain text) — convenient for local/dev setup only
 */
async function verifyAdminCredentials(username, password) {
    const expectedUsername = process.env.ADMIN_USERNAME;
    const passwordHash = process.env.ADMIN_PASSWORD_HASH;
    const plainPassword = process.env.ADMIN_PASSWORD;

    if (!expectedUsername || (!passwordHash && !plainPassword)) {
        throw new Error(
            "Admin credentials are not configured. Set ADMIN_USERNAME and either " +
            "ADMIN_PASSWORD_HASH (recommended) or ADMIN_PASSWORD in your environment."
        );
    }

    if (username !== expectedUsername) return false;

    if (passwordHash) {
        return bcrypt.compare(password, passwordHash);
    }
    // Constant-time-ish comparison isn't critical here since this is a
    // dev-convenience fallback; bcrypt.compare is used above in prod.
    return password === plainPassword;
}

function issueToken(username) {
    return jwt.sign({ sub: username, role: "admin" }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

/**
 * Express middleware: requires a valid `Authorization: Bearer <token>`
 * header issued by issueToken(). Attaches req.admin on success.
 */
function requireAdmin(req, res, next) {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
        return res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
    }

    try {
        const payload = jwt.verify(token, getJwtSecret());
        if (payload.role !== "admin") throw new Error("not admin");
        req.admin = payload;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: "Invalid or expired session, please log in again" });
    }
}

module.exports = {
    verifyAdminCredentials,
    issueToken,
    requireAdmin,
};
