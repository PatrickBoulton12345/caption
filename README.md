# LFG Caption Generator

Turns a story, image, or reel brief into one publish-ready TikTok / Instagram
caption in the LFG house style — fact-checked live against the web, with a
claims-and-sources panel so nothing gets published without the checks visible.

## How it works

- **Frontend** (`/public`) — a single page. You paste a brief and/or upload a
  key frame, hit generate, and get back an editable caption, a self-learning
  hashtag menu, and a sources panel on the right.
- **Backend** (`/api/generate.js`) — one Vercel serverless function that holds
  the Anthropic API key (as an environment variable, never in the browser) and
  forwards the request to Claude with the web search tool switched on, so every
  load-bearing claim is checked online before it goes in the caption.
- **The voice** lives in `/prompts/system.js` — edit that file to change how
  captions are written.

## Setting it up

1. Create an Anthropic API key at [console.anthropic.com](https://console.anthropic.com).
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import this
   GitHub repo (`PatrickBoulton12345/caption`).
3. Before deploying, open **Settings → Environment Variables** and add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from step 1
4. Deploy. Vercel serves `/public` as the site and runs `/api/generate`
   automatically. That's it — no build step, no installs.

## Nice to know

- **Progress bar** — generation takes ~15–40 seconds because of the live web
  searches. The bar estimates the time and gets smarter: it remembers how long
  your last 8 generations actually took.
- **Hashtag menu** — learns which tags you actually use, per topic. Claude's
  fresh suggestions come pre-selected; tags with an orange dot are your learned
  favourites. Learning is stored in the browser, so it's per-person for now.
  (To share one "brain" across the team later, the storage can be swapped for
  Vercel KV behind a small `/api/hashtags` route.)
- **Images** are resized in the browser before upload (max 1568px on the long
  edge), which keeps uploads fast and costs down.
- **Guardrails** — the key stays server-side only, and the generate route has a
  simple per-visitor limit (20 generations per hour) so a stray loop can't burn
  the budget.
- **Model** — currently `claude-sonnet-5` with the `web_search_20260209` search
  tool (both current as of July 2026). Swap the model to `claude-opus-4-8` in
  `/api/generate.js` for maximum quality at higher cost.
