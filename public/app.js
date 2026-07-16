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
// Lessons: standing style notes learned from feedback, sent with every run
// ---------------------------------------------------------------------------
const LESSONS_KEY = "lfg_lessons";
const loadLessons = () => JSON.parse(localStorage.getItem(LESSONS_KEY) || "[]");
const saveLessons = (arr) => localStorage.setItem(LESSONS_KEY, JSON.stringify(arr));

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const briefEl = $("brief");
const imageInput = $("image");
const pickImageBtn = $("pick-image");
const thumbsEl = $("thumbs");
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
const feedbackEl = $("feedback");
const sendFeedbackBtn = $("send-feedback");
const lessonsEl = $("lessons");
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

let currentImages = []; // [{ base64, dataUrl }] — several = an Instagram carousel
let currentVideo = null; // File (story/reel video)
let currentVideoPoster = null; // dataUrl for the video's thumbnail
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

// ----- story tab: one box takes several images (carousel) OR one video -----
pickImageBtn.addEventListener("click", () => imageInput.click());

const MAX_CAROUSEL = 10;

function renderStoryThumbs() {
  thumbsEl.innerHTML = "";

  const addItem = (src, onRemove) => {
    const item = document.createElement("div");
    item.className = "thumb-item";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Uploaded preview";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "thumb-clear";
    del.title = "Remove";
    del.textContent = "×";
    del.addEventListener("click", onRemove);
    item.append(img, del);
    thumbsEl.appendChild(item);
  };

  if (currentVideo && currentVideoPoster) {
    addItem(currentVideoPoster, () => {
      currentVideo = null;
      currentVideoPoster = null;
      imageInput.value = "";
      renderStoryThumbs();
    });
  }
  currentImages.forEach((im, idx) => {
    addItem(im.dataUrl, () => {
      currentImages.splice(idx, 1);
      renderStoryThumbs();
    });
  });

  storyFileName.textContent = currentVideo
    ? `${currentVideo.name} (${prettySize(currentVideo.size)})`
    : currentImages.length
      ? `${currentImages.length} image${currentImages.length > 1 ? "s — carousel" : ""}`
      : "";

  if (!currentVideo && !currentImages.length) {
    dropCard.classList.remove("glow-sweep", "has-image");
  }
}

function handleStoryFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;

  // a video takes over the box; images stack up into a carousel
  const video = files.find((f) => f.type.startsWith("video/"));
  if (video) {
    currentVideo = video;
    currentImages = [];
    currentVideoPoster = null;
    renderStoryThumbs();
    videoPoster(video, (dataUrl) => {
      currentVideoPoster = dataUrl;
      renderStoryThumbs();
    });
    sweepGlow(dropCard, true);
    return;
  }

  for (const file of files.filter((f) => f.type.startsWith("image/"))) {
    if (currentImages.length >= MAX_CAROUSEL) break;
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
      currentImages.push({ base64: dataUrl.split(",")[1], dataUrl });
      currentVideo = null;
      currentVideoPoster = null;
      URL.revokeObjectURL(url);
      renderStoryThumbs();
      sweepGlow(dropCard, true);
    };
    img.src = url;
  }
}

imageInput.addEventListener("change", () => handleStoryFiles(imageInput.files));

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
  card.addEventListener("drop", (e) =>
    onFile(e.dataTransfer?.files?.[0], e.dataTransfer?.files)
  );
}
wireDrop(dropCard, (f, all) => handleStoryFiles(all || [f]));
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

// ----- video pipeline: audio out in the browser, Whisper on Cloudflare -----
// The browser pulls the audio track out of the file, slices it into 5-minute
// pieces, and sends each piece to the LFG transcription server (a Cloudflare
// Worker running Whisper). As each piece comes back, the live transcript box
// fills in and the progress bar reflects real progress.

const liveCard = $("live-card");
const liveText = $("live-text");
const liveStats = $("live-stats");

// Pull the audio track out as 16 kHz mono 16-bit samples (small + Whisper-ready)
async function extractAudioInt16(file) {
  let buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    ctx.close();
    throw new Error(
      "Couldn't read the audio from that file — try exporting it as MP4 (H.264 + AAC) and drop it in again."
    );
  } finally {
    buf = null; // let the browser reclaim the raw file bytes
  }
  ctx.close();

  // mix down to mono
  let mono = decoded.getChannelData(0);
  if (decoded.numberOfChannels > 1) {
    const ch1 = decoded.getChannelData(1);
    mono = Float32Array.from(mono, (v, i) => (v + ch1[i]) / 2);
  }

  // resample if the browser didn't honour the 16 kHz request
  if (decoded.sampleRate !== 16000) {
    const ratio = decoded.sampleRate / 16000;
    const out = new Float32Array(Math.floor(mono.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = mono[Math.floor(i * ratio)];
    mono = out;
  }

  // 32-bit float → 16-bit — halves the memory and the upload size
  const samples = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return samples;
}

// Wrap 16-bit samples in a standard WAV header
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return buf;
}

async function getTranscriberUrl() {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  const url = (cfg.transcriberUrl || "").replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "The transcription server isn't connected yet — add TRANSCRIBER_URL in Vercel's environment variables."
    );
  }
  return url;
}

const CHUNK_SECONDS = 300; // 5-minute pieces (~9.6 MB each as WAV)

async function transcribeOnCloudflare(file) {
  const base = await getTranscriberUrl();

  progress.set(0.03, "pulling the audio out…");
  const samples = await extractAudioInt16(file);
  const per = CHUNK_SECONDS * 16000;
  const n = Math.max(1, Math.ceil(samples.length / per));
  const totalMin = Math.max(1, Math.round(samples.length / 16000 / 60));

  liveCard.hidden = false;
  liveText.textContent = "";
  liveStats.textContent = "";

  let full = "";
  const t0 = performance.now();

  for (let i = 0; i < n; i++) {
    const piece = samples.subarray(i * per, Math.min((i + 1) * per, samples.length));
    const wav = encodeWav(piece, 16000);

    // two attempts per piece so one blip doesn't sink a long episode
    let text = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && text === null; attempt++) {
      try {
        const r = await fetch(`${base}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: wav,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Transcription server error (${r.status}).`);
        text = d.text || "";
      } catch (e) {
        lastError = e;
        await new Promise((s) => setTimeout(s, 2000));
      }
    }
    if (text === null) {
      throw new Error(
        `Transcription stopped ${Math.round((i / n) * 100)}% of the way through — try again. (${lastError.message})`
      );
    }

    full += (full && text ? " " : "") + text;
    liveText.textContent += (i ? " " : "") + text;
    liveText.scrollTop = liveText.scrollHeight;

    // real progress + measured time left
    const frac = (i + 1) / n;
    const elapsed = performance.now() - t0;
    const remainMin = Math.ceil((elapsed / frac - elapsed) / 60000);
    const doneMin = Math.min(totalMin, Math.round(((i + 1) * CHUNK_SECONDS) / 60));
    liveStats.textContent = `— ${doneMin} of ${totalMin} min heard`;
    progress.set(
      0.08 + frac * 0.62,
      frac < 1
        ? `listening… ${Math.round(frac * 100)}% · ~${remainMin} min left`
        : "listening… done"
    );
  }

  return full.trim();
}

// Grab n evenly-spaced screenshots from the video (as base64 JPEGs)
function grabFrames(file, n = 8) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("video/")) return resolve([]);
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.src = URL.createObjectURL(file);
    v.onerror = () => resolve([]);
    v.onloadedmetadata = async () => {
      try {
        const d = v.duration;
        const count = d < 60 ? Math.min(n, 5) : n;
        const frames = [];
        for (let i = 0; i < count; i++) {
          const t = d * (0.05 + (0.9 * i) / Math.max(1, count - 1));
          await new Promise((res) => {
            v.onseeked = res;
            v.currentTime = t;
          });
          const c = document.createElement("canvas");
          const scale = Math.min(1, 1024 / (v.videoWidth || 1024));
          c.width = Math.max(1, Math.round(v.videoWidth * scale));
          c.height = Math.max(1, Math.round(v.videoHeight * scale));
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          frames.push(c.toDataURL("image/jpeg", 0.75).split(",")[1]);
        }
        URL.revokeObjectURL(v.src);
        resolve(frames);
      } catch {
        resolve([]);
      }
    };
  });
}

// Full pipeline: returns { transcript, frames }
async function processVideo(file) {
  const MAX_BYTES = 700 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    throw new Error(
      "That file is over 700 MB — export a smaller version (720p is plenty) and drop it in again."
    );
  }

  const transcript = await transcribeOnCloudflare(file);
  if (!transcript) {
    throw new Error("The transcription came back empty — is there speech in the video?");
  }

  progress.set(0.72, "grabbing screenshots…");
  const frames = await grabFrames(file);
  return { transcript, frames };
}

generateBtn.addEventListener("click", async () => {
  const runMode = mode;
  const videoFile = runMode === "story" ? currentVideo : podcastVideo;

  // validation
  if (runMode === "story") {
    if (!briefEl.value.trim() && !currentImages.length && !videoFile) {
      showError("Give me a brief, images, or a video.");
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
  startLightShow(); // a different show each time

  try {
    // 1–3. video stages (only when a file was dropped)
    let videoData = null;
    if (videoFile) {
      videoData = await processVideo(videoFile);
    }

    // 4. caption stage
    let endpoint, payload;
    if (runMode === "story") {
      endpoint = "/api/generate";
      payload = {
        brief: briefEl.value.trim(),
        images: currentImages.map((im) => im.base64),
        videoTranscript: videoData?.transcript,
        frames: videoData?.frames,
      };
    } else {
      endpoint = "/api/podcast";
      payload = videoData
        ? {
            transcript: videoData.transcript,
            frames: videoData.frames,
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
    payload.styleNotes = loadLessons(); // lessons learned from past feedback

    const base = videoFile ? 0.75 : 0;
    const eta = getEta(runMode);
    progress.creep(base, 0.96, eta, (s) =>
      videoFile ? "writing the caption…" : `~${s}s remaining`
    );

    const capStart = performance.now();
    const data = await callCaption(endpoint, payload);

    progress.stop();
    progress.set(1, "Done");
    recordEta(runMode, performance.now() - capStart);

    lastRun = { endpoint, payload, runMode }; // kept so feedback can rewrite
    const result = parseModelJson(data);
    renderResult(result, extractSearchedPages(data), runMode);
  } catch (e) {
    progress.stop();
    etaEl.textContent = "Error — try again";
    showError(String(e.message || e));
  } finally {
    stopLightShow();
    generateBtn.disabled = false;
    setTimeout(() => (progressEl.hidden = true), 1500);
  }
});

// ----- light show variants: a different mood each generation -----
const FX_VARIANTS = ["fx-classic", "fx-pulse", "fx-bars"];
let lastFx = null;

function startLightShow() {
  // never the same show twice in a row
  const options = FX_VARIANTS.filter((v) => v !== lastFx);
  const pick = options[Math.floor(Math.random() * options.length)];
  lastFx = pick;
  document.body.classList.add("generating", pick);
}

function stopLightShow() {
  document.body.classList.remove("generating", ...FX_VARIANTS);
}

let lastRun = null; // { endpoint, payload, runMode } of the latest generation

// Call a caption route and return parsed JSON, translating non-JSON failures
// (e.g. a server timeout page) into plain English
async function callCaption(endpoint, payload) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await resp.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      resp.status === 504
        ? "The caption took too long to write — hit generate again."
        : `The server replied oddly (${resp.status}) — hit generate again.`
    );
  }
  if (!resp.ok) {
    throw new Error(data.error?.message || data.error || `Server error (${resp.status})`);
  }
  return data;
}

// ----- feedback: rewrite this caption now + remember the lesson forever -----
function renderLessons() {
  lessonsEl.innerHTML = "";
  loadLessons().forEach((lesson, idx) => {
    const chip = document.createElement("span");
    chip.className = "lesson";
    const txt = document.createElement("span");
    txt.textContent = lesson;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.title = "Unlearn this";
    del.addEventListener("click", () => {
      const arr = loadLessons();
      arr.splice(idx, 1);
      saveLessons(arr);
      renderLessons();
    });
    chip.append(txt, del);
    lessonsEl.appendChild(chip);
  });
}
renderLessons();

async function sendFeedback() {
  const note = feedbackEl.value.trim();
  if (!note) return;
  if (!lastRun) {
    showError("Generate a caption first, then teach it.");
    return;
  }

  const lessons = loadLessons();
  lessons.push(note);
  saveLessons(lessons);
  renderLessons();
  feedbackEl.value = "";

  errorEl.hidden = true;
  sendFeedbackBtn.disabled = true;
  generateBtn.disabled = true;
  progressEl.hidden = false;
  startLightShow();
  progress.creep(0, 0.95, getEta(lastRun.runMode), () => "rewriting with your note…");

  try {
    const payload = {
      ...lastRun.payload,
      styleNotes: loadLessons(),
      revise: { previousCaption: captionEl.value, feedback: note },
    };
    const data = await callCaption(lastRun.endpoint, payload);
    progress.stop();
    progress.set(1, "Done");
    const result = parseModelJson(data);
    renderResult(result, extractSearchedPages(data), lastRun.runMode);
  } catch (e) {
    progress.stop();
    etaEl.textContent = "Error — try again";
    showError(String(e.message || e));
  } finally {
    stopLightShow();
    sendFeedbackBtn.disabled = false;
    generateBtn.disabled = false;
    setTimeout(() => (progressEl.hidden = true), 1500);
  }
}
sendFeedbackBtn.addEventListener("click", sendFeedback);
feedbackEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendFeedback();
});

// ----- thumbnail maker (same mechanics as the LFG card creator) -----
const thumbMaker = $("thumb-maker");
const frameStrip = $("frame-strip");
const overlayTextEl = $("overlay-text");
const overlayHighlightEl = $("overlay-highlight");
const overlaySwatchesEl = $("overlay-swatches");
const thumbCanvas = $("thumb-canvas");
const thumbCtx = thumbCanvas.getContext("2d");
const downloadThumbBtn = $("download-thumb");
const thumbImageInput = $("thumb-image");
const pickThumbImageBtn = $("pick-thumb-image");

const TW = 1080; // 9:16 reel cover, like the card creator
const TH = 1920;
const THUMB_SWATCHES = [
  { hex: "#FF0000", name: "Red" },
  { hex: "#FE5500", name: "Orange" },
  { hex: "#EE9944", name: "Yellow" },
  { hex: "#79CAC4", name: "Blue" },
  { hex: "#FFFFFF", name: "White" },
];
let thumbColour = "#FF0000"; // red ideally
let thumbImage = null;
let thumbPanX = 0;

// colour swatches (red pre-selected)
THUMB_SWATCHES.forEach((c) => {
  const sw = document.createElement("div");
  sw.className = "swatch" + (c.hex === thumbColour ? " selected" : "");
  sw.style.background = c.hex;
  sw.title = c.name;
  sw.addEventListener("click", () => {
    overlaySwatchesEl.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
    sw.classList.add("selected");
    thumbColour = c.hex;
    renderThumb();
  });
  overlaySwatchesEl.appendChild(sw);
});

function setThumbImage(src) {
  const img = new Image();
  img.onload = () => {
    thumbImage = img;
    thumbPanX = 0;
    renderThumb();
  };
  img.src = src;
}

function renderThumb() {
  const ctx = thumbCtx;
  ctx.clearRect(0, 0, TW, TH);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, TW, TH);

  // background image, drawn to cover, horizontally pannable
  if (thumbImage) {
    const img = thumbImage;
    const imgRatio = img.width / img.height;
    const canvasRatio = TW / TH;
    let sx, sy, sw, sh;
    if (imgRatio > canvasRatio) {
      sh = img.height;
      sw = img.height * canvasRatio;
      const maxPan = (img.width - sw) / 2;
      thumbPanX = Math.max(-maxPan, Math.min(maxPan, thumbPanX));
      sx = (img.width - sw) / 2 + thumbPanX;
      sy = 0;
    } else {
      sw = img.width;
      sh = img.width / canvasRatio;
      sx = 0;
      sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, TW, TH);
  }

  const phrase = overlayTextEl.value.trim().toUpperCase();
  if (!phrase) return;

  const padding = 120;
  const maxWidth = TW - padding * 2;
  const fontSize = 92;
  const lineHeight = fontSize * 1.15;
  ctx.font = `700 ${fontSize}px Octarine, Arial, sans-serif`;
  ctx.textBaseline = "top";

  // word wrap
  const words = phrase.split(/\s+/);
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    const testLine = currentLine ? currentLine + " " + word : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  // black gradient fade behind the text
  const gradientTop = Math.round(TH * 0.35);
  const grad = ctx.createLinearGradient(0, gradientTop, 0, TH);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.25, "rgba(0,0,0,0.5)");
  grad.addColorStop(0.45, "rgba(0,0,0,0.8)");
  grad.addColorStop(0.65, "rgba(0,0,0,0.92)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradientTop, TW, TH - gradientTop);

  // which words get the colour (comma-separated phrases, word-run matching)
  const colourMap = new Map();
  const targetPhrases = overlayHighlightEl.value
    .trim()
    .toUpperCase()
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const tp of targetPhrases) {
    const tpWords = tp.split(/\s+/);
    for (let i = 0; i <= words.length - tpWords.length; i++) {
      let match = true;
      for (let k = 0; k < tpWords.length; k++) {
        if (
          words[i + k].replace(/[^A-Z0-9]/g, "") !==
          tpWords[k].replace(/[^A-Z0-9]/g, "")
        ) {
          match = false;
          break;
        }
      }
      if (match) {
        for (let k = 0; k < tpWords.length; k++) colourMap.set(i + k, thumbColour);
      }
    }
  }

  // draw the lines, lower third — visible in the profile-grid centre crop
  const textStartY = Math.round(TH * 0.63);
  let wordIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const y = textStartY + i * lineHeight;
    let x = padding;
    for (const w of lines[i].split(/\s+/)) {
      ctx.fillStyle = colourMap.has(wordIndex) ? colourMap.get(wordIndex) : "#ffffff";
      ctx.fillText(w, x, y);
      x += ctx.measureText(w + " ").width;
      wordIndex++;
    }
  }
}

// drag horizontally to reframe (scaled from on-screen pixels to canvas pixels)
let thumbDragging = false;
let thumbDragStartX = 0;
let thumbPanStart = 0;
thumbCanvas.addEventListener("pointerdown", (e) => {
  thumbDragging = true;
  thumbDragStartX = e.clientX;
  thumbPanStart = thumbPanX;
  thumbCanvas.setPointerCapture(e.pointerId);
});
thumbCanvas.addEventListener("pointermove", (e) => {
  if (!thumbDragging || !thumbImage) return;
  const scale = TW / thumbCanvas.getBoundingClientRect().width;
  thumbPanX = thumbPanStart - (e.clientX - thumbDragStartX) * scale;
  renderThumb();
});
["pointerup", "pointercancel"].forEach((evt) =>
  thumbCanvas.addEventListener(evt, () => (thumbDragging = false))
);

overlayTextEl.addEventListener("input", renderThumb);
overlayHighlightEl.addEventListener("input", renderThumb);

pickThumbImageBtn.addEventListener("click", () => thumbImageInput.click());
thumbImageInput.addEventListener("change", () => {
  const file = thumbImageInput.files[0];
  if (!file || !file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  setThumbImage(url);
  frameStrip.querySelectorAll("img").forEach((f) => f.classList.remove("selected"));
});

downloadThumbBtn.addEventListener("click", () => {
  renderThumb();
  const link = document.createElement("a");
  link.download = "thumbnail.png";
  link.href = thumbCanvas.toDataURL("image/png");
  link.click();
});

// Called after each generation: frames from the video (or uploaded images)
// become background candidates; Claude's suggested line + red words prefill.
function addStripOption(src, { title = "", web = false, select = false } = {}) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = title || "Background option";
  img.title = title;
  if (web) img.classList.add("web");
  if (select) img.classList.add("selected");
  img.addEventListener("click", () => {
    frameStrip.querySelectorAll("img").forEach((f) => f.classList.remove("selected"));
    img.classList.add("selected");
    setThumbImage(src);
  });
  img.addEventListener("error", () => img.remove()); // drop broken web images
  frameStrip.appendChild(img);
  return img;
}

// Pull in related photos from Wikimedia Commons for the search terms Claude
// suggested; they join the strip with a blue edge.
async function addWebImages(terms) {
  const seen = new Set();
  for (const term of terms.slice(0, 2)) {
    try {
      const r = await fetch(`/api/image-search?q=${encodeURIComponent(term)}`);
      const d = await r.json();
      if (!r.ok) continue;
      for (const im of (d.images || []).slice(0, 4)) {
        if (seen.has(im.url)) continue;
        seen.add(im.url);
        const proxied = `/api/image-proxy?url=${encodeURIComponent(im.url)}`;
        addStripOption(proxied, { title: im.title, web: true });
        // nothing local to show? auto-select the first web photo
        if (!thumbImage && seen.size === 1) {
          frameStrip.querySelector("img")?.classList.add("selected");
          setThumbImage(proxied);
        }
      }
    } catch {
      /* a failed search just means fewer options */
    }
  }
}

function setupThumbnail(result) {
  const frames = lastRun?.payload?.frames || [];
  const candidates = [
    ...frames.map((b64) => "data:image/jpeg;base64," + b64),
    ...currentImages.map((im) => im.dataUrl),
  ];
  const searchTerms = Array.isArray(result.image_search_terms)
    ? result.image_search_terms.filter((t) => typeof t === "string" && t)
    : [];

  if (!candidates.length && !searchTerms.length) {
    thumbMaker.hidden = true;
    return;
  }

  frameStrip.innerHTML = "";
  thumbImage = null;
  candidates.forEach((src, i) => addStripOption(src, { select: i === 0 }));

  const overlay = result.thumbnail_overlay || {};
  if (overlay.text) overlayTextEl.value = overlay.text;
  if (overlay.highlight) overlayHighlightEl.value = overlay.highlight;

  thumbMaker.hidden = false;
  // make sure the brand font is in before first paint
  document.fonts.load("700 92px Octarine").finally(() => {
    if (candidates.length) setThumbImage(candidates[0]);
  });

  if (searchTerms.length) addWebImages(searchTerms);
}

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
  if (first === -1 || last === -1) {
    throw new Error(
      `Couldn't read the caption from the response${data.stop_reason ? ` (stopped: ${data.stop_reason})` : ""} — try again.`
    );
  }
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

  // Instagram-ready spacing: if the caption arrived as one blob, break it
  // into short paragraphs (every couple of sentences) with blank lines
  let caption = (result.caption || "").trim();
  if (caption && !caption.includes("\n")) {
    const sentences = caption.split(/(?<=[.!?])\s+/);
    const paras = [];
    for (let i = 0; i < sentences.length; i += 2) {
      paras.push(sentences.slice(i, i + 2).join(" "));
    }
    caption = paras.join("\n\n");
  }
  captionEl.value = caption;
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

  setupThumbnail(result);

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
