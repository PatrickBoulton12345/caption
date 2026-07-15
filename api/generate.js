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

  const {
    brief,
    images,
    imageBase64,
    imageMediaType,
    videoTranscript,
    frames,
    styleNotes,
    revise,
  } = req.body || {};
  const imageList = Array.isArray(images) ? images.filter((s) => typeof s === "string" && s) : [];
  if (!brief && !imageList.length && !imageBase64 && !videoTranscript) {
    return res
      .status(400)
      .json({ error: "Provide a brief, images, a video, or a mix." });
  }

  // Build the user message: images first (carousel and/or video screenshots),
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
  for (const im of imageList.slice(0, 10)) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: im },
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
  if (imageList.length > 1) {
    textParts.push(
      `The ${imageList.length} attached images are an Instagram carousel, in order. Write ONE caption for the whole set — hook on the strongest detail across them.`
    );
  }
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
  if (revise?.previousCaption && revise?.feedback) {
    textParts.push(
      `PREVIOUS CAPTION (you wrote this):\n${String(revise.previousCaption).slice(0, 4000)}\n\n` +
        `USER FEEDBACK on it: ${String(revise.feedback).slice(0, 500)}\n\n` +
        "Rewrite the caption applying this feedback. Return the full JSON object again."
    );
  }
  content.push({
    type: "text",
    text: textParts.join("\n\n") || "No brief provided. Work from the image.",
  });

  // Standing lessons from past feedback, appended to the house style
  let system = SYSTEM_PROMPT;
  if (Array.isArray(styleNotes) && styleNotes.length) {
    system +=
      "\n\n===========================================================================\n" +
      "STANDING STYLE NOTES FROM THE USER (accumulated feedback — always follow)\n" +
      "===========================================================================\n" +
      styleNotes
        .slice(-20)
        .map((s) => "- " + String(s).slice(0, 300))
        .join("\n");
  }

  try {
    // The web-search loop can pause mid-turn (stop_reason "pause_turn") —
    // re-send the conversation so Claude carries on until the caption is done.
    let messages = [{ role: "user", content }];
    let data;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY, // set in Vercel env, never in code
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 4000,
          system,
          messages,
          // Server-side web search — Anthropic runs the searches.
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
        }),
      });
      data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      if (data.stop_reason === "pause_turn") {
        messages = [
          { role: "user", content },
          { role: "assistant", content: data.content },
        ];
        continue;
      }
      break;
    }
    if (data.stop_reason === "max_tokens") {
      return res.status(502).json({
        error: "The caption ran out of writing room — hit generate again.",
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
