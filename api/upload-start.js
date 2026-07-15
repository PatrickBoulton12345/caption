// Starts a direct-to-Google video upload and hands the browser a one-off
// upload address. The Gemini API key stays server-side (sent via header, so
// the returned upload URL carries no key).

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY is not set in Vercel — add it under Settings → Environment Variables.",
    });
  }

  const { filename, mimeType, sizeBytes } = req.body || {};
  if (!mimeType || !sizeBytes) {
    return res.status(400).json({ error: "Missing file details." });
  }
  const MAX_BYTES = 2 * 1024 * 1024 * 1024; // Gemini Files API limit: 2 GB
  if (sizeBytes > MAX_BYTES) {
    return res.status(413).json({
      error:
        "That file is over 2 GB, which is the upload limit. Export a smaller version (720p is plenty) and try again.",
    });
  }

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/upload/v1beta/files",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(sizeBytes),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          file: { display_name: filename || "upload" },
        }),
      }
    );
    if (!r.ok) {
      const detail = await r.text();
      return res
        .status(502)
        .json({ error: `Google refused the upload: ${detail.slice(0, 300)}` });
    }
    const uploadUrl = r.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      return res
        .status(502)
        .json({ error: "Google didn't return an upload address — try again." });
    }
    return res.status(200).json({ uploadUrl });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
