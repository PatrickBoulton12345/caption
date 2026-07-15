/* LFG Caption Generator — frontend logic
   - generate flow with a self-calibrating progress bar + ETA
   - self-learning hashtag menu (localStorage)
   - add-to-caption + copy */

// ---------------------------------------------------------------------------
// ETA calibration — rolling average of the last 8 real generation times
// ---------------------------------------------------------------------------
// Story and podcast runs take different amounts of time, so each mode
// calibrates its own estimate.
const ETA_KEYS = { story: "lfg_eta_samples", podcast: "lfg_eta_samples_podcast" };
const ETA_DEFAULTS = { story: 28000, podcast: 50000 };

function getEta(mode) {
  const s = JSON.parse(localStorage.getItem(ETA_KEYS[mode]) || "[]");
  if (!s.length) return ETA_DEFAULTS[mode];
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function recordEta(mode, ms) {
  const s = JSON.parse(localStorage.getItem(ETA_KEYS[mode]) || "[]");
  s.push(ms);
  while (s.length > 8) s.shift();
  localStorage.setItem(ETA_KEYS[mode], JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// Self-learning hashtag store
// { "#fyp": { count: 42, lastUsed: 1699999999, topics: { energy: 10 } }, ... }
// ---------------------------------------------------------------------------
const HTAG_KEY = "lfg_hashtags";
const loadTags = () => JSON.parse(localStorage.getItem(HTAG_KEY) || "{}");
const saveTags = (o) => localStorage.setItem(HTAG_KEY, JSON.stringify(o));

function suggestMenu(topic, freshFromClaude) {
  const store = loadTags();
  const all = Object.entries(store);
  const learned = all
    .filter(([, v]) => v.topics?.[topic])
    .sort((a, b) => b[1].topics[topic] - a[1].topics[topic])
    .slice(0, 8)
    .map(([t]) => t);
  const evergreen = all
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([t]) => t);
  // fresh picks first (pre-selected), then learned, then evergreen; dedupe
  return [...new Set([...freshFromClaude, ...learned, ...evergreen])];
}

// Called by "Add to caption" — this is the learning step
function reinforce(selectedTags, topic) {
  const store = loadTags();
  const now = Date.now();
  for (const t of selectedTags) {
    const e = store[t] || { count: 0, lastUsed: 0, topics: {} };
    e.count += 1;
    e.lastUsed = now;
    e.topics[topic] = (e.topics[topic] || 0) + 1;
    store[t] = e;
  }
  saveTags(store);
}

function isLearned(tag, topic) {
  const store = loadTags();
  return Boolean(store[tag]?.topics?.[topic]);
}

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const briefEl = $("brief");
const imageInput = $("image");
const pickImageBtn = $("pick-image");
const thumbBox = $("thumb-box");
const thumbEl = $("thumb");
const clearImageBtn = $("clear-image");
const generateBtn = $("generate");
const progressEl = $("progress");
const barEl = $("bar");
const etaEl = $("eta");
const errorEl = $("error");
const resultsEl = $("results");
const captionEl = $("caption");
const topicBadge = $("topic-badge");
const chipsEl = $("chips");
const newTagInput = $("new-tag");
const addTagBtn = $("add-tag");
const addToCaptionBtn = $("add-to-caption");
const copyBtn = $("copy");
const sourcingEl = $("sourcing");
const sourcesPanel = $("sources-panel");
const searchedBlock = $("searched-block");
const searchedEl = $("searched");

const tabStory = $("tab-story");
const tabPodcast = $("tab-podcast");
const storyPanel = $("story-panel");
const podcastPanel = $("podcast-panel");
const podcastUrlEl = $("podcast-url");
const podcastGuestsEl = $("podcast-guests");
const podcastTitleEl = $("podcast-title");
const podcastTranscriptEl = $("podcast-transcript");
const aboutCard = $("about-card");
const aboutText = $("about-text");
const whyText = $("why-text");
const thumbnailCard = $("thumbnail-card");
const thumbnailPromptEl = $("thumbnail-prompt");
const copyThumbnailBtn = $("copy-thumbnail");

const storyFileName = $("story-file-name");
const podcastVideoInput = $("podcast-video");
const pickPodcastVideoBtn = $("pick-podcast-video");
const podcastVideoBox = $("podcast-video-box");
const podcastVideoThumb = $("podcast-video-thumb");
const clearPodcastVideoBtn = $("clear-podcast-video");
const podcastVideoName = $("podcast-video-name");
const podcastDropCard = $("podcast-drop-card");

let currentImage = null; // { base64, mediaType }
let currentVideo = null; // File (story/reel video)
let podcastVideo = null; // File (podcast episode video)
let currentTopic = "other";
let hashtagsAdded = false;
let mode = "story"; // "story" | "podcast"

// ---------------------------------------------------------------------------
// Mode tabs
// ---------------------------------------------------------------------------
function setMode(next) {
  mode = next;
  const story = mode === "story";
  storyPanel.hidden = !story;
  podcastPanel.hidden = story;
  tabStory.classList.toggle("active", story);
  tabPodcast.classList.toggle("active", !story);
  tabStory.setAttribute("aria-selected", String(story));
  tabPodcast.setAttribute("aria-selected", String(!story));
  generateBtn.textContent = story ? "generate caption" : "read podcast & generate";
  errorEl.hidden = true;
}
tabStory.addEventListener("click", () => setMode("story"));
tabPodcast.addEventListener("click", () => setMode("podcast"));

// ---------------------------------------------------------------------------
// Image upload — downscale to max 1568px long edge so uploads stay small
// and image tokens stay cheap
// ---------------------------------------------------------------------------
const dropCard = $("drop-card");

// orange glow that sweeps from the top of the box downwards, then settles
function sweepGlow(card, hasFile) {
  card.classList.remove("glow-sweep", "has-image");
  void card.offsetWidth; // restart the animation if it already ran
  if (hasFile) card.classList.add("glow-sweep");
}
[dropCard, podcastDropCard].forEach((card) =>
  card.addEventListener("animationend", () => {
    card.classList.remove("glow-sweep");
    card.classList.add("has-image");
  })
);

// grab a frame from a video file to use as its thumbnail
function videoPoster(file, cb) {
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  v.src = URL.createObjectURL(file);
  v.onloadeddata = () => {
    v.currentTime = Math.min(1, (v.duration || 2) / 2);
  };
  v.onseeked = () => {
    const c = document.createElement("canvas");
    const scale = Math.min(1, 320 / (v.videoWidth || 320));
    c.width = Math.max(1, Math.round(v.videoWidth * scale));
    c.height = Math.max(1, Math.round(v.videoHeight * scale));
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    cb(c.toDataURL("image/jpeg", 0.7));
    URL.revokeObjectURL(v.src);
  };
  v.onerror = () => cb(null);
}

function prettySize(bytes) {
  return bytes > 1024 * 1024 * 1024
    ? (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB"
    : Math.round(bytes / (1024 * 1024)) + " MB";
}

// ----- story tab: one box takes an image OR a video -----
pickImageBtn.addEventListener("click", () => imageInput.click());

function handleStoryFile(file) {
  if (!file) return;

  if (file.type.startsWith("video/")) {
    currentVideo = file;
    currentImage = null;
    storyFileName.textContent = `${file.name} (${prettySize(file.size)})`;
    videoPoster(file, (dataUrl) => {
      if (dataUrl) {
        thumbEl.src = dataUrl;
        thumbBox.hidden = false;
      }
    });
    sweepGlow(dropCard, true);
    return;
  }

  if (!file.type.startsWith("image/")) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const MAX = 1568;
    let { width, height } = img;
    const scale = Math.min(1, MAX / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    currentImage = { base64: dataUrl.split(",")[1], mediaType: "image/jpeg" };
    currentVideo = null;
    storyFileName.textContent = "";
    thumbEl.src = dataUrl;
    thumbBox.hidden = false;
    URL.revokeObjectURL(url);
    sweepGlow(dropCard, true);
  };
  img.src = url;
}

imageInput.addEventListener("change", () => handleStoryFile(imageInput.files[0]));

clearImageBtn.addEventListener("click", () => {
  currentImage = null;
  currentVideo = null;
  imageInput.value = "";
  thumbBox.hidden = true;
  storyFileName.textContent = "";
  dropCard.classList.remove("glow-sweep", "has-image");
});

// ----- podcast tab: episode video box -----
pickPodcastVideoBtn.addEventListener("click", () => podcastVideoInput.click());

function handlePodcastFile(file) {
  if (!file || !(file.type.startsWith("video/") || file.type.startsWith("audio/"))) return;
  podcastVideo = file;
  podcastVideoName.textContent = `${file.name} (${prettySize(file.size)})`;
  if (file.type.startsWith("video/")) {
    videoPoster(file, (dataUrl) => {
      if (dataUrl) {
        podcastVideoThumb.src = dataUrl;
        podcastVideoBox.hidden = false;
      }
    });
  }
  sweepGlow(podcastDropCard, true);
}

podcastVideoInput.addEventListener("change", () =>
  handlePodcastFile(podcastVideoInput.files[0])
);

clearPodcastVideoBtn.addEventListener("click", () => {
  podcastVideo = null;
  podcastVideoInput.value = "";
  podcastVideoBox.hidden = true;
  podcastVideoName.textContent = "";
  podcastDropCard.classList.remove("glow-sweep", "has-image");
});

// ----- drag & drop for both boxes -----
function wireDrop(card, onFile) {
  ["dragenter", "dragover"].forEach((evt) =>
    card.addEventListener(evt, (e) => {
      e.preventDefault();
      card.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    card.addEventListener(evt, (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
    })
  );
  card.addEventListener("drop", (e) => onFile(e.dataTransfer?.files?.[0]));
}
wireDrop(dropCard, handleStoryFile);
wireDrop(podcastDropCard, handlePodcastFile);

// ---------------------------------------------------------------------------
// Generate flow with time-estimate-driven progress bar
// ---------------------------------------------------------------------------
// Stage-aware progress controller: real percentages while uploading,
// time-estimate creep for the waiting stages.
const progress = {
  raf: null,
  set(frac, label) {
    barEl.style.width = (frac * 100).toFixed(1) + "%";
    etaEl.textContent = label;
  },
  creep(from, to, ms, label) {
    cancelAnimationFrame(this.raf);
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      const remain = Math.max(0, Math.ceil((ms - (performance.now() - start)) / 1000));
      this.set(
        from + (to - from) * t,
        typeof label === "function" ? label(remain) : label
      );
      if (t < 1) this.raf = requestAnimationFrame(tick);
    };
    tick();
  },
  stop() {
    cancelAnimationFrame(this.raf);
  },
};

// ----- video pipeline: upload direct to Google → wait → transcribe -----
async function uploadVideo(file, onPct) {
  const startResp = await fetch("/api/upload-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || "video/mp4",
      sizeBytes: file.size,
    }),
  });
  const startData = await startResp.json();
  if (!startResp.ok) throw new Error(startData.error || "Upload couldn't start.");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", startData.uploadUrl);
    xhr.setRequestHeader("X-Goog-Upload-Command", "upload, finalize");
    xhr.setRequestHeader("X-Goog-Upload-Offset", "0");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onPct(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText).file); // { name, uri, state }
      } catch {
        reject(new Error("Upload finished but the reply was unreadable — try again."));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Upload failed — check your connection and try again."));
    xhr.send(file);
  });
}

async function waitUntilReady(fileName) {
  for (let i = 0; i < 120; i++) { // up to ~8 minutes
    const r = await fetch(`/api/video-status?name=${encodeURIComponent(fileName)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Couldn't check the video.");
    if (d.state === "ACTIVE") return d;
    if (d.state === "FAILED") {
      throw new Error("Google couldn't process that video — try a different export.");
    }
    await new Promise((s) => setTimeout(s, 4000));
  }
  throw new Error("The video is taking too long to process — try again in a minute.");
}

async function transcribeVideo(fileUri, mimeType) {
  const r = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileUri, mimeType }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Transcription failed — try again.");
  return d; // { transcript, visualNotes }
}

generateBtn.addEventListener("click", async () => {
  const runMode = mode;
  const videoFile = runMode === "story" ? currentVideo : podcastVideo;

  // validation
  if (runMode === "story") {
    if (!briefEl.value.trim() && !currentImage && !videoFile) {
      showError("Give me a brief, an image, or a video.");
      return;
    }
  } else if (!videoFile && !podcastUrlEl.value.trim() && !podcastTranscriptEl.value.trim()) {
    showError("Upload the episode video (or give a YouTube link / paste the transcript).");
    return;
  }

  errorEl.hidden = true;
  generateBtn.disabled = true;
  progressEl.hidden = false;
  progress.set(0, "starting…");

  try {
    // 1–3. video stages (only when a file was dropped)
    let videoData = null;
    if (videoFile) {
      const info = await uploadVideo(videoFile, (pct) =>
        progress.set(pct * 0.3, `uploading… ${Math.round(pct * 100)}%`)
      );
      progress.creep(0.3, 0.5, 90000, "google is taking the video in…");
      const ready = await waitUntilReady(info.name);
      progress.creep(0.5, 0.8, 150000, "transcribing + reading what's on screen…");
      videoData = await transcribeVideo(ready.uri || info.uri, videoFile.type || "video/mp4");
    }

    // 4. caption stage
    let endpoint, payload;
    if (runMode === "story") {
      endpoint = "/api/generate";
      payload = {
        brief: briefEl.value.trim(),
        imageBase64: currentImage?.base64,
        imageMediaType: currentImage?.mediaType,
        videoTranscript: videoData?.transcript,
        visualNotes: videoData?.visualNotes,
      };
    } else {
      endpoint = "/api/podcast";
      payload = videoData
        ? {
            transcript: videoData.transcript,
            visualNotes: videoData.visualNotes,
            guests: podcastGuestsEl.value.trim(),
            title: podcastTitleEl.value.trim(),
          }
        : {
            youtubeUrl: podcastUrlEl.value.trim(),
            transcript: podcastTranscriptEl.value.trim(),
            guests: podcastGuestsEl.value.trim(),
            title: podcastTitleEl.value.trim(),
          };
    }

    const base = videoFile ? 0.8 : 0;
    const eta = getEta(runMode);
    progress.creep(base, 0.96, eta, (s) =>
      videoFile ? "writing the caption…" : `~${s}s remaining`
    );

    const capStart = performance.now();
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    progress.stop();
    if (!resp.ok) {
      throw new Error(data.error?.message || data.error || `Server error (${resp.status})`);
    }
    progress.set(1, "Done");
    recordEta(runMode, performance.now() - capStart);

    const result = parseModelJson(data);
    renderResult(result, extractSearchedPages(data), runMode);
  } catch (e) {
    progress.stop();
    etaEl.textContent = "Error — try again";
    showError(String(e.message || e));
  } finally {
    generateBtn.disabled = false;
    setTimeout(() => (progressEl.hidden = true), 1500);
  }
});

// Pull the JSON object out of the model's text blocks
function parseModelJson(data) {
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  // be tolerant of any stray text around the JSON object
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Couldn't read the caption from the response — try again.");
  return JSON.parse(clean.slice(first, last + 1));
}

// Pull the web pages Claude actually consulted out of the API response.
// Search results arrive as web_search_tool_result blocks; an error result has
// an object (not a list) as its content, so guard for that.
function extractSearchedPages(data) {
  const pages = [];
  const seen = new Set();
  for (const block of data.content || []) {
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) continue; // error object — skip
    for (const r of block.content) {
      if (r.type === "web_search_result" && r.url && !seen.has(r.url)) {
        seen.add(r.url);
        pages.push({ url: r.url, title: r.title || r.url });
      }
    }
  }
  return pages;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------
function renderResult(result, searchedPages = [], runMode = "story") {
  currentTopic = result.topic || "other";
  hashtagsAdded = false;

  captionEl.value = result.caption || "";
  topicBadge.textContent = currentTopic;

  // Podcast extras: the explainer (for writing the title) + Gemini thumbnail prompt
  const isPodcast = runMode === "podcast";
  aboutCard.hidden = !isPodcast || !(result.about || result.why_it_matters);
  aboutText.textContent = result.about || "";
  whyText.textContent = result.why_it_matters || "";
  thumbnailCard.hidden = !isPodcast || !result.thumbnail_prompt;
  thumbnailPromptEl.value = result.thumbnail_prompt || "";

  // Hashtag chips: Claude's fresh picks pre-selected, learned + evergreen after
  chipsEl.innerHTML = "";
  const fresh = (result.suggested_hashtags || []).map(normalizeTag);
  const menu = suggestMenu(currentTopic, fresh);
  for (const tag of menu) {
    addChip(tag, fresh.includes(tag));
  }

  // Claims & sources panel (right-hand side), colour-coded by tier
  sourcingEl.innerHTML = "";
  for (const note of result.sourcing_notes || []) {
    const li = document.createElement("li");
    const tier = (note.tier || "solid").toLowerCase();
    li.className = `tier-${tier}`;
    li.innerHTML =
      `<span class="tier-name">${escapeHtml(tier)}</span>` +
      `<span class="claim">${escapeHtml(note.claim || "")}</span>` +
      `<span class="source">${linkifyHtml(note.source || "")}</span>`;
    sourcingEl.appendChild(li);
  }

  // Pages Claude consulted while fact-checking
  searchedEl.innerHTML = "";
  for (const page of searchedPages) {
    const li = document.createElement("li");
    let domain = "";
    try { domain = new URL(page.url).hostname.replace(/^www\./, ""); } catch {}
    li.innerHTML =
      `<a href="${escapeHtml(page.url)}" target="_blank" rel="noopener">${escapeHtml(page.title)}</a>` +
      `<span class="domain">${escapeHtml(domain)}</span>`;
    searchedEl.appendChild(li);
  }
  searchedBlock.hidden = searchedPages.length === 0;

  sourcesPanel.hidden = false;
  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addChip(tag, selected) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip";
  if (selected) btn.classList.add("selected");
  if (isLearned(tag, currentTopic)) btn.classList.add("learned");
  btn.textContent = tag;
  btn.addEventListener("click", () => btn.classList.toggle("selected"));
  chipsEl.appendChild(btn);
}

function normalizeTag(t) {
  t = String(t).trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return "";
  return t.startsWith("#") ? t : "#" + t;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Escape text, then turn any bare URLs in it into clickable links
function linkifyHtml(s) {
  return escapeHtml(s).replace(
    /https?:\/\/[^\s)]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
  );
}

// Custom hashtag input
addTagBtn.addEventListener("click", addCustomTag);
newTagInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCustomTag();
});

function addCustomTag() {
  const tag = normalizeTag(newTagInput.value);
  if (!tag || tag === "#") return;
  const existing = [...chipsEl.children].find((c) => c.textContent === tag);
  if (existing) {
    existing.classList.add("selected");
  } else {
    addChip(tag, true);
  }
  newTagInput.value = "";
}

// ---------------------------------------------------------------------------
// Add to caption + copy
// ---------------------------------------------------------------------------
function selectedTags() {
  return [...chipsEl.querySelectorAll(".chip.selected")].map((c) => c.textContent);
}

addToCaptionBtn.addEventListener("click", () => {
  const tags = selectedTags();
  if (!tags.length) return;
  reinforce(tags, currentTopic); // learn

  // replace any previously-added hashtag line rather than stacking them
  let body = captionEl.value;
  if (hashtagsAdded) {
    body = body.replace(/\n\n#[^\n]*$/, "");
  }
  captionEl.value = `${body}\n\n${tags.join(" ")}`;
  hashtagsAdded = true;

  const old = addToCaptionBtn.textContent;
  addToCaptionBtn.textContent = "added ✓";
  setTimeout(() => (addToCaptionBtn.textContent = old), 1500);
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(captionEl.value);
  const old = copyBtn.textContent;
  copyBtn.textContent = "copied ✓";
  setTimeout(() => (copyBtn.textContent = old), 1500);
});

copyThumbnailBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(thumbnailPromptEl.value);
  const old = copyThumbnailBtn.textContent;
  copyThumbnailBtn.textContent = "copied ✓";
  setTimeout(() => (copyThumbnailBtn.textContent = old), 1500);
});
