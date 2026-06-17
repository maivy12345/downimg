const express = require("express");
const cheerio = require("cheerio");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const { is1688ProductUrl, fetch1688Media, extractMediaFromEmbeddedJson, sync1688Login } = require("./lib/1688");

const app = express();
const PORT = process.env.PORT || 3456;
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

app.use((req, res, next) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function resolveUrl(base, value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

function pickFromSrcset(srcset, base) {
  if (!srcset) return null;
  const parts = srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  const candidate = parts[parts.length - 1] || parts[0];
  return resolveUrl(base, candidate);
}

function addMedia(set, url, type, title) {
  if (!url) return;
  const key = `${type}:${url}`;
  if (!set.has(key)) {
    set.set(key, { url, type, title: title || "" });
  }
}

function extractFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const media = new Map();

  $("img").each((_, el) => {
    const $el = $(el);
    const title = $el.attr("alt") || $el.attr("title") || "";
    const candidates = [
      $el.attr("src"),
      $el.attr("data-src"),
      $el.attr("data-original"),
      $el.attr("data-lazy-src"),
      pickFromSrcset($el.attr("srcset"), pageUrl),
      pickFromSrcset($el.attr("data-srcset"), pageUrl),
    ];
    for (const candidate of candidates) {
      const resolved = resolveUrl(pageUrl, candidate);
      if (resolved) {
        addMedia(media, resolved, "image", title);
        break;
      }
    }
  });

  $("picture source").each((_, el) => {
    const src = pickFromSrcset($(el).attr("srcset"), pageUrl) || resolveUrl(pageUrl, $(el).attr("src"));
    addMedia(media, src, "image", "");
  });

  $("video").each((_, el) => {
    const $el = $(el);
    const title = $el.attr("title") || "";
    const poster = resolveUrl(pageUrl, $el.attr("poster"));
    if (poster) addMedia(media, poster, "image", `${title} (poster)`.trim());

    const videoSrc = resolveUrl(pageUrl, $el.attr("src"));
    if (videoSrc) addMedia(media, videoSrc, "video", title);

    $el.find("source").each((__, source) => {
      const src =
        resolveUrl(pageUrl, $(source).attr("src")) ||
        pickFromSrcset($(source).attr("srcset"), pageUrl);
      addMedia(media, src, "video", title);
    });
  });

  $("source[src], source[data-src]").each((_, el) => {
    const $el = $(el);
    const typeHint = ($el.attr("type") || "").toLowerCase();
    const src = resolveUrl(pageUrl, $el.attr("src") || $el.attr("data-src"));
    const mediaType = typeHint.startsWith("video/") ? "video" : "image";
    addMedia(media, src, mediaType, "");
  });

  $("a[href]").each((_, el) => {
    const href = resolveUrl(pageUrl, $(el).attr("href"));
    if (!href) return;
    if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(href)) {
      addMedia(media, href, "image", $(el).text().trim());
    }
    if (/\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(href)) {
      addMedia(media, href, "video", $(el).text().trim());
    }
  });

  const metaPairs = [
    ["meta[property='og:image']", "content", "image"],
    ["meta[property='og:image:url']", "content", "image"],
    ["meta[property='og:video']", "content", "video"],
    ["meta[property='og:video:url']", "content", "video"],
    ["meta[name='twitter:image']", "content", "image"],
    ["meta[name='twitter:player:stream']", "content", "video"],
    ["link[rel='image_src']", "href", "image"],
  ];

  for (const [selector, attr, type] of metaPairs) {
    $(selector).each((_, el) => {
      addMedia(media, resolveUrl(pageUrl, $(el).attr(attr)), type, "meta");
    });
  }

  const bgRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  $("[style*='background']").each((_, el) => {
    const style = $(el).attr("style") || "";
    let match;
    while ((match = bgRegex.exec(style)) !== null) {
      addMedia(media, resolveUrl(pageUrl, match[1]), "image", "background");
    }
  });

  const embedded = extractMediaFromEmbeddedJson(html);
  for (const item of embedded.media) {
    addMedia(media, item.url, item.type, item.title);
  }

  return Array.from(media.values());
}

async function fetchPage(url, options = {}) {
  if (is1688ProductUrl(url)) {
    return fetch1688Media(url, options);
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en;q=0.9",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Không tải được trang (${response.status})`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("image/")) {
    return {
      pageTitle: path.basename(new URL(url).pathname) || "image",
      media: [{ url, type: "image", title: "Trực tiếp" }],
    };
  }

  if (contentType.includes("video/")) {
    return {
      pageTitle: path.basename(new URL(url).pathname) || "video",
      media: [{ url, type: "video", title: "Trực tiếp" }],
    };
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const pageTitle = $("title").first().text().trim() || url;
  const media = extractFromHtml(html, url);

  return { pageTitle, media };
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 120) || "media";
}

function guessExtension(contentType, mediaUrl, type) {
  const fromUrl = mediaUrl.split("?")[0].split("#")[0].match(/\.([a-z0-9]+)$/i);
  if (fromUrl) return `.${fromUrl[1].toLowerCase()}`;

  if (contentType) {
    if (contentType.includes("jpeg")) return ".jpg";
    if (contentType.includes("png")) return ".png";
    if (contentType.includes("webp")) return ".webp";
    if (contentType.includes("gif")) return ".gif";
    if (contentType.includes("svg")) return ".svg";
    if (contentType.includes("mp4")) return ".mp4";
    if (contentType.includes("webm")) return ".webm";
    if (contentType.includes("ogg")) return ".ogg";
  }

  return type === "video" ? ".mp4" : ".jpg";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/1688/sync", async (_req, res) => {
  try {
    const result = await sync1688Login();
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "Không đồng bộ được phiên 1688." });
  }
});

app.post("/api/scrape", async (req, res) => {
  const { url, cookies } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Vui lòng nhập link trang web." });
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: "Link không hợp lệ." });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Chỉ hỗ trợ link http/https." });
  }

  try {
    const result = await fetchPage(parsed.href, { cookies });
    const images = result.media.filter((item) => item.type === "image");
    const videos = result.media.filter((item) => item.type === "video");

    res.json({
      pageTitle: result.pageTitle,
      pageUrl: parsed.href,
      images,
      videos,
      total: result.media.length,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Không thể lấy media từ trang này.",
    });
  }
});

app.post("/api/grab", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Vui lòng nhập link trang web." });
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: "Link không hợp lệ." });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Chỉ hỗ trợ link http/https." });
  }

  try {
    const result = await fetchPage(parsed.href, { cookies: req.body?.cookies });
    if (!result.media.length) {
      return res.status(404).json({ error: "Không tìm thấy ảnh hoặc video nào." });
    }

    const folderName = `${sanitizeFilename(result.pageTitle)}_${Date.now().toString(36)}`;
    const targetDir = path.join(DOWNLOADS_DIR, folderName);
    await fs.mkdir(targetDir, { recursive: true });

    const downloadResults = [];
    for (let i = 0; i < result.media.length; i++) {
      const item = result.media[i];
      try {
        const { buffer, contentType } = await downloadMediaFile(item.url, parsed.href);
        const filename = buildFilename(i, item, contentType);
        const filePath = path.join(targetDir, filename);
        await fs.writeFile(filePath, buffer);
        downloadResults.push({ success: true, filename, path: filePath, url: item.url, type: item.type });
      } catch (error) {
        downloadResults.push({
          success: false,
          url: item.url,
          type: item.type,
          error: error.message || "Lỗi tải file",
        });
      }
    }

    const downloaded = downloadResults.filter((r) => r.success);
    const failed = downloadResults.filter((r) => !r.success);
    const images = result.media.filter((item) => item.type === "image");
    const videos = result.media.filter((item) => item.type === "video");

    res.json({
      pageTitle: result.pageTitle,
      pageUrl: parsed.href,
      images,
      videos,
      total: result.media.length,
      folder: targetDir,
      folderName,
      downloaded: downloaded.length,
      failed: failed.length,
      results: downloadResults,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Không thể lấy media từ trang này.",
    });
  }
});

function refererForMedia(mediaUrl, pageReferer) {
  if (pageReferer) return pageReferer;
  try {
    const host = new URL(mediaUrl).hostname;
    if (/alicdn\.com$/i.test(host) || /taobao\.com$/i.test(host)) return "https://detail.1688.com/";
  } catch {
    // ignore
  }
  try {
    return new URL(mediaUrl).origin;
  } catch {
    return undefined;
  }
}

async function downloadMediaFile(mediaUrl, referer) {
  const response = await fetch(mediaUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: refererForMedia(mediaUrl, referer),
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const type = contentType.startsWith("video/") ? "video" : "image";
  const buffer = Buffer.from(await response.arrayBuffer());

  return { buffer, contentType, type };
}

function buildFilename(index, item, contentType) {
  const ext = guessExtension(contentType, item.url, item.type);
  const base = sanitizeFilename(item.title || item.type || "media");
  const prefix = String(index + 1).padStart(3, "0");
  return `${prefix}_${base}${ext}`;
}

app.post("/api/download-all", async (req, res) => {
  const { url, items } = req.body || {};

  let mediaItems = Array.isArray(items) ? items : null;
  let pageTitle = "media";
  let pageUrl = url;

  if (!mediaItems) {
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Vui lòng nhập link hoặc danh sách media." });
    }

    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return res.status(400).json({ error: "Link không hợp lệ." });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Chỉ hỗ trợ link http/https." });
    }

    try {
      const result = await fetchPage(parsed.href, { cookies: req.body?.cookies });
      mediaItems = result.media;
      pageTitle = result.pageTitle;
      pageUrl = parsed.href;
    } catch (error) {
      return res.status(500).json({
        error: error.message || "Không thể lấy media từ trang này.",
      });
    }
  }

  if (!mediaItems.length) {
    return res.status(404).json({ error: "Không tìm thấy ảnh hoặc video nào." });
  }

  const folderName = `${sanitizeFilename(pageTitle)}_${Date.now().toString(36)}`;
  const targetDir = path.join(DOWNLOADS_DIR, folderName);

  try {
    await fs.mkdir(targetDir, { recursive: true });

    const results = [];
    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      try {
        const { buffer, contentType } = await downloadMediaFile(item.url, pageUrl);
        const filename = buildFilename(i, item, contentType);
        const filePath = path.join(targetDir, filename);
        await fs.writeFile(filePath, buffer);
        results.push({ success: true, filename, path: filePath, url: item.url, type: item.type });
      } catch (error) {
        results.push({
          success: false,
          url: item.url,
          type: item.type,
          error: error.message || "Lỗi tải file",
        });
      }
    }

    const downloaded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    res.json({
      pageTitle,
      pageUrl,
      folder: targetDir,
      folderName,
      downloaded: downloaded.length,
      failed: failed.length,
      total: mediaItems.length,
      results,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Không thể lưu file.",
    });
  }
});

app.get("/api/proxy", async (req, res) => {
  const mediaUrl = req.query.url;
  const filename = req.query.filename;

  if (!mediaUrl) {
    return res.status(400).send("Thiếu url");
  }

  try {
    const { buffer, contentType } = await downloadMediaFile(mediaUrl);
    const type = contentType.startsWith("video/") ? "video" : "image";
    const ext = guessExtension(contentType, mediaUrl, type);
    const safeName = sanitizeFilename(filename || `media${ext}`);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (error) {
    res.status(500).send(error.message || "Lỗi tải file");
  }
});

app.listen(PORT, async () => {
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  console.log(`Bibbidi Media Grabber: http://localhost:${PORT}`);
  console.log(`Thư mục tải: ${DOWNLOADS_DIR}`);
});
