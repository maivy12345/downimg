const pageUrlInput = document.getElementById("pageUrl");
const hint1688 = document.getElementById("hint1688");
const scrapeBtn = document.getElementById("scrapeBtn");
const clearUrlBtn = document.getElementById("clearUrlBtn");
const autoDownloadToggle = document.getElementById("autoDownload");
const dropZone = document.getElementById("dropZone");
const progressWrap = document.getElementById("progressWrap");
const progressLabel = document.getElementById("progressLabel");
const progressPct = document.getElementById("progressPct");
const progressFill = document.getElementById("progressFill");
const statusEl = document.getElementById("status");
const statusIcon = document.getElementById("statusIcon");
const statusText = document.getElementById("statusText");
const statusFolder = document.getElementById("statusFolder");
const copyFolderBtn = document.getElementById("copyFolderBtn");
const welcomeEl = document.getElementById("welcome");
const resultsEl = document.getElementById("results");
const pageTitleEl = document.getElementById("pageTitle");
const pageLinkEl = document.getElementById("pageLink");
const imageCountEl = document.getElementById("imageCount");
const videoCountEl = document.getElementById("videoCount");
const totalCountEl = document.getElementById("totalCount");
const selectedCountEl = document.getElementById("selectedCount");
const selectAllBtn = document.getElementById("selectAllBtn");
const downloadBtn = document.getElementById("downloadBtn");
const mediaGrid = document.getElementById("mediaGrid");
const emptyFilter = document.getElementById("emptyFilter");
const stepEls = document.querySelectorAll(".step");
const filterTabs = document.querySelectorAll(".filter-tab");

let currentMedia = [];
let currentFilter = "all";
let lastFolder = "";
let isBusy = false;

const URL_PATTERN = /^https?:\/\/.+/i;
const IS_1688 = /1688\.com/i;
const API_TIMEOUT_MS = 240000;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

async function apiPost(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      throw new Error("Server trả về dữ liệu không hợp lệ.");
    }
    if (!response.ok) throw new Error(data.error || "Yêu cầu thất bại.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Xử lý quá lâu (>3 phút). Thử lại hoặc dùng link trang khác.");
    }
    if (error.message === "Failed to fetch" || error instanceof TypeError) {
      throw new Error(
        "Không kết nối được server. Chạy lệnh npm start rồi mở http://localhost:3456 (không mở file HTML trực tiếp)."
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setStep(step) {
  stepEls.forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle("active", n === step);
    el.classList.toggle("done", n < step);
  });
}

function setProgress(show, label = "", pct = 0) {
  progressWrap.classList.toggle("hidden", !show);
  progressLabel.textContent = label;
  progressPct.textContent = `${Math.round(pct)}%`;
  progressFill.style.width = `${pct}%`;
}

function animateProgress(from, to, label, duration = 800) {
  return new Promise((resolve) => {
    setProgress(true, label, from);
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (to - from) * eased;
      setProgress(true, label, current);
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
}

function setStatus(message, type = "info", folder = "") {
  statusEl.classList.remove("hidden", "info", "success", "error");
  statusEl.classList.add(type);

  const icons = { info: "⏳", success: "✅", error: "❌" };
  statusIcon.textContent = icons[type] || "ℹ️";
  statusText.textContent = message;

  if (folder) {
    statusFolder.textContent = folder;
    statusFolder.classList.remove("hidden");
    copyFolderBtn.classList.remove("hidden");
    lastFolder = folder;
  } else {
    statusFolder.classList.add("hidden");
    copyFolderBtn.classList.add("hidden");
    lastFolder = "";
  }
}

function clearStatus() {
  statusEl.classList.add("hidden");
  statusText.textContent = "";
  statusFolder.classList.add("hidden");
  copyFolderBtn.classList.add("hidden");
}

function setBusy(busy) {
  isBusy = busy;
  scrapeBtn.disabled = busy;
  downloadBtn.disabled = busy;
  pageUrlInput.disabled = busy;
}

function updateClearBtn() {
  clearUrlBtn.classList.toggle("hidden", !pageUrlInput.value.trim());
  hint1688.classList.toggle("hidden", !IS_1688.test(pageUrlInput.value));
}

function updateSelectedCount() {
  const count = getSelectedMedia().length;
  selectedCountEl.textContent = String(count);
}

function proxyUrl(mediaUrl, filename) {
  const params = new URLSearchParams({ url: mediaUrl });
  if (filename) params.set("filename", filename);
  return `/api/proxy?${params.toString()}`;
}

function createMediaCard(item, index) {
  const card = document.createElement("article");
  card.className = `media-card selected`;
  card.dataset.index = String(index);
  card.dataset.type = item.type;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.dataset.index = String(index);

  const preview = document.createElement("div");
  preview.className = "media-preview";

  const badge = document.createElement("span");
  badge.className = `media-badge ${item.type}`;
  badge.textContent = item.type === "video" ? "Video" : "Ảnh";

  const check = document.createElement("span");
  check.className = "media-check";
  check.innerHTML = CHECK_SVG;

  if (item.type === "video") {
    const video = document.createElement("video");
    video.src = item.url;
    video.muted = true;
    video.preload = "metadata";
    preview.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.title || "Ảnh";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      img.remove();
      const fallback = document.createElement("span");
      fallback.className = "preview-fallback";
      fallback.textContent = "Không xem trước";
      preview.appendChild(fallback);
    };
    preview.appendChild(img);
  }

  preview.append(badge, check);

  const body = document.createElement("div");
  body.className = "media-body";
  const title = document.createElement("div");
  title.className = "media-title";
  title.textContent = item.title || shortenUrl(item.url);
  body.appendChild(title);

  card.append(checkbox, preview, body);

  function toggleSelect() {
    checkbox.checked = !checkbox.checked;
    card.classList.toggle("selected", checkbox.checked);
    updateSelectedCount();
  }

  card.addEventListener("click", (e) => {
    if (e.target.tagName === "VIDEO") return;
    toggleSelect();
  });

  return card;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.slice(0, 30) + "…" : u.pathname;
    return u.hostname + path;
  } catch {
    return url.slice(0, 40) + (url.length > 40 ? "…" : "");
  }
}

function applyFilter(filter) {
  currentFilter = filter;
  filterTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.filter === filter);
  });

  const cards = mediaGrid.querySelectorAll(".media-card");
  let visible = 0;
  cards.forEach((card) => {
    const match = filter === "all" || card.dataset.type === filter;
    card.classList.toggle("hidden-filter", !match);
    if (match) visible++;
  });

  emptyFilter.classList.toggle("hidden", visible > 0 || cards.length === 0);
}

function renderResults(data) {
  const images = data.images || [];
  const videos = data.videos || [];
  currentMedia = [...images, ...videos];

  pageTitleEl.textContent = data.pageTitle || "Kết quả";
  pageLinkEl.href = data.pageUrl || "#";
  pageLinkEl.textContent = data.pageUrl || "";

  imageCountEl.textContent = String(images.length);
  videoCountEl.textContent = String(videos.length);
  totalCountEl.textContent = String(currentMedia.length);

  mediaGrid.innerHTML = "";
  currentMedia.forEach((item, i) => {
    mediaGrid.appendChild(createMediaCard(item, i));
  });

  welcomeEl.classList.add("hidden");
  resultsEl.classList.remove("hidden");
  applyFilter(currentFilter);
  updateSelectedCount();
  setStep(2);
}

function getSelectedMedia() {
  return Array.from(mediaGrid.querySelectorAll(".media-card.selected"))
    .map((card) => currentMedia[Number(card.dataset.index)])
    .filter(Boolean);
}

async function scrapePage(url) {
  return apiPost("/api/scrape", { url });
}

async function grabPage(url) {
  return apiPost("/api/grab", { url });
}

async function downloadToDisk(url, items) {
  return apiPost("/api/download-all", items ? { url, items } : { url });
}

async function handleScrape(autoDownload = false) {
  const url = pageUrlInput.value.trim();
  if (!URL_PATTERN.test(url)) {
    setStatus("Vui lòng dán link http/https hợp lệ.", "error");
    dropZone.classList.add("focused");
    setTimeout(() => dropZone.classList.remove("focused"), 1500);
    return;
  }

  setBusy(true);
  clearStatus();
  setStep(1);

  try {
    const is1688 = IS_1688.test(url);
    const statusMsg = is1688
      ? "Đang lấy dữ liệu 1688 từ Chrome của bạn..."
      : "Đang quét trang...";
    setStatus(statusMsg, "info");
    await animateProgress(0, 30, statusMsg, 600);

    const shouldAutoDownload = autoDownload;

    if (shouldAutoDownload) {
      const data = await grabPage(url);
      renderResults(data);
      await animateProgress(30, 90, `Đã tải ${data.downloaded}/${data.total} file`, 500);
      setStep(3);
      const msg =
        data.failed > 0
          ? `Tải xong ${data.downloaded}/${data.total} file (${data.failed} lỗi)`
          : `Tải xong ${data.downloaded} file!`;
      setStatus(msg, data.downloaded ? "success" : "error", data.folder);
      await animateProgress(90, 100, "Hoàn tất!", 300);
      return;
    }

    const data = await scrapePage(url);
    renderResults(data);

    if (!currentMedia.length) {
      setProgress(false);
      setStatus("Không tìm thấy ảnh hoặc video trên trang này.", "error");
      return;
    }

    await animateProgress(30, 70, `Tìm thấy ${currentMedia.length} file`, 400);
    setProgress(false);
    setStatus(`Tìm thấy ${currentMedia.length} file — chọn rồi bấm Tải đã chọn.`, "success");
  } catch (error) {
    setProgress(false);
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
    setTimeout(() => setProgress(false), 1200);
  }
}

async function handleDownloadSelected() {
  const selected = getSelectedMedia();
  const url = pageUrlInput.value.trim();

  if (!selected.length) {
    setStatus("Chưa chọn file nào. Bấm vào thẻ ảnh/video để chọn.", "error");
    return;
  }

  setBusy(true);
  try {
    setStatus(`Đang tải ${selected.length} file...`, "info");
    await animateProgress(0, 80, `Đang tải ${selected.length} file...`, 600);

    const result = await downloadToDisk(url, selected);
    await animateProgress(80, 100, "Hoàn tất!", 300);
    setStep(3);

    setStatus(
      `Tải xong ${result.downloaded}/${result.total} file` +
        (result.failed ? ` (${result.failed} lỗi)` : ""),
      result.downloaded ? "success" : "error",
      result.folder
    );
  } catch (error) {
    setProgress(false);
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
    setTimeout(() => setProgress(false), 1200);
  }
}

function scheduleAutoScrape() {
  const url = pageUrlInput.value.trim();
  updateClearBtn();
  if (!URL_PATTERN.test(url) || isBusy) return;
  handleScrape(true);
}

let pasteTimer = null;

scrapeBtn.addEventListener("click", () => handleScrape(false));

downloadBtn.addEventListener("click", handleDownloadSelected);

clearUrlBtn.addEventListener("click", () => {
  pageUrlInput.value = "";
  updateClearBtn();
  pageUrlInput.focus();
});

copyFolderBtn.addEventListener("click", async () => {
  if (!lastFolder) return;
  try {
    await navigator.clipboard.writeText(lastFolder);
    copyFolderBtn.textContent = "Đã sao chép!";
    setTimeout(() => {
      copyFolderBtn.textContent = "Sao chép đường dẫn";
    }, 2000);
  } catch {
    setStatus("Không sao chép được — hãy copy thủ công.", "error", lastFolder);
  }
});

selectAllBtn.addEventListener("click", () => {
  const visibleCards = Array.from(mediaGrid.querySelectorAll(".media-card")).filter(
    (c) => !c.classList.contains("hidden-filter")
  );
  const allSelected = visibleCards.every((c) => c.classList.contains("selected"));

  visibleCards.forEach((card) => {
    const checked = !allSelected;
    card.classList.toggle("selected", checked);
    const box = card.querySelector('input[type="checkbox"]');
    if (box) box.checked = checked;
  });

  selectAllBtn.textContent = allSelected ? "Chọn tất cả" : "Bỏ chọn";
  updateSelectedCount();
});

filterTabs.forEach((tab) => {
  tab.addEventListener("click", () => applyFilter(tab.dataset.filter));
});

pageUrlInput.addEventListener("paste", () => {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(scheduleAutoScrape, 100);
});
pageUrlInput.addEventListener("input", () => {
  updateClearBtn();
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(scheduleAutoScrape, 400);
});

pageUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    handleScrape(autoDownloadToggle.checked);
  }
});

pageUrlInput.addEventListener("focus", () => dropZone.classList.add("focused"));
pageUrlInput.addEventListener("blur", () => dropZone.classList.remove("focused"));

setStep(1);
updateClearBtn();

fetch("/api/health")
  .then((r) => {
    if (!r.ok) throw new Error();
  })
  .catch(() => {
    setStatus(
      "Server chưa chạy. Mở terminal, chạy npm start, rồi vào http://localhost:3456",
      "error"
    );
  });
