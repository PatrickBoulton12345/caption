// Serverless proxy to the Anthropic API.
// The API key lives in the ANTHROPIC_API_KEY environment variable on Vercel —
// it never reaches the browser.

import { SYSTEM_PROMPT } from "../prompts/system.js";

// Simple per-IP rate limit so a stray loop can't burn the budget.
// In-memory, so it resets when the function cold-starts — that's fine for this.
const RATE_LIMIT = 20; // generations per window
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > RATE_WINDOW_MS) {
    rec.count = 0;
    rec.start = now;
  }
  rec.count += 1;
  hits.set(ip, rec);
  return rec.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "Too many generations this hour — try again later." });
  }

  const { brief, imageBase64, imageMediaType, videoTranscript, frames } =
    req.body || {};
  if (!brief && !imageBase64 && !videoTranscript) {
    return res
      .status(400)
      .json({ error: "Provide a brief, an image, a video, or a mix." });
  }

  // Build the user message: images first (key frame and/or video screenshots),
  // then the text material
  const content = [];
  if (imageBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType || "image/jpeg",
        data: imageBase64,
      },
    });
  }
  if (Array.isArray(frames)) {
    for (const f of frames.slice(0, 10)) {
      if (typeof f === "string" && f) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: f },
        });
      }
    }
  }

  const textParts = [];
  if (brief) textParts.push(brief);
  if (videoTranscript) {
    textParts.push(
      "TRANSCRIPT OF THE UPLOADED VIDEO (treat this as the reel's content" +
        (Array.isArray(frames) && frames.length
          ? "; the attached images are screenshots from it, in order"
          : "") +
        "):\n" +
        videoTranscript
    );
  }
  content.push({
    type: "text",
    text: textParts.join("\n\n") || "No brief provided. Work from the image.",
  });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY, // set in Vercel env, never in code
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        // Server-side web search — Anthropic runs the searches, no tool loop needed.
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      }),
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
