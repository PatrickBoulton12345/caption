// LFG transcriber — runs on Cloudflare Workers AI.
// Receives one piece of audio (a ~5-minute WAV) and returns its transcript,
// using Whisper running on Cloudflare's servers.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/transcribe") {
      return json({ error: "POST /transcribe only" }, 404);
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return json({ error: "No audio received." }, 400);
    if (bytes.length > 25 * 1024 * 1024) {
      return json({ error: "Audio piece too large." }, 413);
    }

    // base64-encode in steps (all at once overflows the stack)
    let bin = "";
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    const audio = btoa(bin);

    try {
      const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio });
      return json({ text: (out.text || "").trim() });
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
