// Frayt frontend config — edit this AFTER you deploy the backend.
// Paste your Render backend URL below (the one ending in .onrender.com)
// Leave the trailing "/api" in place.
window.FRAYT_CONFIG = {
  apiBase: 'http://localhost:3001/api',    // ← replace with https://YOUR-APP.onrender.com/api
  merchantKey: 'demo-merchant-key',         // ← match MERCHANT_API_KEY env var on Render
};
