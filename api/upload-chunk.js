// Relays one piece of a video upload to Google. Browsers can't talk to
// Google's upload endpoint directly (no CORS), so the file arrives here in
// ~4 MB pieces and each is passed along to the resumable upload session.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const uploadUrl = req.headers["x-upload-url"];
  const offset = req.headers["x-upload-offset"];
  const command = req.headers["x-upload-command"]; // "upload" | "upload, finalize"

  if (
    !uploadUrl ||
    !uploadUrl.startsWith("https://generativelanguage.googleapis.com/") ||
    !/^\d+$/.test(offset || "") ||
    !["upload", "upload, finalize"].includes(command)
  ) {
    return res.status(400).json({ error: "Bad upload piece." });
  }

  try {
    const body = Buffer.isBuffer(req.body) ? req.body : await readRawBody(req);

    const r = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": command,
        "X-Goog-Upload-Offset": offset,
        "Content-Length": String(body.length),
      },
      body,
    });
    const text = await r.text();
    if (!r.ok) {
      return res
        .status(502)
        .json({ error: `Google rejected an upload piece: ${text.slice(0, 200)}` });
    }

    // Intermediate pieces return an empty body; the final piece returns the
    // file info JSON we need.
    let file = null;
    if (command.includes("finalize") && text) {
      try {
        file = JSON.parse(text).file || null;
      } catch {
        /* leave null; frontend will report it */
      }
    }
    return res.status(200).json({ ok: true, file });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
