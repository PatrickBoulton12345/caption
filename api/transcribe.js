// Asks Gemini to watch the uploaded video: full transcript from the audio,
// plus visual notes from the frames (on-screen text, setting, guests) — the
// same "listen + read the screen" combination, in one pass.

const GEMINI_MODEL = "gemini-3.5-flash";

const RATE_LIMIT = 10;
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

const INSTRUCTIONS = `You are given a video (a podcast episode or a social media clip).
Watch and listen to the whole thing, then output EXACTLY this structure:

===TRANSCRIPT===
A full, faithful transcript of everything said, in order. Label speakers where
you can tell them apart (Host:, Guest:, or their names if stated or shown on
screen). Do not summarise or skip sections.

===VISUAL NOTES===
A compact description of what's on screen: the setting, each visible person and
their appearance, any on-screen text/captions/lower-thirds/graphics (quote them
exactly), and the most striking visual moments with rough timestamps.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "Too many video runs this hour — try again later." });
  }

  const { fileUri, mimeType } = req.body || {};
  if (!fileUri || !fileUri.startsWith("https://generativelanguage.googleapis.com/")) {
    return res.status(400).json({ error: "Bad video reference." });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { file_data: { file_uri: fileUri, mime_type: mimeType || "video/mp4" } },
                { text: INSTRUCTIONS },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 32768, temperature: 0.2 },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({
        error: data.error?.message || "Transcription failed — try again.",
      });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");

    const transcriptMatch = text.split("===TRANSCRIPT===")[1] || text;
    const [transcript, visualNotes = ""] =
      transcriptMatch.split("===VISUAL NOTES===");

    if (!transcript.trim()) {
      return res
        .status(502)
        .json({ error: "The transcript came back empty — try again." });
    }
    return res.status(200).json({
      transcript: transcript.trim(),
      visualNotes: visualNotes.trim(),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
