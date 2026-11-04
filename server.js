// server.js — SK Jewellers management app.
// Plain Node.js http server, zero npm dependencies (uses only Node built-ins).
// Run with: node server.js   (see README.md for details)
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, computePackageDerived, computeTimeliness, computeGoldReceiptFineGrams, DATA_DIR } = require('./db.js');
const { createBackupZip, pruneOldBackups, scheduleWeeklyBackups } = require('./backup.js');
const {
  hashPassword, verifyPassword, needsRehash, parseCookies, readJsonBody, readMultipart,
  sendJson, randomToken, RateLimiter,
} = require('./helpers.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Same override pattern as DATA_DIR in db.js — set UPLOADS_DIR on hosts where the
// persistent disk mounts somewhere other than __dirname/uploads, so photos/documents
// actually land on persistent storage rather than being lost on every restart/redeploy.
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- security hardening (pre-go-live) ----------
// Sessions expire server-side after this long, independent of the cookie's own Max-Age —
// belt-and-suspenders in case a cookie is copied/replayed, and bounds how long a stolen
// token stays useful. Matches the cookie's own Max-Age (7 days) set at login below.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Render (and most hosts) terminate HTTPS at a reverse proxy and forward plain HTTP to
// this process, so req.socket.encrypted is never true there — the standard signal for
// "the original request was HTTPS" is the X-Forwarded-Proto header the proxy adds.
// Locally (node server.js on your own machine, no proxy) there's no such header, which
// correctly falls through to "not https" so the Secure cookie flag doesn't break local
// HTTP testing. Also respects a SECURE_COOKIES=1 escape hatch if a host ever needs it.
function isHttpsRequest(req) {
  if (process.env.SECURE_COOKIES === '0') return false;
  if (process.env.SECURE_COOKIES === '1') return true;
  if (req.socket && req.socket.encrypted) return true;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

// Best-effort real client IP, used only for rate-limiting keys (not for any security
// decision that assumes it can't be spoofed). Render and similar hosts set
// X-Forwarded-For; falls back to the raw socket address for local/direct runs.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Login attempts: 8 tries per 10 minutes per IP+email combo. Keyed on both (not just
// IP) so one shared office/shop IP can't lock out every account because one person
// mistyped their own password repeatedly — but a script guessing one specific account's
// password repeatedly still gets throttled.
const loginLimiter = new RateLimiter(8, 10 * 60 * 1000);
// General API traffic: a generous per-IP ceiling across all /api/* routes, meant to
// catch runaway scripts/bots rather than normal dashboard use (which fires a handful of
// calls per page load). 400 requests per 5 minutes comfortably covers a busy owner
// clicking around while still bounding abuse.
const apiLimiter = new RateLimiter(400, 5 * 60 * 1000);

// Standard hardening headers applied to every response — defends against clickjacking
// (framing this app inside another site), MIME-sniffing attacks, and leaking the full
// referrer URL (which could contain a session-bearing path) to third-party links.
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore this; explicitly off rather than relying on legacy behavior
}

// ---------- session helpers ----------
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.sid;
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  // Server-side expiry check, independent of the cookie's own Max-Age (see
  // SESSION_MAX_AGE_MS above). Expired sessions are deleted on first use after expiry
  // rather than left to accumulate.
  const createdAtMs = Date.parse(row.created_at.replace(' ', 'T') + 'Z');
  if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > SESSION_MAX_AGE_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT id,name,email,role,customer_id FROM users WHERE id = ?').get(row.user_id);
  return user || null;
}

function requireRole(user, roles) {
  return user && roles.includes(user.role);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
};

// Resolves urlPath against baseDir and confirms the result is actually still inside
// baseDir (not just string-prefixed with it — e.g. "/public" vs "/public-evil" would
// pass a naive startsWith() check). Returns null if the path tries to escape via "..".
function safeResolve(baseDir, urlPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, '.' + path.sep + urlPath.replace(/^\/+/, ''));
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return null;
  return resolved;
}

// File types that are safe to render inline in the browser with their real content
// type. Anything else uploaded (e.g. an uploaded .html/.svg/.js someone names to look
// like a photo) is forced to download instead of render, which prevents a classic
// stored-XSS trick: uploading an HTML/SVG file that contains a <script> tag and getting
// another logged-in user (the Owner) to open it inline on this app's own origin, where
// it could act with that user's session.
const INLINE_SAFE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);

// The demo login/password box on the public login page (public/index.html) has a
// placeholder comment, <!--DEMO_CREDENTIALS_BLOCK-->, where this gets substituted in.
// Deliberately done server-side rather than hiding the block with CSS: if the real
// credential text were always sent to the browser and merely display:none'd, anyone
// could still read it straight out of "View Page Source" or DevTools regardless of
// SHOW_DEMO_CREDENTIALS. This way, unless the env var is explicitly set to "1", the
// text never leaves the server at all.
const DEMO_CREDENTIALS_HTML = `<div class="demo-creds">
      <strong>Demo logins:</strong><br>
      Owner/Admin: <code>owner@skjewellers.com</code> / <code>owner123</code><br>
      Maker: <code>maker@skjewellers.com</code> / <code>maker123</code><br>
      Customer: <code>customer@skjewellers.com</code> / <code>customer123</code>
    </div>`;

function serveStatic(req, res, urlPath) {
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = safeResolve(PUBLIC_DIR, urlPath);
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    // Only the top-level login page gets this substitution — every other static file
    // (including the owner/maker/customer index.html pages, which have no such
    // placeholder) is served completely unmodified.
    if (filePath === path.join(PUBLIC_DIR, 'index.html')) {
      const replacement = process.env.SHOW_DEMO_CREDENTIALS === '1' ? DEMO_CREDENTIALS_HTML : '';
      const html = data.toString('utf8').replace('<!--DEMO_CREDENTIALS_BLOCK-->', replacement);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveUpload(req, res, user, filename) {
  if (!user) { res.writeHead(401); return res.end('Unauthorized'); }
  const filePath = safeResolve(UPLOADS_DIR, path.basename(filename));
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (!INLINE_SAFE_EXTS.has(ext)) headers['Content-Disposition'] = 'attachment';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- dashboard aggregation helpers ----------
function packageWithCustomer(p) {
  const cust = db.prepare('SELECT id,code,name,firm_name,city,state,phone_number FROM customers WHERE id = ?').get(p.customer_id);
  return { ...p, customer: cust, timeliness: computeTimeliness(p) };
}

function listPackages({ customerId, status, year, month, makerId, activeOnly, orderGroupCode }) {
  let sql = 'SELECT * FROM packages WHERE 1=1';
  const params = [];
  if (customerId) { sql += ' AND customer_id = ?'; params.push(customerId); }
  if (status) { sql += ' AND package_status = ?'; params.push(status); }
  if (makerId) { sql += ' AND assigned_maker_id = ?'; params.push(makerId); }
  if (orderGroupCode) { sql += ' AND order_group_code = ?'; params.push(orderGroupCode); }
  // Makers only ever see their currently-active jobs (not Delivered/Cancelled) — the
  // Owner can always see everything via the full Orders page regardless of this flag.
  if (activeOnly) { sql += ` AND package_status NOT IN ('DELIVERED','CANCELLED')`; }
  if (year) { sql += " AND strftime('%Y', credit_date) = ?"; params.push(String(year)); }
  if (month) { sql += " AND strftime('%m', credit_date) = ?"; params.push(String(month).padStart(2, '0')); }
  sql += ' ORDER BY credit_date DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map(packageWithCustomer);
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key);
  return row ? row.setting_value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (setting_key, setting_value) VALUES (?,?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value`).run(key, value);
}

// Use Case 3: whenever a package newly becomes DELIVERED (and has an assigned Maker),
// automatically log a gold commission entry for that Maker — e.g. "100g delivered at a
// 0.2% rate pays 200mg of gold." The rate is a single shop-wide setting (Admin >
// Settings), snapshotted onto the entry so later rate changes don't retroactively
// change historical commission amounts. Guards against double-logging by checking no
// entry already exists for this package (covers repeated PUTs while already Delivered,
// and re-delivering after a status was changed back).
function maybeLogMakerCommission(packageRow, wasAlreadyDelivered) {
  if (wasAlreadyDelivered) return; // only fires on the transition INTO Delivered
  if (packageRow.package_status !== 'DELIVERED') return;
  if (!packageRow.assigned_maker_id) return;
  const already = db.prepare('SELECT id FROM maker_commission_ledger WHERE package_id = ?').get(packageRow.id);
  if (already) return;
  const ratePercent = parseFloat(getSetting('MAKER_COMMISSION_RATE_PERCENT', '0.2'));
  const baseWeight = packageRow.weight_grams || 0;
  const commissionFineGoldGrams = +(baseWeight * ratePercent / 100).toFixed(4);
  db.prepare(`INSERT INTO maker_commission_ledger (maker_id, package_id, package_code, base_weight_grams, rate_percent_used, commission_fine_gold_grams)
    VALUES (?,?,?,?,?,?)`).run(packageRow.assigned_maker_id, packageRow.id, packageRow.package_code, baseWeight, ratePercent, commissionFineGoldGrams);
}

// Returns { customer_id/employee_id -> file_path } maps for the one attachment flagged
// as each entity's profile photo, so list views (Customers table, Employees cards) can
// show a thumbnail without an extra request per row.
function profilePhotoMapByCustomer() {
  const rows = db.prepare('SELECT customer_id, file_path FROM attachments WHERE is_profile_photo = 1 AND customer_id IS NOT NULL').all();
  const map = {};
  for (const r of rows) map[r.customer_id] = r.file_path;
  return map;
}
function profilePhotoMapByEmployee() {
  const rows = db.prepare('SELECT employee_id, file_path FROM attachments WHERE is_profile_photo = 1 AND employee_id IS NOT NULL').all();
  const map = {};
  for (const r of rows) map[r.employee_id] = r.file_path;
  return map;
}

// Returns, for every customer, the sum of all their gold receipts (fine gold grams) —
// gold brought in later to settle an old balance, with no new order attached (Use Case
// 1). Used to fold this into the customer's overall outstanding balance alongside the
// package-level net_balance_fine_gold_grams.
function goldReceiptTotalsByCustomer() {
  const rows = db.prepare('SELECT customer_id, SUM(fine_gold_grams) as total FROM gold_receipts GROUP BY customer_id').all();
  const map = {};
  for (const r of rows) map[r.customer_id] = r.total || 0;
  return map;
}

// ---- Live gold/silver price fetch (zero npm dependencies — uses Node's built-in https) ----
// Two free, no-API-key-required public endpoints are combined:
//  1. goldprice.org's own data feed (same one their website widget uses) for the USD
//     spot price of gold (XAU) and silver (XAG) per troy ounce.
//  2. open.er-api.com — a free, keyless exchange-rate API — to convert USD into whatever
//     currency the shop is configured for (e.g. INR).
// Both are plain HTTPS GET + JSON, no auth. If either is unreachable (no internet, API
// changed/down), fetchMetalPrices() throws and the /api/metal-prices route falls back to
// the last cached price in the metal_price_cache table — see that route for details.
const TROY_OUNCE_GRAMS = 31.1034768;
// goldprice.org's dbXRates endpoint is meant to be called by their own website widget
// running in a real browser, not a server-to-server script — it returns HTTP 403 to
// requests that don't look like a browser (checked by User-Agent / Referer / Origin).
// We send headers that match what their widget itself sends so our request is
// indistinguishable from a real page load of goldprice.org.
const BROWSER_LIKE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://goldprice.org/',
  Origin: 'https://goldprice.org',
};
function httpsGetJson(url, { timeoutMs = 6000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON from ' + url)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timed out contacting ' + url)); });
  });
}

async function fetchMetalPrices(currencyCode) {
  // Step 1: USD spot prices per troy ounce.
  const spot = await httpsGetJson('https://data-asg.goldprice.org/dbXRates/USD', { headers: BROWSER_LIKE_HEADERS });
  const item = spot && spot.items && spot.items[0];
  if (!item || typeof item.xauPrice !== 'number' || typeof item.xagPrice !== 'number') {
    throw new Error('Unexpected response shape from gold price feed');
  }
  const goldPerGramUsd = item.xauPrice / TROY_OUNCE_GRAMS;
  const silverPerGramUsd = item.xagPrice / TROY_OUNCE_GRAMS;

  // Step 2: convert to the shop's configured currency, if not already USD.
  let rate = 1;
  const currency = (currencyCode || 'USD').toUpperCase();
  if (currency !== 'USD') {
    const fx = await httpsGetJson('https://open.er-api.com/v6/latest/USD', { headers: { 'User-Agent': BROWSER_LIKE_HEADERS['User-Agent'], Accept: 'application/json' } });
    if (!fx || !fx.rates || typeof fx.rates[currency] !== 'number') {
      throw new Error(`No exchange rate available for currency "${currency}"`);
    }
    rate = fx.rates[currency];
  }
  return {
    goldPerGram: +(goldPerGramUsd * rate).toFixed(2),
    silverPerGram: +(silverPerGramUsd * rate).toFixed(2),
  };
}

// ========== MAIN REQUEST HANDLER ==========
const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(res);
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    const method = req.method;
    const ip = clientIp(req);

    // ---- uploads (file access) ----
    if (pathname.startsWith('/uploads/')) {
      const user = getSessionUser(req);
      return serveUpload(req, res, user, pathname.replace('/uploads/', ''));
    }

    // ---- health check (used by Render and similar hosts to confirm the app is up;
    // deliberately before rate-limiting/auth so monitoring traffic never gets throttled
    // or counted as a real visitor, and never requires a login) ----
    if (pathname === '/healthz' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    // ---- non-API = static assets ----
    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    // ================= API ROUTES =================
    // General-purpose per-IP ceiling across all API traffic, to blunt runaway scripts/
    // bots rather than normal clicking-around use — see RateLimiter in helpers.js.
    if (apiLimiter.hit(ip)) {
      return sendJson(res, 429, { error: 'Too many requests — please slow down and try again shortly.' });
    }
    const user = getSessionUser(req);

    // ---- AUTH ----
    if (pathname === '/api/login' && method === 'POST') {
      // Lock out repeated failed attempts against this IP+email combo before even
      // touching the database — see loginLimiter comment above for why it's keyed on
      // both rather than just IP.
      const body = await readJsonBody(req);
      const emailInput = (body.email || '').trim().toLowerCase();
      const limiterKey = `${ip}:${emailInput}`;
      if (loginLimiter.isBlocked(limiterKey)) {
        return sendJson(res, 429, { error: 'Too many failed login attempts. Please wait a few minutes and try again.' });
      }
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(emailInput);
      if (!row || !verifyPassword(body.password || '', row.password)) {
        loginLimiter.hit(limiterKey);
        return sendJson(res, 401, { error: 'Invalid email or password' });
      }
      loginLimiter.reset(limiterKey); // successful login clears any prior failed-attempt count
      // Transparently upgrade legacy plain-text/sha256 stored passwords to scrypt the
      // first time their owner successfully logs in after this hardening pass — no
      // forced reset, no action needed from the user.
      if (needsRehash(row.password)) {
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(body.password), row.id);
      }
      const token = randomToken();
      db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, row.id);
      const secureFlag = isHttpsRequest(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Lax${secureFlag}`);
      return sendJson(res, 200, { id: row.id, name: row.name, email: row.email, role: row.role, customer_id: row.customer_id });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.sid);
      const secureFlag = isHttpsRequest(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && method === 'GET') {
      if (!user) return sendJson(res, 401, { error: 'Not logged in' });
      return sendJson(res, 200, user);
    }

    // All routes below require auth
    if (!user) return sendJson(res, 401, { error: 'Not logged in' });

    // ---- CUSTOMERS ----
    if (pathname === '/api/customers' && method === 'GET') {
      const photoMap = profilePhotoMapByCustomer();
      if (user.role === 'CUSTOMER') {
        const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(user.customer_id);
        if (row) row.profile_photo_path = photoMap[row.id] || null;
        return sendJson(res, 200, row ? [row] : []);
      }
      const rows = db.prepare('SELECT * FROM customers ORDER BY code').all();
      for (const r of rows) r.profile_photo_path = photoMap[r.id] || null;
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/customers' && method === 'POST') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (!b.code || !b.name) return sendJson(res, 400, { error: 'code and name are required' });
      try {
        const info = db.prepare('INSERT INTO customers (code,name,firm_name,city,state,gst_number,phone_number,notes) VALUES (?,?,?,?,?,?,?,?)')
          .run(b.code, b.name, b.firm_name || null, b.city || null, b.state || null, b.gst_number || null, b.phone_number || null, b.notes || null);
        return sendJson(res, 201, db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid)));
      } catch (e) { return sendJson(res, 400, { error: 'Customer code must be unique' }); }
    }

    const custMatch = pathname.match(/^\/api\/customers\/(\d+)$/);
    if (custMatch && (method === 'PUT' || method === 'DELETE')) {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const id = Number(custMatch[1]);
      if (method === 'DELETE') {
        db.prepare('DELETE FROM customers WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
      }
      const b = await readJsonBody(req);
      db.prepare(`UPDATE customers SET code=?,name=?,firm_name=?,city=?,state=?,gst_number=?,phone_number=?,notes=? WHERE id=?`)
        .run(b.code, b.name, b.firm_name || null, b.city || null, b.state || null, b.gst_number || null, b.phone_number || null, b.notes || null, id);
      const updatedCust = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      updatedCust.profile_photo_path = profilePhotoMapByCustomer()[id] || null;
      return sendJson(res, 200, updatedCust);
    }

    // ---- GOLD RECEIPTS (Use Case 1: customer brings gold later to settle an old
    // balance, with no new order attached — e.g. delivered a 100g order, some gold was
    // still owed, and days later the customer drops off fine or bread gold against
    // that balance). Recorded at the customer level, not tied to any one package, so
    // it correctly reduces the customer's overall outstanding balance regardless of
    // which past order(s) it's actually settling. ----
    if (pathname === '/api/gold-receipts' && method === 'GET') {
      const customerId = user.role === 'CUSTOMER' ? user.customer_id : u.searchParams.get('customerId');
      let sql = `SELECT gr.*, c.code as customer_code, c.name as customer_name, usr.name as recorded_by_name
        FROM gold_receipts gr JOIN customers c ON c.id = gr.customer_id
        LEFT JOIN users usr ON usr.id = gr.recorded_by WHERE 1=1`;
      const params = [];
      if (customerId) { sql += ' AND gr.customer_id = ?'; params.push(customerId); }
      sql += ' ORDER BY gr.receipt_date DESC, gr.id DESC';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    if (pathname === '/api/gold-receipts' && method === 'POST') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (!b.customer_id || !b.receipt_date || !b.weight_grams || !b.karat) {
        return sendJson(res, 400, { error: 'customer_id, receipt_date, weight_grams and karat are required' });
      }
      const fineGoldGrams = computeGoldReceiptFineGrams(b.weight_grams, b.karat);
      const info = db.prepare(`INSERT INTO gold_receipts
        (customer_id, receipt_date, weight_grams, karat, fine_weight_credit_type, fine_gold_grams, note, recorded_by)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(b.customer_id, b.receipt_date, b.weight_grams, b.karat, b.fine_weight_credit_type === 'BREAD' ? 'BREAD' : 'FINE',
          fineGoldGrams, b.note || null, user.id);
      return sendJson(res, 201, db.prepare('SELECT * FROM gold_receipts WHERE id=?').get(Number(info.lastInsertRowid)));
    }

    const goldReceiptMatch = pathname.match(/^\/api\/gold-receipts\/(\d+)$/);
    if (goldReceiptMatch && (method === 'PUT' || method === 'DELETE')) {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const id = Number(goldReceiptMatch[1]);
      if (method === 'DELETE') {
        db.prepare('DELETE FROM gold_receipts WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
      }
      const existing = db.prepare('SELECT * FROM gold_receipts WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'Not found' });
      const b = await readJsonBody(req);
      const merged = { ...existing, ...b };
      const fineGoldGrams = computeGoldReceiptFineGrams(merged.weight_grams, merged.karat);
      db.prepare(`UPDATE gold_receipts SET receipt_date=?, weight_grams=?, karat=?, fine_weight_credit_type=?, fine_gold_grams=?, note=? WHERE id=?`)
        .run(merged.receipt_date, merged.weight_grams, merged.karat, merged.fine_weight_credit_type === 'BREAD' ? 'BREAD' : 'FINE',
          fineGoldGrams, merged.note || null, id);
      return sendJson(res, 200, db.prepare('SELECT * FROM gold_receipts WHERE id=?').get(id));
    }

    // ---- USERS (admin management, incl. employee profile fields) ----
    const USER_PUBLIC_COLS = `id,name,email,role,customer_id,created_at,phone_number,date_of_birth,address,
      blood_group,bank_account_number,bank_name,bank_ifsc`;

    if (pathname === '/api/users' && method === 'GET') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const rows = db.prepare(`SELECT ${USER_PUBLIC_COLS} FROM users ORDER BY role,name`).all();
      const photoMap = profilePhotoMapByEmployee();
      for (const r of rows) r.profile_photo_path = photoMap[r.id] || null;
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/users' && method === 'POST') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (!b.name || !b.email || !b.password || !b.role) return sendJson(res, 400, { error: 'name, email, password, role are required' });
      if (!isValidEmail(b.email)) return sendJson(res, 400, { error: 'Please enter a valid email address' });
      if (String(b.password).length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
      try {
        const info = db.prepare(`INSERT INTO users
          (name,email,password,role,customer_id,phone_number,date_of_birth,address,blood_group,
           bank_account_number,bank_name,bank_ifsc)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(b.name, b.email.trim().toLowerCase(), hashPassword(b.password), b.role, b.customer_id || null,
            b.phone_number || null, b.date_of_birth || null, b.address || null, b.blood_group || null,
            b.bank_account_number || null, b.bank_name || null, b.bank_ifsc || null);
        return sendJson(res, 201, db.prepare(`SELECT ${USER_PUBLIC_COLS} FROM users WHERE id=?`).get(Number(info.lastInsertRowid)));
      } catch (e) { return sendJson(res, 400, { error: 'Email already in use' }); }
    }

    const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && (method === 'PUT' || method === 'DELETE')) {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const id = Number(userMatch[1]);
      if (method === 'DELETE') {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return sendJson(res, 200, { ok: true });
      }
      const b = await readJsonBody(req);
      const existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!existingUser) return sendJson(res, 404, { error: 'User not found' });
      if (b.email !== undefined && !isValidEmail(b.email)) return sendJson(res, 400, { error: 'Please enter a valid email address' });
      if (b.password && String(b.password).length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
      // Supports partial updates: any field omitted from the request body keeps its
      // current value, so the Admin UI can PUT just e.g. { blood_group: 'AB-' } without
      // needing to resend the whole user record.
      const name = b.name !== undefined ? b.name : existingUser.name;
      const email = b.email !== undefined ? String(b.email).trim().toLowerCase() : existingUser.email;
      const role = b.role !== undefined ? b.role : existingUser.role;
      const customerId = b.customer_id !== undefined ? (b.customer_id || null) : existingUser.customer_id;
      const profileFields = [
        b.phone_number !== undefined ? (b.phone_number || null) : existingUser.phone_number,
        b.date_of_birth !== undefined ? (b.date_of_birth || null) : existingUser.date_of_birth,
        b.address !== undefined ? (b.address || null) : existingUser.address,
        b.blood_group !== undefined ? (b.blood_group || null) : existingUser.blood_group,
        b.bank_account_number !== undefined ? (b.bank_account_number || null) : existingUser.bank_account_number,
        b.bank_name !== undefined ? (b.bank_name || null) : existingUser.bank_name,
        b.bank_ifsc !== undefined ? (b.bank_ifsc || null) : existingUser.bank_ifsc,
      ];
      try {
        if (b.password) {
          db.prepare(`UPDATE users SET name=?,email=?,role=?,customer_id=?,password=?,
            phone_number=?,date_of_birth=?,address=?,blood_group=?,bank_account_number=?,bank_name=?,bank_ifsc=?
            WHERE id=?`)
            .run(name, email, role, customerId, hashPassword(b.password), ...profileFields, id);
          // Changing a user's password invalidates any sessions issued under the old
          // one — otherwise a previously-stolen session cookie would stay valid even
          // after the owner "fixes" the account by resetting its password.
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        } else {
          db.prepare(`UPDATE users SET name=?,email=?,role=?,customer_id=?,
            phone_number=?,date_of_birth=?,address=?,blood_group=?,bank_account_number=?,bank_name=?,bank_ifsc=?
            WHERE id=?`)
            .run(name, email, role, customerId, ...profileFields, id);
        }
      } catch (e) { return sendJson(res, 400, { error: 'Email already in use' }); }
      return sendJson(res, 200, db.prepare(`SELECT ${USER_PUBLIC_COLS} FROM users WHERE id=?`).get(id));
    }

    // ---- PACKAGES ----
    if (pathname === '/api/packages' && method === 'GET') {
      const filters = { customerId: u.searchParams.get('customerId'), status: u.searchParams.get('status'),
        year: u.searchParams.get('year'), month: u.searchParams.get('month'),
        orderGroupCode: u.searchParams.get('orderGroupCode') };
      if (user.role === 'CUSTOMER') filters.customerId = user.customer_id;
      if (user.role === 'MAKER' && u.searchParams.get('mine') === '1') {
        filters.makerId = user.id;
        filters.activeOnly = true; // Makers only ever see their currently-active jobs
      }
      return sendJson(res, 200, listPackages(filters));
    }

    // Lists distinct order-group codes already used for a customer, most recent first
    // — lets the Owner's "New Package" form suggest reusing the current group code
    // when adding another ring to the same multi-ring order (Use Case 2).
    if (pathname === '/api/order-groups' && method === 'GET') {
      const customerId = u.searchParams.get('customerId');
      if (!customerId) return sendJson(res, 200, []);
      const rows = db.prepare(`
        SELECT order_group_code, COUNT(*) as package_count, SUM(weight_grams) as total_weight, MAX(created_at) as last_used
        FROM packages WHERE customer_id = ? AND order_group_code IS NOT NULL AND order_group_code != ''
        GROUP BY order_group_code ORDER BY last_used DESC`).all(customerId);
      return sendJson(res, 200, rows);
    }

    if (pathname === '/api/packages' && method === 'POST') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (!b.customer_id || !b.package_code) return sendJson(res, 400, { error: 'customer_id and package_code are required' });
      if (!b.estimated_completion_date) return sendJson(res, 400, { error: 'Estimated completion date is required for every order' });
      // If the order is somehow being created already-delivered and it's already past the estimate, require a reason up front.
      if (b.package_status === 'DELIVERED' && b.delivery_date && b.delivery_date > b.estimated_completion_date && !b.late_reason) {
        return sendJson(res, 400, { error: 'This order was delivered after its estimated date — please provide a reason for the delay (late_reason).' });
      }
      if (b.package_status === 'DELIVERED' && !b.received_by_name) {
        return sendJson(res, 400, { error: 'Please record who received the order (received_by_name) before marking it Delivered.' });
      }
      const derived = computePackageDerived(b);
      try {
        const info = db.prepare(`INSERT INTO packages
          (customer_id, package_code, weight_grams, karat, fine_gold_grams, making_karat, making_charge_fine_gold_grams,
           net_fine_gold_grams, credit_date, ledger_status, credit_weight_grams, fine_weight_credit_type,
           credit_fine_gold_grams, net_balance_fine_gold_grams, delivery_date, estimated_completion_date, late_reason,
           received_by_name, package_status, huid_number, remarks, assigned_maker_id, order_group_code)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          b.customer_id, b.package_code, b.weight_grams || null, b.karat || null, derived.fine_gold_grams,
          b.making_karat || null, b.making_charge_fine_gold_grams || null, derived.net_fine_gold_grams,
          b.credit_date || null, b.ledger_status || null, b.credit_weight_grams || null, b.fine_weight_credit_type || null,
          b.credit_fine_gold_grams || null, derived.net_balance_fine_gold_grams, b.delivery_date || null,
          b.estimated_completion_date, b.late_reason || null, b.received_by_name || null,
          b.package_status || 'IN_PROGRESS', b.huid_number || null, b.remarks || null, b.assigned_maker_id || null,
          b.order_group_code || null
        );
        const created = db.prepare('SELECT * FROM packages WHERE id=?').get(Number(info.lastInsertRowid));
        maybeLogMakerCommission(created, false);
        return sendJson(res, 201, packageWithCustomer(created));
      } catch (e) { return sendJson(res, 400, { error: 'Package code must be unique: ' + e.message }); }
    }

    const pkgMatch = pathname.match(/^\/api\/packages\/(\d+)$/);
    if (pkgMatch && method === 'GET') {
      const id = Number(pkgMatch[1]);
      const row = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      if (!row) return sendJson(res, 404, { error: 'Not found' });
      if (user.role === 'CUSTOMER' && row.customer_id !== user.customer_id) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, packageWithCustomer(row));
    }

    if (pkgMatch && method === 'PUT') {
      const id = Number(pkgMatch[1]);
      const existing = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'Not found' });
      const b = await readJsonBody(req);

      // Shared "is this delivery late?" check: triggers when status is becoming DELIVERED
      // (or already is) after the estimated completion date, and no reason has been given yet.
      function needsLateReason(effectiveStatus, effectiveDeliveryDate, effectiveEstimate, effectiveLateReason) {
        if (effectiveStatus !== 'DELIVERED' || !effectiveEstimate) return false;
        const deliveryDate = effectiveDeliveryDate || new Date().toISOString().slice(0, 10);
        return deliveryDate > effectiveEstimate && !effectiveLateReason;
      }

      // Whenever an order is being marked (or already is) Delivered, someone's name is
      // required as who physically received/collected it — required for both roles.
      function needsReceiverName(effectiveStatus, effectiveReceivedBy) {
        return effectiveStatus === 'DELIVERED' && !effectiveReceivedBy;
      }

      const wasAlreadyDelivered = existing.package_status === 'DELIVERED';

      if (user.role === 'OWNER') {
        const merged = { ...existing, ...b };
        if (!merged.estimated_completion_date) {
          return sendJson(res, 400, { error: 'Estimated completion date is required for every order' });
        }
        if (needsLateReason(merged.package_status, merged.delivery_date, merged.estimated_completion_date, merged.late_reason)) {
          return sendJson(res, 400, { error: 'This order is being marked Delivered after its estimated date — please provide a reason for the delay (late_reason).' });
        }
        if (needsReceiverName(merged.package_status, merged.received_by_name)) {
          return sendJson(res, 400, { error: 'Please record who received the order (received_by_name) before marking it Delivered.' });
        }
        const derived = computePackageDerived(merged);
        db.prepare(`UPDATE packages SET customer_id=?,package_code=?,weight_grams=?,karat=?,fine_gold_grams=?,
          making_karat=?,making_charge_fine_gold_grams=?,net_fine_gold_grams=?,credit_date=?,ledger_status=?,
          credit_weight_grams=?,fine_weight_credit_type=?,credit_fine_gold_grams=?,net_balance_fine_gold_grams=?,
          delivery_date=?,estimated_completion_date=?,late_reason=?,received_by_name=?,package_status=?,huid_number=?,remarks=?,
          assigned_maker_id=?,order_group_code=?,updated_at=datetime('now') WHERE id=?`)
          .run(merged.customer_id, merged.package_code, merged.weight_grams, merged.karat, derived.fine_gold_grams,
            merged.making_karat, merged.making_charge_fine_gold_grams, derived.net_fine_gold_grams, merged.credit_date,
            merged.ledger_status, merged.credit_weight_grams, merged.fine_weight_credit_type, merged.credit_fine_gold_grams,
            derived.net_balance_fine_gold_grams, merged.delivery_date, merged.estimated_completion_date, merged.late_reason,
            merged.received_by_name, merged.package_status, merged.huid_number, merged.remarks, merged.assigned_maker_id,
            merged.order_group_code, id);
      } else if (user.role === 'MAKER') {
        // Makers may only update status, delivery date, received-by name, remarks and
        // late_reason (the latter two only as needed to complete the Delivered flow) —
        // on jobs currently assigned to them. No other order field is editable by them.
        if (existing.assigned_maker_id !== user.id) return sendJson(res, 403, { error: 'Not your assigned job' });
        const status = b.package_status || existing.package_status;
        const remarks = b.remarks !== undefined ? b.remarks : existing.remarks;
        const lateReason = b.late_reason !== undefined ? b.late_reason : existing.late_reason;
        const receivedByName = b.received_by_name !== undefined ? b.received_by_name : existing.received_by_name;
        const deliveryDate = b.delivery_date !== undefined ? b.delivery_date
          : (status === 'DELIVERED' && existing.package_status !== 'DELIVERED' ? new Date().toISOString().slice(0, 10) : existing.delivery_date);
        if (needsLateReason(status, deliveryDate, existing.estimated_completion_date, lateReason)) {
          return sendJson(res, 400, { error: 'This order is being marked Delivered after its estimated date — please provide a reason for the delay (late_reason).' });
        }
        if (needsReceiverName(status, receivedByName)) {
          return sendJson(res, 400, { error: 'Please record who received the order (received_by_name) before marking it Delivered.' });
        }
        db.prepare(`UPDATE packages SET package_status=?, remarks=?, late_reason=?, received_by_name=?, delivery_date=?, updated_at=datetime('now') WHERE id=?`)
          .run(status, remarks, lateReason, receivedByName, deliveryDate, id);
      } else {
        return sendJson(res, 403, { error: 'Forbidden' });
      }
      const updatedPkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      maybeLogMakerCommission(updatedPkg, wasAlreadyDelivered);
      return sendJson(res, 200, packageWithCustomer(updatedPkg));
    }

    if (pkgMatch && method === 'DELETE') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      db.prepare('DELETE FROM packages WHERE id=?').run(Number(pkgMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // ---- PRODUCTION UPDATES ----
    const updMatch = pathname.match(/^\/api\/packages\/(\d+)\/updates$/);
    if (updMatch && method === 'GET') {
      const pkgId = Number(updMatch[1]);
      const rows = db.prepare(`SELECT pu.*, u.name as updated_by_name FROM production_updates pu
        LEFT JOIN users u ON u.id = pu.updated_by WHERE pu.package_id = ? ORDER BY pu.created_at DESC`).all(pkgId);
      return sendJson(res, 200, rows);
    }
    if (updMatch && method === 'POST') {
      if (!requireRole(user, ['OWNER', 'MAKER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const pkgId = Number(updMatch[1]);
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(pkgId);
      if (!pkg) return sendJson(res, 404, { error: 'Not found' });
      if (user.role === 'MAKER' && pkg.assigned_maker_id !== user.id) return sendJson(res, 403, { error: 'Not your assigned job' });
      const b = await readJsonBody(req);
      if (!b.note) return sendJson(res, 400, { error: 'note is required' });
      const info = db.prepare('INSERT INTO production_updates (package_id, note, status_at_time, updated_by) VALUES (?,?,?,?)')
        .run(pkgId, b.note, pkg.package_status, user.id);
      return sendJson(res, 201, db.prepare('SELECT * FROM production_updates WHERE id=?').get(Number(info.lastInsertRowid)));
    }

    // ---- ATTACHMENTS (customer docs, order photos, AND employee profile photos/ID proof) ----
    if (pathname === '/api/attachments' && method === 'GET') {
      const customerId = u.searchParams.get('customerId');
      const packageId = u.searchParams.get('packageId');
      const employeeId = u.searchParams.get('employeeId');
      if (employeeId && !requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      let sql = 'SELECT a.*, usr.name as uploaded_by_name FROM attachments a LEFT JOIN users usr ON usr.id=a.uploaded_by WHERE 1=1';
      const params = [];
      if (customerId) { sql += ' AND a.customer_id = ?'; params.push(customerId); }
      if (packageId) { sql += ' AND a.package_id = ?'; params.push(packageId); }
      if (employeeId) { sql += ' AND a.employee_id = ?'; params.push(employeeId); }
      sql += ' ORDER BY a.created_at DESC';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    if (pathname === '/api/attachments' && method === 'POST') {
      if (!requireRole(user, ['OWNER', 'MAKER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const contentType = req.headers['content-type'] || '';
      if (!contentType.startsWith('multipart/form-data')) return sendJson(res, 400, { error: 'Expected multipart/form-data' });
      const { fields, file } = await readMultipart(req, contentType);
      if (!file) return sendJson(res, 400, { error: 'No file uploaded' });
      if (fields.employee_id && !requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Only the owner can manage employee documents' });
      const isProfilePhoto = fields.is_profile_photo === '1' || fields.is_profile_photo === 'true';
      if (isProfilePhoto && !requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Only the owner can set a profile photo' });
      // Only allow file types this app actually needs to handle (photos + a few common
      // document formats for ID proof/receipts) — rejects anything else (e.g. .html,
      // .svg, .js, .exe) before it's ever written to disk. Combined with the
      // Content-Disposition:attachment forcing in serveUpload() above, this closes off
      // the "upload a disguised script, then get someone to open it inline" attack path.
      const ALLOWED_UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx']);
      const ext = (path.extname(file.filename) || '').toLowerCase();
      if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
        return sendJson(res, 400, { error: 'Unsupported file type. Allowed: photos (jpg/png/gif/webp), PDF, Word, or Excel files.' });
      }
      if (file.data.length > 15 * 1024 * 1024) {
        return sendJson(res, 400, { error: 'File is too large (max 15MB).' });
      }
      const safeName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, safeName), file.data);
      // Only one photo can be "the" profile photo per customer/employee — clear any
      // previous flag on that same entity before setting the new one.
      if (isProfilePhoto) {
        if (fields.customer_id) db.prepare('UPDATE attachments SET is_profile_photo = 0 WHERE customer_id = ?').run(fields.customer_id);
        if (fields.employee_id) db.prepare('UPDATE attachments SET is_profile_photo = 0 WHERE employee_id = ?').run(fields.employee_id);
      }
      const info = db.prepare(`INSERT INTO attachments (customer_id, package_id, employee_id, file_path, original_name, type, note, is_profile_photo, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        fields.customer_id || null, fields.package_id || null, fields.employee_id || null, safeName, file.filename,
        fields.type === 'DOCUMENT' ? 'DOCUMENT' : 'PHOTO', fields.note || null, isProfilePhoto ? 1 : 0, user.id
      );
      return sendJson(res, 201, db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(info.lastInsertRowid)));
    }

    const attMatch = pathname.match(/^\/api\/attachments\/(\d+)$/);
    if (attMatch && method === 'DELETE') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(attMatch[1]));
      if (row) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, row.file_path)); } catch (e) { /* ignore */ }
        db.prepare('DELETE FROM attachments WHERE id=?').run(row.id);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ---- ATTENDANCE ----
    if (pathname === '/api/attendance' && method === 'GET') {
      const makerId = u.searchParams.get('makerId') || (user.role === 'MAKER' ? user.id : null);
      let sql = 'SELECT al.*, u.name as maker_name FROM attendance_logs al JOIN users u ON u.id=al.maker_id WHERE 1=1';
      const params = [];
      if (makerId) { sql += ' AND al.maker_id = ?'; params.push(makerId); }
      sql += ' ORDER BY al.date DESC';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    if (pathname === '/api/attendance' && method === 'POST') {
      if (!requireRole(user, ['OWNER', 'MAKER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      const makerId = user.role === 'MAKER' ? user.id : b.maker_id;
      if (!makerId || !b.date) return sendJson(res, 400, { error: 'maker_id and date are required' });
      db.prepare(`INSERT INTO attendance_logs (maker_id, date, present, note) VALUES (?,?,?,?)
        ON CONFLICT(maker_id, date) DO UPDATE SET present=excluded.present, note=excluded.note`)
        .run(makerId, b.date, b.present === false ? 0 : 1, b.note || null);
      return sendJson(res, 201, { ok: true });
    }

    // ---- CONFIG LISTS (dynamic admin-managed dropdowns) ----
    if (pathname === '/api/config-lists' && method === 'GET') {
      const key = u.searchParams.get('key');
      let sql = 'SELECT * FROM config_lists WHERE 1=1';
      const params = [];
      if (key) { sql += ' AND list_key = ?'; params.push(key); }
      sql += ' ORDER BY list_key, sort_order';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    if (pathname === '/api/config-lists' && method === 'POST') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (!b.list_key || !b.value) return sendJson(res, 400, { error: 'list_key and value are required' });
      try {
        const info = db.prepare('INSERT INTO config_lists (list_key, value, sort_order) VALUES (?,?,?)')
          .run(b.list_key, b.value, b.sort_order || 99);
        return sendJson(res, 201, db.prepare('SELECT * FROM config_lists WHERE id=?').get(Number(info.lastInsertRowid)));
      } catch (e) { return sendJson(res, 400, { error: 'That value already exists in this list' }); }
    }

    const cfgMatch = pathname.match(/^\/api\/config-lists\/(\d+)$/);
    if (cfgMatch && method === 'DELETE') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      db.prepare('DELETE FROM config_lists WHERE id=?').run(Number(cfgMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // ---- DASHBOARD AGGREGATIONS ----
    if (pathname === '/api/dashboard/overview' && method === 'GET') {
      const totalPackages = db.prepare('SELECT COUNT(*) c FROM packages').get().c;
      const byStatus = db.prepare('SELECT package_status, COUNT(*) c FROM packages GROUP BY package_status').all();
      const totalNetFineGold = db.prepare('SELECT SUM(net_fine_gold_grams) s FROM packages').get().s || 0;
      const packageBalance = db.prepare('SELECT SUM(net_balance_fine_gold_grams) s FROM packages').get().s || 0;
      // Gold receipts (Use Case 1: gold brought back later with no new order) act as
      // extra credit against the customer's balance, the same way a package's own
      // credit_fine_gold_grams reduces that package's balance.
      const totalGoldReceipts = db.prepare('SELECT SUM(fine_gold_grams) s FROM gold_receipts').get().s || 0;
      const totalOutstandingBalance = packageBalance - totalGoldReceipts;
      const totalCustomers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
      const pendingDeliveries = db.prepare(`SELECT COUNT(*) c FROM packages WHERE package_status IN ('IN_PROGRESS','ON_HOLD')`).get().c;
      return sendJson(res, 200, { totalPackages, byStatus, totalNetFineGold, totalOutstandingBalance, totalCustomers, pendingDeliveries });
    }

    if (pathname === '/api/dashboard/customers' && method === 'GET') {
      const rows = db.prepare(`
        SELECT c.id, c.code, c.name, c.firm_name, c.city, c.state,
          COUNT(p.id) as package_count,
          SUM(p.net_fine_gold_grams) as total_net_fine_gold,
          SUM(p.net_balance_fine_gold_grams) as total_balance
        FROM customers c LEFT JOIN packages p ON p.customer_id = c.id
        GROUP BY c.id ORDER BY c.code`).all();
      const receiptTotals = goldReceiptTotalsByCustomer();
      for (const r of rows) {
        r.total_gold_receipts = receiptTotals[r.id] || 0;
        r.total_balance = (r.total_balance || 0) - r.total_gold_receipts;
      }
      return sendJson(res, 200, rows);
    }

    // ---- DASHBOARD: due-date / on-time performance + monthly trend (for charts) ----
    if (pathname === '/api/dashboard/timeliness' && method === 'GET') {
      const all = db.prepare('SELECT * FROM packages').all();
      const tally = { ON_TIME: 0, LATE: 0, OVERDUE: 0, ON_TRACK: 0, NOT_APPLICABLE: 0 };
      const overdueList = [];
      for (const p of all) {
        const t = computeTimeliness(p);
        tally[t] = (tally[t] || 0) + 1;
        if (t === 'OVERDUE') overdueList.push(packageWithCustomer(p));
      }
      const onTimeRateBase = tally.ON_TIME + tally.LATE;
      const onTimeRate = onTimeRateBase > 0 ? +(tally.ON_TIME / onTimeRateBase * 100).toFixed(1) : null;
      // Monthly order volume trend (by credit_date month), last 12 months present in data
      const monthly = db.prepare(`
        SELECT strftime('%Y-%m', credit_date) as ym, COUNT(*) c
        FROM packages WHERE credit_date IS NOT NULL
        GROUP BY ym ORDER BY ym`).all();
      return sendJson(res, 200, { tally, onTimeRate, overdueList, monthly });
    }

    // ---- DASHBOARD: recent activity feed (production notes + newly created/updated orders) ----
    // Kept intentionally lightweight — two small indexed queries, no joins beyond what's
    // needed for a human-readable label — so it doesn't add noticeable load time to the
    // dashboard even as the business accumulates years of history.
    if (pathname === '/api/dashboard/activity' && method === 'GET') {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 10, 30);
      const recentUpdates = db.prepare(`
        SELECT pu.id, pu.note, pu.status_at_time, pu.created_at, p.package_code, usr.name as updated_by_name
        FROM production_updates pu
        JOIN packages p ON p.id = pu.package_id
        LEFT JOIN users usr ON usr.id = pu.updated_by
        ORDER BY pu.created_at DESC LIMIT ?`).all(limit);
      const recentOrders = db.prepare(`
        SELECT p.id, p.package_code, p.package_status, p.created_at, p.updated_at, c.name as customer_name
        FROM packages p JOIN customers c ON c.id = p.customer_id
        ORDER BY p.updated_at DESC LIMIT ?`).all(limit);
      return sendJson(res, 200, { recentUpdates, recentOrders });
    }

    // ---- APP SETTINGS (shop-wide config, e.g. which country/currency for metal prices) ----
    if (pathname === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, {
        metal_price_country: getSetting('METAL_PRICE_COUNTRY', 'IN'),
        metal_price_currency: getSetting('METAL_PRICE_CURRENCY', 'INR'),
        maker_commission_rate_percent: getSetting('MAKER_COMMISSION_RATE_PERCENT', '0.2'),
      });
    }
    if (pathname === '/api/settings' && method === 'PUT') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const b = await readJsonBody(req);
      if (b.metal_price_country) setSetting('METAL_PRICE_COUNTRY', b.metal_price_country);
      if (b.metal_price_currency) setSetting('METAL_PRICE_CURRENCY', b.metal_price_currency);
      if (b.maker_commission_rate_percent !== undefined && b.maker_commission_rate_percent !== null && b.maker_commission_rate_percent !== '') {
        setSetting('MAKER_COMMISSION_RATE_PERCENT', String(b.maker_commission_rate_percent));
      }
      return sendJson(res, 200, {
        metal_price_country: getSetting('METAL_PRICE_COUNTRY', 'IN'),
        metal_price_currency: getSetting('METAL_PRICE_CURRENCY', 'INR'),
        maker_commission_rate_percent: getSetting('MAKER_COMMISSION_RATE_PERCENT', '0.2'),
      });
    }

    // ---- MAKER COMMISSION LEDGER (Use Case 3) ----
    if (pathname === '/api/maker-commissions' && method === 'GET') {
      const makerId = user.role === 'MAKER' ? user.id : u.searchParams.get('makerId');
      if (user.role === 'CUSTOMER') return sendJson(res, 403, { error: 'Forbidden' });
      let sql = `SELECT mcl.*, u.name as maker_name FROM maker_commission_ledger mcl
        LEFT JOIN users u ON u.id = mcl.maker_id WHERE 1=1`;
      const params = [];
      if (makerId) { sql += ' AND mcl.maker_id = ?'; params.push(makerId); }
      sql += ' ORDER BY mcl.created_at DESC';
      return sendJson(res, 200, db.prepare(sql).all(...params));
    }

    const commissionMatch = pathname.match(/^\/api\/maker-commissions\/(\d+)$/);
    if (commissionMatch && method === 'PUT') {
      // Only lets the Owner mark an entry paid/unpaid — the gold-gram amount itself is
      // never editable by hand, since it's a computed, auditable value tied to a
      // specific delivered package.
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      const id = Number(commissionMatch[1]);
      const b = await readJsonBody(req);
      db.prepare(`UPDATE maker_commission_ledger SET paid=?, paid_at=? WHERE id=?`)
        .run(b.paid ? 1 : 0, b.paid ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, id);
      return sendJson(res, 200, db.prepare('SELECT * FROM maker_commission_ledger WHERE id=?').get(id));
    }

    // ---- LIVE GOLD/SILVER PRICE (international spot, converted to shop's configured currency) ----
    if (pathname === '/api/metal-prices' && method === 'GET') {
      const currency = getSetting('METAL_PRICE_CURRENCY', 'INR');
      try {
        const live = await fetchMetalPrices(currency);
        db.prepare('INSERT INTO metal_price_cache (currency_code, gold_price_per_gram, silver_price_per_gram) VALUES (?,?,?)')
          .run(currency, live.goldPerGram, live.silverPerGram);
        return sendJson(res, 200, { ...live, currency, source: 'live', fetchedAt: new Date().toISOString() });
      } catch (e) {
        // Live fetch failed (no internet, API down, API changed) — fall back to the
        // last successfully cached price for this currency so the dashboard still
        // shows something useful rather than breaking.
        const cached = db.prepare('SELECT * FROM metal_price_cache WHERE currency_code = ? ORDER BY fetched_at DESC LIMIT 1').get(currency);
        if (cached) {
          return sendJson(res, 200, {
            goldPerGram: cached.gold_price_per_gram, silverPerGram: cached.silver_price_per_gram,
            currency, source: 'cached', fetchedAt: cached.fetched_at, error: 'Live price unavailable: ' + e.message,
          });
        }
        return sendJson(res, 503, { error: 'Live price unavailable and no cached price exists yet: ' + e.message });
      }
    }

    // ---- BACKUP ----
    if (pathname === '/api/backup/download' && method === 'GET') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      try {
        const { buffer, fileName } = createBackupZip();
        db.prepare('INSERT INTO backup_logs (file_name, kind, size_bytes) VALUES (?,?,?)').run(fileName, 'MANUAL', buffer.length);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': buffer.length,
        });
        return res.end(buffer);
      } catch (e) {
        return sendJson(res, 500, { error: 'Backup failed: ' + e.message });
      }
    }

    if (pathname === '/api/backup/history' && method === 'GET') {
      if (!requireRole(user, ['OWNER'])) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, db.prepare('SELECT * FROM backup_logs ORDER BY created_at DESC LIMIT 50').all());
    }

    // ---- fallback ----
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    // Full error (including stack) always goes to the server's own log for debugging.
    // What's sent back to the browser is deliberately generic in production — the raw
    // error message can leak internal details (file paths, SQL, library internals) to
    // whoever triggered it. Set NODE_ENV=development locally to see the real message
    // in the response too, which is handy while actively developing.
    console.error('Request error:', err);
    const isDev = process.env.NODE_ENV !== 'production';
    try { sendJson(res, 500, { error: isDev ? 'Server error: ' + err.message : 'Something went wrong on our end. Please try again.' }); }
    catch (e) { /* headers already sent */ }
  }
});

server.listen(PORT, () => {
  console.log(`SK Jewellers app running at http://localhost:${PORT}`);
  scheduleWeeklyBackups(db);
});
