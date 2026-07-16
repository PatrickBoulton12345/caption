// Fetches a Wikimedia image through the site so the thumbnail canvas can use
// it (browsers block canvases from exporting images drawn straight from other
// sites). Wikimedia only — nothing else can be fetched through this.

export default async function handler(req, res) {
  let u;
  try {
    u = new URL(String(req.query?.url || ""));
  } catch {
    return res.status(400).json({ error: "Bad image address." });
  }
  if (u.protocol !== "https:" || u.hostname !== "upload.wikimedia.org") {
    return res.status(400).json({ error: "Only Wikimedia images can be fetched." });
  }

  try {
    const r = await fetch(u, {
      headers: { "user-agent": "LFG-caption-site/1.0 (patrick@lookingforgrowth.uk)" },
    });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) {
      return res.status(502).json({ error: "Couldn't fetch that image." });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large." });
    }
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "s-maxage=604800, immutable");
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
