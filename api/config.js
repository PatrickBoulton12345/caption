// Tells the frontend where the transcription server lives.
// Set TRANSCRIBER_URL in Vercel env vars (the workers.dev address from
// deploying /cloudflare), or the default below once it's known.

const DEFAULT_TRANSCRIBER_URL =
  "https://lfg-transcriber.patrickboulton44.workers.dev";

export default function handler(req, res) {
  res
    .status(200)
    .json({ transcriberUrl: process.env.TRANSCRIBER_URL || DEFAULT_TRANSCRIBER_URL });
}
