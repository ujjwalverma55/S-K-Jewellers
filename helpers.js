// helpers.js — small utilities used by server.js. No npm dependencies.
'use strict';
const crypto = require('node:crypto');

// ---- Password hashing (security hardening, pre-go-live) ----
// Stored format: "scrypt:<saltHex>:<hashHex>". scrypt is built into Node (no npm
// dependency) and includes a per-password random salt, unlike the old sha256-with-no-salt
// scheme this replaces. verifyPassword() stays backward compatible with the two older
// formats (plain-text demo seed values, and bare sha256 hex) so existing installs/demo
// logins keep working without a forced reset — server.js calls needsRehash() after a
// successful login and transparently upgrades the stored value to scrypt at that point,
// so every real account self-migrates the first time its owner logs in after this update.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || plain == null) return false;
  const plainStr = String(plain);
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const [, salt, hashHex] = parts;
    const hashBuf = Buffer.from(hashHex, 'hex');
    const testBuf = crypto.scryptSync(plainStr, salt, hashBuf.length);
    return hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf);
  }
  // Legacy formats from before this hardening pass: plain-text (seed data) or bare
  // sha256 hex (an earlier, unsalted scheme). Both are weaker than scrypt, which is why
  // a successful login against either of these triggers an automatic rehash.
  if (plainStr === stored) return true;
  const sha256 = crypto.createHash('sha256').update(plainStr).digest('hex');
  return sha256 === stored;
}

// True if a stored password value is still in one of the legacy (pre-scrypt) formats
// and should be upgraded the next time its owner successfully logs in.
function needsRehash(stored) {
  return !stored || !stored.startsWith('scrypt:');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser — handles one or more fields and one file part.
// Good enough for simple "upload photo + a couple of text fields" forms; not a general library.
function readMultipart(req, contentType) {
  return new Promise((resolve, reject) => {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!match) return reject(new Error('No multipart boundary found'));
    const boundary = '--' + (match[1] || match[2]);
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > 25 * 1024 * 1024) { reject(new Error('Upload too large (max 25MB)')); req.destroy(); }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from(boundary);
        const parts = [];
        let start = buf.indexOf(boundaryBuf);
        while (start !== -1) {
          const next = buf.indexOf(boundaryBuf, start + boundaryBuf.length);
          if (next === -1) break;
          let segment = buf.slice(start + boundaryBuf.length, next);
          // strip leading CRLF and trailing CRLF/--
          if (segment.slice(0, 2).toString() === '\r\n') segment = segment.slice(2);
          if (segment.length >= 2 && segment.slice(-2).toString() === '\r\n') segment = segment.slice(0, -2);
          if (segment.length > 0) parts.push(segment);
          start = next;
        }
        const fields = {};
        let file = null;
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headerStr = part.slice(0, headerEnd).toString('utf8');
          const body = part.slice(headerEnd + 4);
          const nameMatch = /name="([^"]+)"/i.exec(headerStr);
          const filenameMatch = /filename="([^"]*)"/i.exec(headerStr);
          const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
          const fieldName = nameMatch ? nameMatch[1] : null;
          if (!fieldName) continue;
          if (filenameMatch && filenameMatch[1]) {
            file = { fieldName, filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: body };
          } else {
            fields[fieldName] = body.toString('utf8');
          }
        }
        resolve({ fields, file });
      } catch (e) { reject(e); }
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---- In-memory rate limiting (security hardening, pre-go-live) ----
// A plain sliding-window counter keyed by a string (caller decides what: IP for login
// attempts, "IP + route" for general API traffic). No npm dependency, no external store
// — intentionally simple, since this is a small single-shop app running one Node
// process, not a multi-instance deployment that would need a shared store like Redis.
// Entries are swept periodically so this never grows unbounded on a long-running server.
class RateLimiter {
  constructor(maxHits, windowMs) {
    this.maxHits = maxHits;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> array of timestamps
    this._sweepTimer = setInterval(() => this.sweep(), Math.max(windowMs, 60000));
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }
  // Records one hit for `key` and returns true if the caller is now OVER the limit
  // (i.e. should be rejected), false if still within it.
  hit(key) {
    const now = Date.now();
    let arr = this.hits.get(key);
    if (!arr) { arr = []; this.hits.set(key, arr); }
    while (arr.length && now - arr[0] > this.windowMs) arr.shift();
    arr.push(now);
    return arr.length > this.maxHits;
  }
  // Checks without recording — used to decide whether to even attempt an action
  // (e.g. "is this IP already locked out?") before doing the expensive part of it.
  isBlocked(key) {
    const now = Date.now();
    const arr = this.hits.get(key);
    if (!arr) return false;
    while (arr.length && now - arr[0] > this.windowMs) arr.shift();
    return arr.length > this.maxHits;
  }
  reset(key) { this.hits.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [key, arr] of this.hits) {
      while (arr.length && now - arr[0] > this.windowMs) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }
}

module.exports = {
  hashPassword, verifyPassword, needsRehash, parseCookies, readJsonBody, readMultipart,
  sendJson, randomToken, RateLimiter,
};
