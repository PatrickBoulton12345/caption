# LFG Caption Generator

Turns a story, image, or reel brief into one publish-ready TikTok / Instagram
caption in the LFG house style — fact-checked live against the web, with a
claims-and-sources panel so nothing gets published without the checks visible.

Two modes:

- **story / reel** — paste a story or one-line brief, optionally drop in a key
  frame image, get a caption.
- **podcast** — drop the episode video straight onto the site (a YouTube link
  or pasted transcript also works). The audio is transcribed by Whisper on the
  LFG transcription server (Cloudflare), with the transcript appearing live on
  the page, and screenshots are grabbed for Claude to look at — then you get:
  a plain-English explainer (what it's about + why it matters, so you can
  write the title), the caption, hashtags, sources, and a ready-to-paste
  Gemini prompt for a striking guest thumbnail in LFG colours.

The story/reel box also takes a video — drop a reel in and its transcript and
visuals become the caption material.

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
   - Name: `ANTHROPIC_API_KEY` — value: your key from step 1
4. Deploy. Vercel serves `/public` as the site and runs the `/api` routes
   automatically. That's it — no build step, no installs, no other keys.

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
- **Videos** — the browser pulls the audio track out and sends it in 5-minute
  pieces to the LFG transcription server (a Cloudflare Worker in `/cloudflare`
  running Whisper on Cloudflare's servers). The transcript fills in live on
  the page as each piece comes back, with real progress and measured time
  left. Screenshots are grabbed in the browser and sent to Claude alongside
  the transcript. Files up to ~700 MB — export at 720p for comfort.
- **Transcription server** — deployed from `/cloudflare` with
  `npx wrangler deploy` (already live at
  `lfg-transcriber.patrickboulton44.workers.dev`; the site finds it via
  `/api/config`, overridable with a `TRANSCRIBER_URL` env var in Vercel).
  Uses Cloudflare Workers AI (`whisper-large-v3-turbo`) — generous free
  allowance, then pennies per episode.
- **Podcasts from YouTube** still work too — the site fetches the video's
  subtitles from the link. If a video has no subtitles, paste the transcript
  (YouTube → "…" → "Show transcript") into the transcript box. You write the
  episode title; the site gives you the explainer to inform it.
- **Guardrails** — the key stays server-side only, and both routes have a
  simple per-visitor limit (20 caption / 10 podcast runs per hour) so a stray
  loop can't burn the budget.
- **Model** — currently `claude-sonnet-5` with the `web_search_20260209` search
  tool (both current as of July 2026). Swap the model to `claude-opus-4-8` in
  `/api/generate.js` for maximum quality at higher cost.
