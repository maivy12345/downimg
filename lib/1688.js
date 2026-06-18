const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const { CDP_URL, getChromeUserDataDir, getChromeProfileName, stopChrome, isChromeRunning, isCdpAvailable } = require("./chrome-bridge");
const { importChromeCookies } = require("./chrome-cookies");

const APP_KEY = "12574478";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROFILE_DIR = path.join(__dirname, "..", ".browser-profile");
const SESSION_FILE = path.join(__dirname, "..", ".1688-session.json");
const MTOP_GATEWAYS = [
  "https://h5api.m.1688.com",
  "https://h5api.m.taobao.com",
];

let playwrightBusy = false;

const OFFER_ID_RE = /(?:offer\/|offerId=)(\d{5,})/i;

function is1688ProductUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)1688\.com$/i.test(host) && OFFER_ID_RE.test(url);
  } catch {
    return false;
  }
}

function extractOfferId(url) {
  const match = String(url).match(OFFER_ID_RE);
  return match ? match[1] : null;
}

function normalizeMediaUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  if (!trimmed || trimmed.startsWith("data:")) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `https://cbu01.alicdn.com${trimmed}`;
  if (trimmed.startsWith("http")) return trimmed;
  return null;
}

function addMedia(set, url, type, title) {
  const normalized = normalizeMediaUrl(url);
  if (!normalized) return;
  if (
    !/alicdn\.com|taobao\.com|tmall\.com|\.(jpe?g|png|webp|gif|mp4|m3u8|mov)(\?|#|$)/i.test(normalized)
  ) {
    return;
  }
  const key = `${type}:${normalized}`;
  if (!set.has(key)) set.set(key, { url: normalized, type, title: title || "" });
}

function collectVideoObject(set, video, title = "Video sản phẩm") {
  if (!video) return;
  if (typeof video === "string") {
    addMedia(set, video, "video", title);
    return;
  }
  if (typeof video !== "object") return;

  addMedia(set, video.videoUrl, "video", title);
  addMedia(set, video.url, "video", title);
  addMedia(set, video.contentUrl, "video", title);
  addMedia(set, video.playUrl, "video", title);
  if (video.videoUrls && typeof video.videoUrls === "object") {
    for (const url of Object.values(video.videoUrls)) {
      addMedia(set, url, "video", title);
    }
  }
  addMedia(set, video.coverUrl, "image", `${title} (cover)`.trim());
}

function getGalleryBlock(dataModel) {
  const gallery = dataModel?.gallery;
  if (!gallery) return {};
  return gallery.fields || gallery;
}

function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function cookieString(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function mergeCookies(...maps) {
  return Object.assign({}, ...maps);
}

async function loadSavedCookies() {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data?.cookies && typeof data.cookies === "object") return data.cookies;
  } catch {
    // no saved session
  }
  return {};
}

async function saveCookies(cookies) {
  if (!cookies._m_h5_tk) return;
  try {
    await fs.writeFile(
      SESSION_FILE,
      JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {
    // ignore write errors
  }
}

function mtopSign(token, timestamp, data) {
  const prefix = token.includes("_") ? token.split("_")[0] : token;
  return crypto.createHash("md5").update(`${prefix}&${timestamp}&${APP_KEY}&${data}`).digest("hex");
}

async function bootstrapMtopCookies(existingCookies = {}, gateway = MTOP_GATEWAYS[0]) {
  const cookies = { ...existingCookies };
  if (cookies._m_h5_tk) return cookies;

  const bootstrapUrl =
    `${gateway}/h5/mtop.alibaba.alisite.cbu.server.moduleasyncservice/1.0/` +
    `?jsv=2.7.4&appKey=${APP_KEY}&api=mtop.alibaba.alisite.cbu.server.ModuleAsyncService` +
    "&v=1.0&type=jsonp&dataType=jsonp&callback=cb&data=%7B%7D";

  const response = await fetch(bootstrapUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://detail.1688.com/",
      ...(Object.keys(cookies).length ? { Cookie: cookieString(cookies) } : {}),
    },
  });

  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  return cookies;
}

function parseJsonPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const match = trimmed.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  if (match) return JSON.parse(match[1]);
  throw new Error("Phản hồi JSON không hợp lệ");
}

async function fetchMiniod(offerId, cookies, referer, gateway = MTOP_GATEWAYS[0]) {
  if (!cookies._m_h5_tk) return null;

  const dataObj = {
    sk: "",
    offerId: Number(offerId),
    parametersMap: JSON.stringify({ fromPC: true }),
  };
  const data = JSON.stringify(dataObj);
  const timestamp = String(Date.now());
  const sign = mtopSign(cookies._m_h5_tk, timestamp, data);
  const params = new URLSearchParams({
    jsv: "2.7.4",
    appKey: APP_KEY,
    t: timestamp,
    sign,
    api: "mtop.1688.laputa.miniod",
    v: "1.0",
    type: "originaljson",
    dataType: "jsonp",
    timeout: "20000",
    data,
  });

  const response = await fetch(`${gateway}/h5/mtop.1688.laputa.miniod/1.0/?${params}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: referer,
      Cookie: cookieString(cookies),
    },
    body: `data=${encodeURIComponent(data)}`,
  });

  const payload = parseJsonPayload(await response.text());
  if (!payload?.data?.model) return null;
  if (payload.ret?.some((item) => /FAIL|ERROR|挤爆|punish/i.test(item))) return null;
  return payload.data.model;
}

async function tryMiniodAllGateways(offerId, cookies, referer) {
  for (const gateway of MTOP_GATEWAYS) {
    const bootstrapped = await bootstrapMtopCookies(cookies, gateway);
    const model = await fetchMiniod(offerId, bootstrapped, referer, gateway);
    if (model) {
      await saveCookies(bootstrapped);
      return model;
    }
  }
  return null;
}

function collectFromList(set, list, type, title) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (typeof item === "string") {
      addMedia(set, item, type, title);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    addMedia(set, item.fullPathImageURI, type, title);
    addMedia(set, item.imageURI, type, title);
    addMedia(set, item.url, type, title);
    addMedia(set, item.imgUrl, type, title);
    addMedia(set, item.videoUrl, "video", title);
    addMedia(set, item.coverUrl, "image", `${title} (cover)`.trim());
  }
}

function extractMediaFromMiniod(model) {
  const media = new Map();
  const offerDetail = model?.offerModel?.offerDetail || {};
  const dataModel = model?.dataModel || {};
  const galleryBlock = getGalleryBlock(dataModel);
  const gallery = dataModel.gallery || {};

  collectFromList(media, offerDetail.imageList, "image", "Ảnh sản phẩm");
  collectFromList(media, offerDetail.mainImageList, "image", "Ảnh chính");
  collectFromList(media, galleryBlock.images, "image", "Gallery");
  collectFromList(media, galleryBlock.offerImgList, "image", "Gallery");
  collectFromList(media, galleryBlock.mainImage, "image", "Ảnh chính");
  collectFromList(media, gallery.images, "image", "Gallery");
  collectFromList(media, gallery.offerImageList, "image", "Gallery");
  collectFromList(media, galleryBlock.videos, "video", "Video sản phẩm");

  collectVideoObject(media, galleryBlock.video, galleryBlock.video?.title || "Video sản phẩm");
  collectVideoObject(media, gallery.video, gallery.video?.title || "Video sản phẩm");
  collectVideoObject(media, gallery.mainVideo, "Video chính");
  collectVideoObject(media, dataModel.mainVideo, "Video chính");
  collectVideoObject(media, offerDetail.wirelessVideo, offerDetail.wirelessVideo?.title || "Video sản phẩm");

  const title =
    offerDetail.subject ||
    dataModel.productTitle?.title ||
    dataModel.offerTitle ||
    "1688 offer";

  return { pageTitle: title, media: Array.from(media.values()) };
}

function extractMediaFromEmbeddedJson(html) {
  const media = new Map();
  let pageTitle = "";

  const contextMatch = html.match(/window\.context\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (contextMatch) {
    try {
      const context = JSON.parse(contextMatch[1]);
      const data = context?.result?.data;
      if (data) {
        const fromModel = extractMediaFromMiniod({
          offerModel: { offerDetail: data },
          dataModel: data,
        });
        for (const item of fromModel.media) addMedia(media, item.url, item.type, item.title);
        pageTitle = fromModel.pageTitle || pageTitle;
      }
    } catch {
      // ignore
    }
  }

  const jsonLdMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of jsonLdMatches) {
    try {
      const json = JSON.parse(match[1]);
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        if (node.name || node.headline) pageTitle = pageTitle || node.name || node.headline;
        if (typeof node.image === "string") addMedia(media, node.image, "image", "JSON-LD");
        if (Array.isArray(node.image)) collectFromList(media, node.image, "image", "JSON-LD");
        if (node.video) {
          const videoUrl = typeof node.video === "string" ? node.video : node.video.contentUrl;
          addMedia(media, videoUrl, "video", "JSON-LD");
        }
      }
    } catch {
      // ignore
    }
  }

  const alicdnMatches = html.matchAll(
    /https?:\/\/(?:cbu\d*|img|video|cloud\.video)\.(?:alicdn|taobao)\.com\/[^"'\\\s<>]+/gi
  );
  for (const match of alicdnMatches) {
    const url = match[0].replace(/[)\\],;]+$/, "");
    const type = /\.(mp4|m3u8|mov)(\?|#|$)/i.test(url) ? "video" : "image";
    if (url.includes("/img/ibank/") || type === "video") {
      addMedia(media, url, type, "Alicdn");
    }
  }

  return { pageTitle, media: Array.from(media.values()) };
}

function isCaptchaHtml(html) {
  return /验证码|punish|x5secdata|captcha|_____tmd_____/i.test(html);
}

function playwrightCookiesToMap(cookies) {
  const map = {};
  for (const c of cookies) {
    if (c.name && c.value) map[c.name] = c.value;
  }
  return map;
}

function has1688LoginCookies(cookies) {
  return !!(cookies.lid || cookies.unb || cookies._nk_ || cookies.sgcookie || cookies.cookie2);
}

async function get1688SessionStatus() {
  const cookies = await loadSavedCookies();
  let savedAt = null;
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    savedAt = JSON.parse(raw).savedAt || null;
  } catch {
    // no session file
  }
  return {
    loggedIn: has1688LoginCookies(cookies),
    hasSession: !!cookies._m_h5_tk,
    savedAt,
  };
}

function collectPageSnapshot(pageData, capturedMiniod, capturedMedia, offerId) {
  if (capturedMiniod.length) {
    return extractMediaFromMiniod(capturedMiniod[capturedMiniod.length - 1]);
  }
  if (capturedMedia.size) {
    return {
      pageTitle: `1688 offer ${offerId}`,
      media: Array.from(capturedMedia).map((mediaUrl) => ({
        url: mediaUrl,
        type: /\.(mp4|m3u8|mov)(\?|#|$)/i.test(mediaUrl) ? "video" : "image",
        title: "Ảnh sản phẩm",
      })),
    };
  }
  const fromHtml = extractMediaFromEmbeddedJson(pageData.html);
  const merged = new Map();
  for (const item of [...fromHtml.media, ...pageData.media.filter((m) => m?.url)]) {
    addMedia(merged, item.url, item.type, item.title);
  }
  if (merged.size) {
    return {
      pageTitle: fromHtml.pageTitle || pageData.title || `1688 offer ${offerId}`,
      media: Array.from(merged.values()),
    };
  }
  return null;
}

async function readPageSnapshot(page) {
  return page.evaluate(() => {
    const out = { title: document.title, html: document.documentElement.outerHTML, media: [] };
    try {
      const data = window.context?.result?.data;
      const gallery = data?.gallery?.fields || data?.gallery;
      if (gallery?.images) {
        for (const img of gallery.images) {
          out.media.push({
            url: img.fullPathImageURI || img.imageURI,
            type: "image",
            title: "Gallery",
          });
        }
      }
      if (Array.isArray(gallery?.offerImgList)) {
        for (const url of gallery.offerImgList) {
          out.media.push({ url, type: "image", title: "Gallery" });
        }
      }
      const videos = [
        gallery?.video,
        gallery?.mainVideo,
        data?.wirelessVideo,
        data?.gallery?.video,
        data?.gallery?.mainVideo,
      ].filter(Boolean);
      for (const video of videos) {
        const videoUrl =
          video.videoUrl ||
          video.url ||
          video.videoUrls?.ios ||
          video.videoUrls?.android;
        if (videoUrl) out.media.push({ url: videoUrl, type: "video", title: video.title || "Video" });
      }
    } catch {
      // ignore
    }
    return out;
  });
}

function attach1688Listeners(page, capturedMiniod, capturedMedia) {
  page.on("response", async (response) => {
    const target = response.url();
    if (/cbu\d*\.alicdn\.com\/img\/ibank|video\.alicdn\.com|cloud\.video\.taobao\.com/i.test(target)) {
      capturedMedia.add(target.split("?")[0]);
    }
    if (!target.includes("laputa.miniod")) return;
    try {
      const text = await response.text();
      const payload = parseJsonPayload(text);
      if (payload?.data?.model) capturedMiniod.push(payload.data.model);
    } catch {
      // ignore
    }
  });
}

async function stopChromeForProfile() {
  if (await isChromeRunning()) await stopChrome();
}

async function fetchViaChromeProfile(url, offerId) {
  const timeoutMs = Number(process.env.BIBBIDI_CHROME_PROFILE_TIMEOUT || 90000);
  return Promise.race([
    fetchViaChromeProfileInner(url, offerId),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function fetchViaChromeProfileInner(url, offerId) {
  if (playwrightBusy) return null;
  playwrightBusy = true;

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    playwrightBusy = false;
    return null;
  }

  const userDataDir = getChromeUserDataDir();
  const profileName = await getChromeProfileName();
  const capturedMiniod = [];
  const capturedMedia = new Set();
  let context;

  try {
    await stopChromeForProfile();

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      locale: "zh-CN",
      viewport: { width: 1366, height: 768 },
      args: [
        `--profile-directory=${profileName}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    const page = context.pages()[0] || (await context.newPage());
    attach1688Listeners(page, capturedMiniod, capturedMedia);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    for (let i = 0; i < 25; i++) {
      if (capturedMiniod.length || capturedMedia.size) break;
      const hasGallery = await page.evaluate(
        () => (window.context?.result?.data?.gallery?.images?.length || 0) > 0
      );
      if (hasGallery) break;
      await page.waitForTimeout(2000);
    }

    const browserCookies = playwrightCookiesToMap(await context.cookies());
    await saveCookies(browserCookies);

    const pageData = await readPageSnapshot(page);
    const result = collectPageSnapshot(pageData, capturedMiniod, capturedMedia, offerId);
    return result?.media?.length ? result : null;
  } catch {
    return null;
  } finally {
    playwrightBusy = false;
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

async function fetchViaCdp(url, offerId) {
  if (!(await isCdpAvailable())) return null;

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    return null;
  }

  const capturedMiniod = [];
  const capturedMedia = new Set();
  let browser;

  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    if (!context) return null;

    const page = await context.newPage();
    attach1688Listeners(page, capturedMiniod, capturedMedia);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await Promise.race([
      page.waitForResponse((r) => r.url().includes("laputa.miniod"), { timeout: 20000 }).catch(() => null),
      page.waitForTimeout(8000),
    ]);

    const pageData = await readPageSnapshot(page);
    const result = collectPageSnapshot(pageData, capturedMiniod, capturedMedia, offerId);

    const browserCookies = playwrightCookiesToMap(await context.cookies());
    await saveCookies(browserCookies);

    await page.close();
    return result;
  } catch {
    return null;
  }
}

async function fetchViaPlaywright(url, offerId) {
  const timeoutMs = Number(process.env.BIBBIDI_PLAYWRIGHT_TIMEOUT || 35000);
  return Promise.race([
    fetchViaPlaywrightInner(url, offerId, true),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function fetchViaPlaywrightHeaded(url, offerId) {
  const timeoutMs = Number(process.env.BIBBIDI_HEADED_TIMEOUT || 90000);
  return Promise.race([
    fetchViaPlaywrightInner(url, offerId, false),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function fetchViaPlaywrightInner(url, offerId, headless) {
  if (playwrightBusy) return null;
  playwrightBusy = true;

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    return null;
  }

  const profileDir = process.env.BIBBIDI_BROWSER_PROFILE || PROFILE_DIR;
  await fs.mkdir(profileDir, { recursive: true });
  let context;

  const capturedMiniod = [];
  const capturedMedia = new Set();

  const launch = async (useHeadless) =>
    chromium.launchPersistentContext(profileDir, {
      headless: useHeadless,
      locale: "zh-CN",
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

  try {
    context = await launch(headless);

    const page = context.pages()[0] || (await context.newPage());
    attach1688Listeners(page, capturedMiniod, capturedMedia);

    const cleanUrl = `https://detail.1688.com/offer/${offerId}.html`;

    await page.goto("https://www.1688.com/", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(headless ? 1200 : 2500);

    const inPageMiniod = await page.evaluate(async (id) => {
      const mtop = window.lib?.mtop;
      if (!mtop?.request) return null;
      const data = {
        sk: "",
        offerId: Number(id),
        parametersMap: JSON.stringify({ fromPC: true }),
      };
      const types = [
        { type: "get", dataType: "jsonp" },
        { type: "jsonp", dataType: "jsonp" },
      ];
      for (const cfg of types) {
        try {
          const response = await new Promise((resolve, reject) => {
            mtop.request(
              { api: "mtop.1688.laputa.miniod", v: "1.0", data, timeout: 20000, ...cfg },
              resolve,
              reject
            );
          });
          if (response?.data?.model) return response.data.model;
        } catch {
          // try next
        }
      }
      return null;
    }, offerId);

    if (inPageMiniod) {
      const browserCookies = playwrightCookiesToMap(await context.cookies());
      await saveCookies(browserCookies);
      const result = extractMediaFromMiniod(inPageMiniod);
      if (result.media.length) return result;
    }

    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 35000 });

    if (headless) {
      await Promise.race([
        page.waitForResponse((r) => r.url().includes("laputa.miniod"), { timeout: 12000 }).catch(() => null),
        page.waitForTimeout(4000),
      ]);
    } else {
      for (let i = 0; i < 30; i++) {
        if (capturedMiniod.length || capturedMedia.size) break;
        const hasGallery = await page.evaluate(
          () => (window.context?.result?.data?.gallery?.images?.length || 0) > 0
        );
        if (hasGallery) break;
        await page.waitForTimeout(2000);
      }
    }

    const browserCookies = playwrightCookiesToMap(await context.cookies());
    await saveCookies(browserCookies);

    const pageData = await readPageSnapshot(page);
    const result = collectPageSnapshot(pageData, capturedMiniod, capturedMedia, offerId);
    if (result?.media?.length) return result;

    return null;
  } catch {
    return null;
  } finally {
    playwrightBusy = false;
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

async function fetch1688Media(url, options = {}) {
  const offerId = extractOfferId(url);
  if (!offerId) {
    throw new Error("Không tìm thấy mã sản phẩm (offerId) trong link 1688.");
  }

  const referer = `https://detail.1688.com/offer/${offerId}.html`;
  const cleanUrl = referer;
  const chromeCookies = await importChromeCookies();
  const savedCookies = await loadSavedCookies();
  let cookies = mergeCookies(savedCookies, chromeCookies, parseCookieHeader(options.cookies));
  if (chromeCookies._m_h5_tk) await saveCookies(cookies);

  const miniodModel = await tryMiniodAllGateways(offerId, cookies, referer);
  if (miniodModel) {
    const result = extractMediaFromMiniod(miniodModel);
    if (result.media.length) return result;
  }

  const headedResult = await fetchViaPlaywrightHeaded(cleanUrl, offerId);
  if (headedResult?.media?.length) return headedResult;

  cookies = mergeCookies(cookies, await loadSavedCookies());

  const cdpResult = await fetchViaCdp(cleanUrl, offerId);
  if (cdpResult?.media?.length) return cdpResult;

  const chromeProfileResult = await fetchViaChromeProfile(cleanUrl, offerId);
  if (chromeProfileResult?.media?.length) return chromeProfileResult;

  const retryModel = await tryMiniodAllGateways(offerId, cookies, referer);
  if (retryModel) {
    const result = extractMediaFromMiniod(retryModel);
    if (result.media.length) return result;
  }

  const html = await fetch(cleanUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: "https://www.1688.com/",
      ...(Object.keys(cookies).length ? { Cookie: cookieString(cookies) } : {}),
    },
    redirect: "follow",
  }).then((r) => r.text());

  if (!isCaptchaHtml(html)) {
    const embedded = extractMediaFromEmbeddedJson(html);
    if (embedded.media.length) return embedded;
  }

  throw new Error(
    "Không lấy được media từ 1688. Bấm 「Đăng nhập 1688」 phía trên, đăng nhập trong cửa sổ trình duyệt, rồi quét lại."
  );
}

async function open1688Login(options = {}) {
  if (playwrightBusy) {
    return { ok: false, message: "Tool đang quét trang khác, vui lòng đợi xong rồi thử lại." };
  }
  playwrightBusy = true;

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    playwrightBusy = false;
    return { ok: false, message: "Thiếu Playwright. Chạy: npx playwright install chromium" };
  }

  const profileDir = process.env.BIBBIDI_BROWSER_PROFILE || PROFILE_DIR;
  await fs.mkdir(profileDir, { recursive: true });

  const timeoutMs = Number(options.timeoutMs || 300000);
  const deadline = Date.now() + timeoutMs;
  let context;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      locale: "zh-CN",
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://www.1688.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    while (Date.now() < deadline) {
      let cookies = playwrightCookiesToMap(await context.cookies());
      if (has1688LoginCookies(cookies)) {
        if (!cookies._m_h5_tk) {
          cookies = await bootstrapMtopCookies(cookies);
        }
        await saveCookies(cookies);
        return {
          ok: true,
          message: "Đã lưu tài khoản 1688. Lần sau chỉ cần dán link — không cần đăng nhập lại.",
          savedAt: new Date().toISOString(),
        };
      }
      await page.waitForTimeout(2000);
    }

    return {
      ok: false,
      message: "Hết thời gian chờ (5 phút). Đăng nhập trong cửa sổ trình duyệt rồi bấm lại.",
    };
  } catch (error) {
    return { ok: false, message: error.message || "Không mở được trình duyệt đăng nhập." };
  } finally {
    playwrightBusy = false;
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}

async function sync1688Login() {
  const chromeCookies = await importChromeCookies();
  if (chromeCookies._m_h5_tk) {
    await saveCookies(chromeCookies);
    return { ok: true, message: "Đã lấy phiên đăng nhập từ Chrome. Thử dán link 1688 lại." };
  }

  await fetchViaChromeProfile("https://www.1688.com/", "858141913703");
  const saved = await loadSavedCookies();
  if (saved._m_h5_tk) {
    return { ok: true, message: "Đã đồng bộ phiên Chrome. Thử dán link 1688 lại." };
  }

  return {
    ok: false,
    message: "Chưa thấy phiên 1688 trên Chrome. Mở 1688.com, đăng nhập, rồi thử lại.",
  };
}

module.exports = {
  is1688ProductUrl,
  extractOfferId,
  fetch1688Media,
  sync1688Login,
  open1688Login,
  get1688SessionStatus,
  extractMediaFromEmbeddedJson,
};
