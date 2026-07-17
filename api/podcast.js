// Podcast route: fetches the episode's transcript from YouTube (or accepts a
// pasted one), then asks Claude to explain the episode, write the caption,
// and produce a Gemini thumbnail prompt. The API key never reaches the browser.

import { PODCAST_PROMPT } from "../prompts/podcast.js";

const RATE_LIMIT = 10; // podcast runs are heavier — 10 per hour per visitor
const RATE_WINDOW_MS = 60 * 60 * 1000;
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

const ANDROID_UA =
  "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n/g, " ");
}

// Pull the auto/manual captions for a YouTube video and join them into text.
// Uses YouTube's internal player API (Android client) — the plain watch-page
// caption URLs return empty bodies to server-side requests.
async function fetchTranscript(youtubeUrl) {
  const idMatch = String(youtubeUrl).match(
    /(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/
  );
  if (!idMatch) {
    throw new Error("Couldn't read a YouTube video ID from that link.");
  }
  const videoId = idMatch[1];

  const player = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ANDROID_UA },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
        videoId,
      }),
    }
  ).then((r) => r.json());

  const title = player?.videoDetails?.title || "";
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) {
    throw new Error(
      "NO_CAPTIONS: YouTube didn't give us subtitles for this video."
    );
  }
  const track =
    tracks.find((t) => (t.languageCode || "").startsWith("en")) || tracks[0];

  const xml = await fetch(track.baseUrl, {
    headers: { "user-agent": ANDROID_UA },
  }).then((r) => r.text());

  // timedtext format 3: <p t="..." d="...">text (possibly with <s> segments)</p>
  const parts = [...xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, ""))
  );
  const transcript = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!transcript) {
    throw new Error("NO_CAPTIONS: the subtitle track came back empty.");
  }
  return { transcript, title };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "Too many podcast runs this hour — try again later." });
  }

  const {
    youtubeUrl,
    guests,
    title,
    frames,
    styleNotes,
    revise,
    transcript: pastedTranscript,
  } = req.body || {};

  let transcript = (pastedTranscript || "").trim();
  let videoTitle = (title || "").trim();

  if (!transcript) {
    if (!youtubeUrl) {
      return res.status(400).json({
        error: "Upload the episode video, give a YouTube link, or paste the transcript.",
      });
    }
    try {
      const fetched = await fetchTranscript(youtubeUrl);
      transcript = fetched.transcript;
      if (!videoTitle) videoTitle = fetched.title;
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.startsWith("NO_CAPTIONS")) {
        return res.status(422).json({
          error:
            "That video has no subtitles I can read. Open it on YouTube, click \"...\" → \"Show transcript\", copy it, and paste it into the transcript box.",
        });
      }
      return res.status(422).json({ error: msg });
    }
  }

  const briefLines = ["PODCAST EPISODE"];
  if (videoTitle) briefLines.push(`Working title (user-supplied or from YouTube): ${videoTitle}`);
  if (guests) briefLines.push(`Guest(s): ${guests}`);

  // Screenshots from the episode go in as images so Claude can see the
  // setting and the guests — feeds the thumbnail prompt.
  const content = [];
  if (Array.isArray(frames) && frames.length) {
    briefLines.push(
      "",
      "The attached images are evenly-spaced screenshots from the episode, in order — use them for the setting and the guests' appearance in the thumbnail prompt, and to read any on-screen text."
    );
    for (const f of frames.slice(0, 10)) {
      if (typeof f === "string" && f) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: f },
        });
      }
    }
  }
  if (revise?.previousCaption && revise?.feedback) {
    briefLines.push(
      "",
      "PREVIOUS CAPTION (you wrote this):",
      String(revise.previousCaption).slice(0, 4000),
      "",
      `USER FEEDBACK on it: ${String(revise.feedback).slice(0, 500)}`,
      "Rewrite applying this feedback. Return the full JSON object again."
    );
  }
  briefLines.push("", "TRANSCRIPT:", transcript);
  content.push({ type: "text", text: briefLines.join("\n") });

  // Standing lessons from past feedback, appended to the house style
  let system = PODCAST_PROMPT;
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
    // re-send the conversation so Claude carries on until everything is done.
    let messages = [{ role: "user", content }];
    let data;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 10000,
          system,
          messages,
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
        error: "The write-up ran out of room — hit generate again.",
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
