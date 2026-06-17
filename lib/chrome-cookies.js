const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const { DatabaseSync } = require("node:sqlite");
const { Dpapi } = require("@primno/dpapi");
const { getChromeUserDataDir, getChromeProfileName, isChromeRunning } = require("./chrome-bridge");

const COOKIE_DOMAINS = ["1688.com", "taobao.com", "alibaba.com", "alicdn.com", "mmstat.com", "login.taobao.com"];

function decryptChromeValue(encryptedValue, masterKey) {
  if (!encryptedValue || !masterKey) return null;
  const buffer = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);

  if (buffer.slice(0, 3).toString() === "v10" || buffer.slice(0, 3).toString() === "v11") {
    const iv = buffer.slice(3, 15);
    const payload = buffer.slice(15, buffer.length - 16);
    const tag = buffer.slice(buffer.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  }

  try {
    return Dpapi.unprotectData(buffer, null, "CurrentUser").toString("utf8");
  } catch {
    return null;
  }
}

async function readMasterKey() {
  const localStatePath = path.join(getChromeUserDataDir(), "Local State");
  const raw = await fs.readFile(localStatePath, "utf8");
  const data = JSON.parse(raw);
  const encryptedKey = Buffer.from(data.os_crypt.encrypted_key, "base64");
  return Dpapi.unprotectData(encryptedKey.slice(5), null, "CurrentUser");
}

async function copyCookiesDatabase(profileName) {
  const source = path.join(getChromeUserDataDir(), profileName, "Network", "Cookies");
  const target = path.join(__dirname, "..", ".chrome-cookies-copy.db");
  await fs.copyFile(source, target);
  return target;
}

function domainMatches(host) {
  const normalized = String(host || "").replace(/^\./, "").toLowerCase();
  return COOKIE_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

async function importChromeCookies() {
  if (process.platform !== "win32") return {};
  if (await isChromeRunning()) return {};

  const profileName = await getChromeProfileName();
  let dbPath;

  try {
    dbPath = await copyCookiesDatabase(profileName);
  } catch {
    return {};
  }

  let db;
  try {
    const masterKey = await readMasterKey();
    db = new DatabaseSync(dbPath, { readOnly: true });
    const chromeNow = (Date.now() + 11644473600000) * 1000;
    const rows = db
      .prepare(
        "SELECT host_key, name, encrypted_value, value, expires_utc FROM cookies WHERE expires_utc = 0 OR expires_utc > ?"
      )
      .all(chromeNow);

    const cookies = {};
    for (const row of rows) {
      if (!domainMatches(row.host_key)) continue;
      let cookieValue = row.value;
      if (!cookieValue && row.encrypted_value) {
        cookieValue = decryptChromeValue(row.encrypted_value, masterKey);
      }
      if (cookieValue) cookies[row.name] = cookieValue;
    }
    return cookies;
  } catch {
    return {};
  } finally {
    if (db) db.close();
    if (dbPath) {
      try {
        await fs.unlink(dbPath);
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  importChromeCookies,
};
