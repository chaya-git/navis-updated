/* ═══════════════════════════════════════════════════════════
   NAVIS – Frontend Configuration
   ═══════════════════════════════════════════════════════════
   Set this to the base URL of your deployed backend (the one
   containing backend/server.js). The chatbot and Admin Settings
   page both read this value — you only need to change it here.

   Examples:
     - Same host / reverse-proxied under the frontend: ''
     - Separate host (Render, Railway, etc.): 'https://navis-backend.onrender.com'
*/
window.NAVIS_CONFIG = {
    BACKEND_URL: (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
        ? ''
        : 'https://navis-backend-fawn.onrender.com'
};