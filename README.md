# LFG Caption Generator

Turns a story, image, or reel brief into one publish-ready TikTok / Instagram
caption in the LFG house style — fact-checked live against the web, with a
claims-and-sources panel so nothing gets published without the checks visible.

Two modes:

- **story / reel** — paste a story or one-line brief, optionally drop in a key
  frame image, get a caption.
- **podcast** — drop the episode video straight onto the site (up to 2 GB; a
  YouTube link or pasted transcript also works). The whole episode is watched
  and listened to — audio transcribed, on-screen text read — then you get: a
  plain-English explainer (what it's about + why it matters, so you can write
  the title), the caption, hashtags, sources, and a ready-to-paste Gemini
  prompt for a striking guest thumbnail in LFG colours.

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
3. Create a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   (free tier is fine) — this powers the video watching/transcription.
4. Before deploying, open **Settings → Environment Variables** and add both:
   - Name: `ANTHROPIC_API_KEY` — value: your key from step 1
   - Name: `GEMINI_API_KEY` — value: your key from step 3
5. Deploy. Vercel serves `/public` as the site and runs the `/api` routes
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
- **Videos** — uploaded videos travel to Google's servers in ~4 MB pieces
  relayed through the site (browsers can't deliver to Google's upload door
  directly), up to 2 GB. Gemini
  transcribes the audio and reads the frames — like the Whisper-plus-
  screenshots routine, done by a service built for it. The transcript and
  visual notes then go to Claude for the caption. A 40-minute episode takes a
  few minutes end to end; the progress bar narrates each stage.
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
