// Checks whether Google has finished processing an uploaded video.
// The browser polls this every few seconds after the upload completes.

export default async function handler(req, res) {
  const name = req.query?.name;
  if (!name || !/^files\/[\w-]+$/.test(name)) {
    return res.status(400).json({ error: "Bad file reference." });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}`,
      { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } }
    );
    const data = await r.json();
    if (!r.ok) {
      return res
        .status(502)
        .json({ error: data.error?.message || "Couldn't check the video." });
    }
    // state: PROCESSING → ACTIVE (ready) or FAILED
    return res.status(200).json({ state: data.state, uri: data.uri });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
