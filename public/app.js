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

let currentImage = null; // { base64, mediaType }
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

pickImageBtn.addEventListener("click", () => imageInput.click());

function handleImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
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
    currentImage = {
      base64: dataUrl.split(",")[1],
      mediaType: "image/jpeg",
    };
    thumbEl.src = dataUrl;
    thumbBox.hidden = false;
    URL.revokeObjectURL(url);

    // orange glow: sweeps from the top of the box downwards, then settles
    dropCard.classList.remove("glow-sweep", "has-image");
    void dropCard.offsetWidth; // restart the animation if it already ran
    dropCard.classList.add("glow-sweep");
  };
  img.src = url;
}

dropCard.addEventListener("animationend", () => {
  dropCard.classList.remove("glow-sweep");
  if (currentImage) dropCard.classList.add("has-image");
});

imageInput.addEventListener("change", () => handleImageFile(imageInput.files[0]));

// drag & drop onto the box
["dragenter", "dragover"].forEach((evt) =>
  dropCard.addEventListener(evt, (e) => {
    e.preventDefault();
    dropCard.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropCard.addEventListener(evt, (e) => {
    e.preventDefault();
    dropCard.classList.remove("drag-over");
  })
);
dropCard.addEventListener("drop", (e) => {
  handleImageFile(e.dataTransfer?.files?.[0]);
});

clearImageBtn.addEventListener("click", () => {
  currentImage = null;
  imageInput.value = "";
  thumbBox.hidden = true;
  dropCard.classList.remove("glow-sweep", "has-image");
});

// ---------------------------------------------------------------------------
// Generate flow with time-estimate-driven progress bar
// ---------------------------------------------------------------------------
generateBtn.addEventListener("click", async () => {
  let endpoint, payload;

  if (mode === "story") {
    const brief = briefEl.value.trim();
    if (!brief && !currentImage) {
      showError("Give me a brief, an image, or both.");
      return;
    }
    endpoint = "/api/generate";
    payload = {
      brief,
      imageBase64: currentImage?.base64,
      imageMediaType: currentImage?.mediaType,
    };
  } else {
    const youtubeUrl = podcastUrlEl.value.trim();
    const transcript = podcastTranscriptEl.value.trim();
    if (!youtubeUrl && !transcript) {
      showError("Give me the YouTube link (or paste the transcript).");
      return;
    }
    endpoint = "/api/podcast";
    payload = {
      youtubeUrl,
      transcript,
      guests: podcastGuestsEl.value.trim(),
      title: podcastTitleEl.value.trim(),
    };
  }

  errorEl.hidden = true;
  generateBtn.disabled = true;
  progressEl.hidden = false;

  const runMode = mode;
  const eta = getEta(runMode);
  const start = performance.now();
  let raf;
  let done = false;

  function tick() {
    const elapsed = performance.now() - start;
    const frac = done ? 1 : Math.min(0.92, elapsed / eta);
    barEl.style.width = (frac * 100).toFixed(1) + "%";
    const remain = Math.max(0, Math.ceil((eta - elapsed) / 1000));
    etaEl.textContent = done ? "Done" : `~${remain}s remaining`;
    if (!done) raf = requestAnimationFrame(tick);
  }
  tick();

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    done = true;
    cancelAnimationFrame(raf);
    barEl.style.width = "100%";
    etaEl.textContent = "Done";

    if (!resp.ok) {
      throw new Error(data.error?.message || data.error || `Server error (${resp.status})`);
    }
    recordEta(runMode, performance.now() - start);

    const result = parseModelJson(data);
    renderResult(result, extractSearchedPages(data), runMode);
  } catch (e) {
    done = true;
    cancelAnimationFrame(raf);
    etaEl.textContent = "Error — try again";
    showError(String(e.message || e));
  } finally {
    generateBtn.disabled = false;
    setTimeout(() => (progressEl.hidden = true), 1200);
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
