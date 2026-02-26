# WebCloner.ai 🔮

Clone any webpage, modify it with AI, push to GitHub.

## Why this works differently

Unlike the single-file version, this uses a **Netlify serverless function** as a proxy (`/api/proxy`). The function runs on Netlify's servers and fetches the target URL server-side — bypassing all browser CORS restrictions.

## Deploy in 3 minutes

### Option A: Netlify CLI
```bash
npm install -g netlify-cli
npm install
netlify login
netlify deploy --build --prod
```

### Option B: GitHub → Netlify UI
1. Push this folder to a GitHub repo
2. Go to [app.netlify.com](https://app.netlify.com) → "Add new site" → "Import from Git"
3. Select your repo, build command: `npm run build`, publish dir: `dist`
4. Click **Deploy** — done!

## Local dev
```bash
npm install
netlify dev   # runs Vite + Netlify functions together on localhost:8888
```

## How it works
- **`/api/proxy?url=...`** — Netlify function that fetches any URL server-side with browser-like headers
- **React frontend** — 3-tab UI: Preview, Code editor, AI Chat
- **AI modifications** — Uses Claude API to apply natural-language changes to HTML
- **GitHub push** — Saves final HTML directly to any GitHub repo via API

## Stack
- React + TypeScript + Vite
- Netlify Functions (serverless proxy)
- Claude API (AI edits)
- GitHub API (save/deploy)
