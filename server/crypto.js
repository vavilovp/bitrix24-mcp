// HTTP-mode only. Do not import from the stdio entry points.
import crypto from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(plain, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(blob, key) {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function loadKey(b64) {
  const key = Buffer.from(String(b64 || ""), "base64");
  if (key.length !== 32) throw new Error("SECRET_KEY must be 32 bytes, base64-encoded");
  return key;
}
