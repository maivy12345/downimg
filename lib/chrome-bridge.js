const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs/promises");

const execAsync = promisify(exec);
const CDP_URL = process.env.BIBBIDI_CDP_URL || "http://127.0.0.1:9222";
const CDP_PORT = Number(new URL(CDP_URL).port || 9222);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChromeUserDataDir() {
  return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
}

async function findChromePath() {
  const candidates = [
    process.env.BIBBIDI_CHROME_PATH,
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function getChromeProfileName() {
  const localStatePath = path.join(getChromeUserDataDir(), "Local State");
  try {
    const raw = await fs.readFile(localStatePath, "utf8");
    const data = JSON.parse(raw);
    if (data?.profile?.last_used) return data.profile.last_used;
    const profiles = Object.keys(data?.profile?.info_cache || {});
    if (profiles.length) return profiles[0];
  } catch {
    // fall through
  }
  return "Default";
}

async function isCdpAvailable() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isChromeRunning() {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq chrome.exe" /NH');
    return /chrome\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

async function stopChrome() {
  if (process.platform !== "win32") return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await execAsync("taskkill /F /IM chrome.exe /T");
    } catch {
      // Chrome may not be running
    }
    await sleep(1500);
    if (!(await isChromeRunning())) return;
  }
}

function launchChromeWithDebug(chromePath, userDataDir, profileName) {
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI",
    "--disable-background-networking",
    "about:blank",
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function waitForCdp(maxWaitMs = 45000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isCdpAvailable()) return true;
    if (!(await isChromeRunning())) {
      const chromePath = await findChromePath();
      const userDataDir = getChromeUserDataDir();
      const profileName = await getChromeProfileName();
      if (chromePath) launchChromeWithDebug(chromePath, userDataDir, profileName);
    }
    await sleep(1000);
  }
  return false;
}

async function ensureChromeCdp(options = {}) {
  if (await isCdpAvailable()) return { ok: true, mode: "existing" };

  if (process.env.BIBBIDI_AUTO_CHROME === "0") {
    return { ok: false, reason: "cdp_disabled" };
  }

  const chromePath = await findChromePath();
  if (!chromePath) return { ok: false, reason: "chrome_not_found" };

  const userDataDir = getChromeUserDataDir();
  const profileName = await getChromeProfileName();

  try {
    await fs.access(userDataDir);
  } catch {
    return { ok: false, reason: "profile_not_found" };
  }

  const wasRunning = await isChromeRunning();
  if (wasRunning || options.restart) {
    await stopChrome();
  }

  if (!(await isChromeRunning())) {
    launchChromeWithDebug(chromePath, userDataDir, profileName);
  }

  const ready = await waitForCdp(options.timeoutMs || 45000);
  if (!ready) return { ok: false, reason: "cdp_timeout" };

  return { ok: true, mode: wasRunning ? "restarted" : "launched", profileName };
}

module.exports = {
  CDP_URL,
  findChromePath,
  getChromeProfileName,
  getChromeUserDataDir,
  isCdpAvailable,
  isChromeRunning,
  stopChrome,
  ensureChromeCdp,
};
