/* LFG Caption Generator — frontend logic
   - generate flow with a self-calibrating progress bar + ETA
   - self-learning hashtag menu (localStorage)
   - add-to-caption + copy */

// ---------------------------------------------------------------------------
// ETA calibration — rolling average of the last 8 real generation times
// ---------------------------------------------------------------------------
const ETA_KEY = "lfg_eta_samples";

function getEta() {
  const s = JSON.parse(localStorage.getItem(ETA_KEY) || "[]");
  if (!s.length) return 28000; // 28s cold-start estimate
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function recordEta(ms) {
  const s = JSON.parse(localStorage.getItem(ETA_KEY) || "[]");
  s.push(ms);
  while (s.length > 8) s.shift();
  localStorage.setItem(ETA_KEY, JSON.stringify(s));
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

let currentImage = null; // { base64, mediaType }
let currentTopic = "other";
let hashtagsAdded = false;

// ---------------------------------------------------------------------------
// Image upload — downscale to max 1568px long edge so uploads stay small
// and image tokens stay cheap
// ---------------------------------------------------------------------------
pickImageBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) return;
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
  };
  img.src = url;
});

clearImageBtn.addEventListener("click", () => {
  currentImage = null;
  imageInput.value = "";
  thumbBox.hidden = true;
});

// ---------------------------------------------------------------------------
// Generate flow with time-estimate-driven progress bar
// ---------------------------------------------------------------------------
generateBtn.addEventListener("click", async () => {
  const brief = briefEl.value.trim();
  if (!brief && !currentImage) {
    showError("Give me a brief, an image, or both.");
    return;
  }

  errorEl.hidden = true;
  generateBtn.disabled = true;
  progressEl.hidden = false;

  const eta = getEta();
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
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief,
        imageBase64: currentImage?.base64,
        imageMediaType: currentImage?.mediaType,
      }),
    });
    const data = await resp.json();

    done = true;
    cancelAnimationFrame(raf);
    barEl.style.width = "100%";
    etaEl.textContent = "Done";

    if (!resp.ok) {
      throw new Error(data.error?.message || data.error || `Server error (${resp.status})`);
    }
    recordEta(performance.now() - start);

    const result = parseModelJson(data);
    renderResult(result, extractSearchedPages(data));
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
function renderResult(result, searchedPages = []) {
  currentTopic = result.topic || "other";
  hashtagsAdded = false;

  captionEl.value = result.caption || "";
  topicBadge.textContent = currentTopic;

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
