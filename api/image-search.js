// Searches Wikimedia Commons (the free image library behind Wikipedia) for
// photos related to the video, to offer as thumbnail backgrounds.

export default async function handler(req, res) {
  const q = String(req.query?.q || "").slice(0, 100).trim();
  if (!q) return res.status(400).json({ error: "No search given." });

  try {
    const u = new URL("https://commons.wikimedia.org/w/api.php");
    u.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: q,
      gsrnamespace: "6", // File: pages only
      gsrlimit: "10",
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: "1280",
      format: "json",
      origin: "*",
    }).toString();

    const data = await fetch(u, {
      headers: {
        "user-agent": "LFG-caption-site/1.0 (patrick@lookingforgrowth.uk)",
      },
    }).then((r) => r.json());

    const pages = Object.values(data?.query?.pages || {});
    const images = pages
      .map((p) => ({ info: p.imageinfo?.[0], title: p.title || "" }))
      .filter((x) => x.info && /image\/(jpeg|png|webp)/.test(x.info.mime || ""))
      .map((x) => ({
        url: x.info.thumburl || x.info.url,
        title: x.title.replace(/^File:/, ""),
      }))
      .slice(0, 8);

    res.setHeader("cache-control", "s-maxage=86400");
    return res.status(200).json({ images });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
