# Frayt — Deployment Guide

Frayt is a Jordanian fintech prototype that digitizes coin change at the point of sale.

## Structure
- `index.html` + `config.js` → the frontend (deployed to Netlify)
- `backend/` → Node.js + Express + SQLite API (deployed to Render)

---

## Deploying for free

### Step 1 — Create a GitHub account (if you haven't)
Go to [github.com/signup](https://github.com/signup) and sign up. Takes 2 minutes.

### Step 2 — Put this project on GitHub
1. Log into GitHub. Click the green **New** button (top left) to create a repo.
2. Name it `frayt`. Choose **Public**. Click **Create repository**.
3. On the new-repo page, click **uploading an existing file**.
4. Drag the ENTIRE `frayt` folder contents into the browser window (NOT the folder itself — open it and drag what's inside).
5. Scroll down, click **Commit changes**.

### Step 3 — Deploy the backend to Render
1. Go to [render.com](https://render.com) and click **Get Started**.
2. Sign in with GitHub (authorize access when prompted).
3. From the Render dashboard, click **New +** → **Blueprint**.
4. Select the `frayt` repo. Render will read `render.yaml` and show one service: `frayt-api`.
5. Click **Apply**. Render will build and start the service — takes ~2 minutes.
6. When it's live, copy the URL (it looks like `https://frayt-api-xxxx.onrender.com`).
7. Still in Render, click your service → **Environment** tab → edit `MERCHANT_API_KEY` → copy its value (you'll need it in step 5).

### Step 4 — Deploy the frontend to Netlify
1. Go to [netlify.com](https://netlify.com) and click **Sign up** → sign in with GitHub.
2. Click **Add new site** → **Import an existing project** → **GitHub**.
3. Pick the `frayt` repo.
4. Leave all settings as default (Publish directory = `.`). Click **Deploy site**.
5. Wait ~30 seconds. Copy the Netlify URL (looks like `https://something-cool.netlify.app`).

### Step 5 — Connect the two
1. Back on **Render** → your service → **Environment** → edit `ALLOWED_ORIGINS`:
   ```
   https://your-site.netlify.app
   ```
   Click **Save Changes**. Render will restart the service.

2. In your **GitHub** repo → click `config.js` → click the pencil (edit) icon. Replace the file with:
   ```js
   window.FRAYT_CONFIG = {
     apiBase: 'https://frayt-api-xxxx.onrender.com/api',  // ← YOUR Render URL + /api
     merchantKey: 'YOUR-MERCHANT-KEY',                      // ← paste the value from step 3
   };
   ```
   Commit the change. Netlify auto-redeploys in ~30 seconds.

### Step 6 — Test
1. Open your Netlify URL in a browser.
2. You should see the "API Connected" green pill (may take 30–60s on first load — Render free tier cold-starts).
3. Tap **Get Started** → enter OTP `1234` → you're in.

---

## Free-tier trade-offs
- **Render free tier:** spins down after 15 min idle, cold-start ~30–60s, ephemeral disk (SQLite resets on restart). Acceptable for demo; migrate to Postgres for persistence.
- **Netlify free tier:** 100 GB bandwidth/month, plenty for a demo.

## Updating the app later
- Edit files → commit to GitHub → both Render and Netlify auto-redeploy.

## Local development
```bash
# Terminal 1 — backend
cd backend
npm install
node server.js

# Terminal 2 — frontend
python3 -m http.server 8765
# Open http://localhost:8765
```

Dev OTP: `1234`. Seeded demo user: `+962791114821` (Leen).
