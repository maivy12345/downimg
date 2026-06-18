const pageUrlInput = document.getElementById("pageUrl");
const hint1688 = document.getElementById("hint1688");
const session1688Badge = document.getElementById("session1688Badge");
const login1688Btn = document.getElementById("login1688Btn");
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
const saveFolderNameInput = document.getElementById("saveFolderName");
const savePathHint = document.getElementById("savePathHint");
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
const LOGIN_TIMEOUT_MS = 360000;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

async function apiPost(path, body, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!response.ok) throw new Error(data.error || data.message || "Yêu cầu thất bại.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Xử lý quá lâu. Thử lại hoặc dùng link trang khác.");
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

async function apiGet(path) {
  const response = await fetch(path);
  let data = {};
  try {
    data = await response.json();
  } catch {
    return {};
  }
  return data;
}

function formatSavedAt(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

function updateSessionBadge(loggedIn, savedAt) {
  if (loggedIn) {
    session1688Badge.textContent = savedAt
      ? `Đã lưu · ${formatSavedAt(savedAt)}`
      : "Đã lưu tài khoản";
    session1688Badge.className = "session-badge session-badge--on";
    return;
  }
  session1688Badge.textContent = "Chưa đăng nhập";
  session1688Badge.className = "session-badge session-badge--off";
}

async function refresh1688Session() {
  const data = await apiGet("/api/1688/status");
  updateSessionBadge(!!data.loggedIn, data.savedAt);
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

function proxyUrl(mediaUrl, filename, pageUrl) {
  const params = new URLSearchParams({ url: mediaUrl });
  if (filename) params.set("filename", filename);
  if (pageUrl) params.set("referer", pageUrl);
  return `/api/proxy?${params.toString()}`;
}

function sanitizeSaveName(name) {
  return (
    String(name || "media")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim()
      .slice(0, 80) || "media"
  );
}

function guessExtension(contentType, mediaUrl, type) {
  const fromUrl = mediaUrl.split("?")[0].split("#")[0].match(/\.([a-z0-9]+)$/i);
  if (fromUrl) return `.${fromUrl[1].toLowerCase()}`;
  if (contentType) {
    if (contentType.includes("jpeg")) return ".jpg";
    if (contentType.includes("png")) return ".png";
    if (contentType.includes("webp")) return ".webp";
    if (contentType.includes("gif")) return ".gif";
    if (contentType.includes("mp4")) return ".mp4";
    if (contentType.includes("webm")) return ".webm";
  }
  return type === "video" ? ".mp4" : ".jpg";
}

function buildLocalFilename(index, item, contentType, mediaUrl) {
  const ext = guessExtension(contentType, mediaUrl, item.type);
  const base = sanitizeSaveName(item.title || item.type || "media");
  return `${String(index + 1).padStart(3, "0")}_${base}${ext}`;
}

async function pickSaveDirectory() {
  if (typeof window.showDirectoryPicker !== "function") return null;
  return window.showDirectoryPicker({ mode: "readwrite", id: "bibbidi-save" });
}

async function downloadViaFileSystem(dirHandle, folderName, items, pageUrl, onProgress) {
  const safeFolder = sanitizeSaveName(folderName);
  const folderHandle = await dirHandle.getDirectoryHandle(safeFolder, { create: true });
  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.(i, items.length);
    try {
      const response = await fetch(proxyUrl(item.url, null, pageUrl));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      const blob = await response.blob();
      const filename = buildLocalFilename(i, item, contentType, item.url);
      const fileHandle = await folderHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      downloaded++;
    } catch {
      failed++;
    }
  }

  return {
    downloaded,
    failed,
    total: items.length,
    folder: `${dirHandle.name}\\${safeFolder}`,
    folderName: safeFolder,
  };
}

async function downloadViaServer(url, items, folderName, outputDir) {
  return apiPost("/api/download-all", { url, items, folderName, outputDir });
}

async function downloadWithPicker(url, items) {
  const folderName = sanitizeSaveName(saveFolderNameInput?.value?.trim());
  if (!folderName) {
    throw new Error("Vui lòng nhập tên thư mục.");
  }

  try {
    const dirHandle = await pickSaveDirectory();
    if (dirHandle) {
      setStatus("Đang lưu file vào thư mục bạn chọn...", "info");
      const result = await downloadViaFileSystem(dirHandle, folderName, items, url, (i, total) => {
        setProgress(true, `Đang lưu ${i + 1}/${total}...`, ((i + 1) / total) * 100);
      });
      if (savePathHint) {
        savePathHint.textContent = `Đã lưu vào: ${result.folder}`;
      }
      return result;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Bạn đã hủy chọn thư mục.");
    }
    if (error.name !== "SecurityError") {
      throw error;
    }
  }

  const outputDir = window.prompt(
    "Nhập đường dẫn thư mục cha trên máy (vd: C:\\Users\\Tên\\Desktop):",
    ""
  );
  if (!outputDir?.trim()) {
    throw new Error("Chưa chọn thư mục lưu.");
  }

  const result = await downloadViaServer(url, items, folderName, outputDir.trim());
  if (savePathHint) {
    savePathHint.textContent = `Đã lưu vào: ${result.folder}`;
  }
  return result;
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
  if (saveFolderNameInput) {
    saveFolderNameInput.value = sanitizeSaveName(data.pageTitle || "media");
  }
  if (savePathHint) {
    savePathHint.textContent =
      "Khi bấm Tải, bạn chọn thư mục lưu trên máy (Desktop, Downloads…).";
  }
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
    const statusMsg = is1688 ? "Đang lấy dữ liệu 1688..." : "Đang quét trang...";
    setStatus(statusMsg, "info");
    await animateProgress(0, 30, statusMsg, 600);

    const shouldAutoDownload = autoDownload;

    if (shouldAutoDownload) {
      const data = await scrapePage(url);
      renderResults(data);

      if (!currentMedia.length) {
        setProgress(false);
        setStatus("Không tìm thấy ảnh hoặc video trên trang này.", "error");
        return;
      }

      await animateProgress(30, 70, `Tìm thấy ${currentMedia.length} file`, 400);
      setProgress(false);
      setStatus(
        `Tìm thấy ${currentMedia.length} file — đặt tên thư mục rồi bấm Tải đã chọn.`,
        "success"
      );
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

let isLoginBusy = false;

async function handle1688Login() {
  if (isLoginBusy) {
    setStatus("Đang mở trình duyệt đăng nhập, vui lòng đợi...", "info");
    return;
  }

  isLoginBusy = true;
  if (login1688Btn) login1688Btn.disabled = true;
  clearStatus();
  setStatus("Đang mở trình duyệt — hãy đăng nhập 1688 trong cửa sổ vừa hiện...", "info");
  setProgress(true, "Chờ đăng nhập 1688...", 15);

  try {
    const data = await apiPost("/api/1688/login", {}, LOGIN_TIMEOUT_MS);
    setProgress(false);

    if (!data.ok) {
      setStatus(data.message || "Đăng nhập chưa thành công.", "error");
      return;
    }

    updateSessionBadge(true, data.savedAt);
    setStatus(data.message, "success");
  } catch (error) {
    setProgress(false);
    const msg = error.message || "Không đăng nhập được.";
    if (msg.includes("Failed to fetch") || msg.includes("kết nối")) {
      setStatus("Server chưa chạy hoặc chưa cập nhật. Chạy lại npm start rồi thử.", "error");
    } else if (msg.includes("không hợp lệ")) {
      setStatus("Server chưa có API đăng nhập. Tắt server (Ctrl+C) rồi chạy lại npm start.", "error");
    } else {
      setStatus(msg, "error");
    }
  } finally {
    isLoginBusy = false;
    if (login1688Btn) login1688Btn.disabled = false;
    refresh1688Session().catch(() => {});
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
    const folderName = sanitizeSaveName(saveFolderNameInput?.value?.trim());
    if (!folderName) {
      setStatus("Vui lòng nhập tên thư mục trước khi tải.", "error");
      saveFolderNameInput?.focus();
      return;
    }

    setStatus(`Chọn thư mục lưu cho ${selected.length} file...`, "info");
    await animateProgress(0, 20, "Chờ bạn chọn thư mục...", 300);

    const result = await downloadWithPicker(url, selected);
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

async function scheduleAutoScrape() {
  const url = pageUrlInput.value.trim();
  updateClearBtn();
  if (!URL_PATTERN.test(url) || isBusy || isLoginBusy) return;

  if (IS_1688.test(url)) {
    try {
      const status = await apiGet("/api/1688/status");
      if (!status.loggedIn) return;
    } catch {
      return;
    }
  }

  handleScrape(true);
}

let pasteTimer = null;

scrapeBtn.addEventListener("click", () => handleScrape(false));

if (login1688Btn) {
  login1688Btn.addEventListener("click", handle1688Login);
}

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
    return refresh1688Session();
  })
  .catch(() => {
    setStatus(
      "Server chưa chạy. Mở terminal, chạy npm start, rồi vào http://localhost:3456",
      "error"
    );
  });
