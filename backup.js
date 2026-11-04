// backup.js — manual + automatic backups, with zero npm dependencies.
//
// Produces a single .zip file containing:
//  - a safe, consistent snapshot of the database (via SQLite's "VACUUM INTO")
//  - every file in uploads/
//  - customers.xlsx and orders.xlsx — real Excel files, so the owner can open the
//    backup's business data directly without touching the app or a database tool
//  - workers_directory.csv and attendance_log.csv — plain CSV for worker/employee data
//  - gold_receipts.csv and maker_commissions.csv — plain CSV for the two gold ledgers
//    that live outside the main orders table (customer settlements with no new order,
//    and per-delivery Maker commission)
// Uses zip-writer.js (hand-written ZIP, no npm archiver) and xlsx-writer.js
// (hand-written minimal .xlsx, no npm exceljs/xlsx) — both zero-dependency.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, DB_PATH } = require('./db.js');
const { buildZip } = require('./zip-writer.js');
const { buildXlsx } = require('./xlsx-writer.js');

// Must resolve the same way server.js's UPLOADS_DIR does (including the optional
// UPLOADS_DIR env override) — otherwise a backup taken on a host with a custom mount
// path would silently zip up the wrong (empty) folder instead of the real uploads.
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, 'uploads');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ---------- CSV helper ----------
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function buildCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

// ---------- business-data exports (read straight from the live DB; read-only queries) ----------
function buildCustomersXlsx(db) {
  const headers = ['Code', 'Name', 'Firm Name', 'City', 'State', 'Phone Number', 'GST Number', 'Notes', 'Created At'];
  const rows = db.prepare('SELECT * FROM customers ORDER BY code').all().map(c => [
    c.code, c.name, c.firm_name, c.city, c.state, c.phone_number, c.gst_number, c.notes, c.created_at
  ]);
  return buildXlsx('Customers', headers, rows);
}

function buildOrdersXlsx(db) {
  const headers = [
    'Package Code', 'Order Group', 'Customer Code', 'Customer Name', 'Weight (g)', 'Karat', 'Fine Gold (g)',
    'Making Karat', 'Making Charge (g)', 'Net Fine Gold (g)', 'Ledger Status', 'Credit Weight (g)',
    'Credit Type', 'Credit Fine Gold (g)', 'Net Balance (g)', 'Credit Date', 'Estimated Completion',
    'Delivery Date', 'Package Status', 'HUID Number', 'Received By', 'Late Reason', 'Remarks', 'Assigned Maker',
  ];
  const rows = db.prepare(`
    SELECT p.*, c.code as cust_code, c.name as cust_name, u.name as maker_name
    FROM packages p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN users u ON u.id = p.assigned_maker_id
    ORDER BY p.credit_date, p.id`).all().map(p => [
    p.package_code, p.order_group_code, p.cust_code, p.cust_name, p.weight_grams, p.karat, p.fine_gold_grams,
    p.making_karat, p.making_charge_fine_gold_grams, p.net_fine_gold_grams, p.ledger_status,
    p.credit_weight_grams, p.fine_weight_credit_type, p.credit_fine_gold_grams, p.net_balance_fine_gold_grams,
    p.credit_date, p.estimated_completion_date, p.delivery_date, p.package_status, p.huid_number,
    p.received_by_name, p.late_reason, p.remarks, p.maker_name,
  ]);
  return buildXlsx('Orders', headers, rows);
}

function buildWorkersCsv(db) {
  const headers = ['Name', 'Email', 'Role', 'Linked Customer Code', 'Created At'];
  const rows = db.prepare(`
    SELECT u.name, u.email, u.role, c.code as cust_code, u.created_at
    FROM users u LEFT JOIN customers c ON c.id = u.customer_id
    ORDER BY u.role, u.name`).all().map(u => [u.name, u.email, u.role, u.cust_code, u.created_at]);
  return buildCsv(headers, rows);
}

function buildAttendanceCsv(db) {
  const headers = ['Date', 'Worker Name', 'Present', 'Note'];
  const rows = db.prepare(`
    SELECT al.date, u.name, al.present, al.note
    FROM attendance_logs al JOIN users u ON u.id = al.maker_id
    ORDER BY al.date DESC`).all().map(r => [r.date, r.name, r.present ? 'Present' : 'Absent', r.note]);
  return buildCsv(headers, rows);
}

// Gold receipts: gold brought back by a customer later to settle a balance, with no
// new order attached (Use Case 1) — kept as its own export since it's not tied to the
// package/order table at all.
function buildGoldReceiptsCsv(db) {
  const headers = ['Customer Code', 'Customer Name', 'Date', 'Weight (g)', 'Karat', 'Type', 'Fine Gold (g)', 'Note', 'Recorded By'];
  const rows = db.prepare(`
    SELECT gr.*, c.code as cust_code, c.name as cust_name, u.name as recorded_by_name
    FROM gold_receipts gr JOIN customers c ON c.id = gr.customer_id
    LEFT JOIN users u ON u.id = gr.recorded_by
    ORDER BY gr.receipt_date DESC`).all().map(r => [
    r.cust_code, r.cust_name, r.receipt_date, r.weight_grams, r.karat, r.fine_weight_credit_type, r.fine_gold_grams, r.note, r.recorded_by_name,
  ]);
  return buildCsv(headers, rows);
}

// Maker commission ledger (Use Case 3): gold commission earned per delivered order.
function buildMakerCommissionsCsv(db) {
  const headers = ['Maker Name', 'Package Code', 'Base Weight (g)', 'Rate Used (%)', 'Commission (g)', 'Earned On', 'Paid?', 'Paid At'];
  const rows = db.prepare(`
    SELECT mcl.*, u.name as maker_name
    FROM maker_commission_ledger mcl LEFT JOIN users u ON u.id = mcl.maker_id
    ORDER BY mcl.created_at DESC`).all().map(r => [
    r.maker_name, r.package_code, r.base_weight_grams, r.rate_percent_used, r.commission_fine_gold_grams,
    r.created_at, r.paid ? 'Paid' : 'Unpaid', r.paid_at,
  ]);
  return buildCsv(headers, rows);
}

function listFilesRecursive(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.gitkeep' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue; // never include the backups folder in itself
      out.push(...listFilesRecursive(full, rel));
    } else {
      out.push({ full, rel });
    }
  }
  return out;
}

// Creates a backup ZIP in memory (does not write to disk itself) containing:
//  - database/skjewellers.sqlite       (safe consistent snapshot via VACUUM INTO)
//  - excel/customers.xlsx              (customer master list, opens directly in Excel)
//  - excel/orders.xlsx                 (full order/package register, opens directly in Excel)
//  - csv/workers_directory.csv         (owner/maker/customer-login accounts)
//  - csv/attendance_log.csv            (maker attendance records)
//  - uploads/<...>                     (every uploaded photo/document, as-is)
// Returns { buffer, fileName }.
function createBackupZip() {
  const tmpSnapshotPath = path.join(BACKUPS_DIR, `.snapshot-${Date.now()}.sqlite`);
  try {
    const liveDb = new DatabaseSync(DB_PATH);
    liveDb.exec(`VACUUM INTO '${tmpSnapshotPath.replace(/'/g, "''")}'`);

    const entries = [];
    entries.push({ name: 'database/skjewellers.sqlite', data: fs.readFileSync(tmpSnapshotPath) });
    entries.push({ name: 'excel/customers.xlsx', data: buildCustomersXlsx(liveDb) });
    entries.push({ name: 'excel/orders.xlsx', data: buildOrdersXlsx(liveDb) });
    entries.push({ name: 'csv/workers_directory.csv', data: buildWorkersCsv(liveDb) });
    entries.push({ name: 'csv/attendance_log.csv', data: buildAttendanceCsv(liveDb) });
    entries.push({ name: 'csv/gold_receipts.csv', data: buildGoldReceiptsCsv(liveDb) });
    entries.push({ name: 'csv/maker_commissions.csv', data: buildMakerCommissionsCsv(liveDb) });
    liveDb.close();

    for (const f of listFilesRecursive(UPLOADS_DIR)) {
      entries.push({ name: `uploads/${f.rel}`, data: fs.readFileSync(f.full) });
    }
    const buffer = buildZip(entries);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `sk-jewellers-backup-${stamp}.zip`;
    return { buffer, fileName };
  } finally {
    try { fs.unlinkSync(tmpSnapshotPath); } catch (e) { /* ignore */ }
  }
}

// Writes an automatic backup to disk under data/backups/ and prunes old ones,
// keeping the most recent N (default 8, i.e. roughly 2 months of weekly backups).
function runAutoBackup(keep = 8) {
  const { buffer, fileName } = createBackupZip();
  const destPath = path.join(BACKUPS_DIR, fileName);
  fs.writeFileSync(destPath, buffer);
  pruneOldBackups(keep);
  return { fileName, size: buffer.length, path: destPath };
}

function pruneOldBackups(keep = 8) {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const f of files.slice(keep)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f.name)); } catch (e) { /* ignore */ }
  }
}

// Schedules a recurring automatic backup roughly once a week, as long as the
// Node process keeps running. This is a best-effort local backup, NOT a substitute
// for an off-site copy — see README for what this does and doesn't protect against.
function scheduleWeeklyBackups(db, intervalMs = 7 * 24 * 60 * 60 * 1000) {
  function tick() {
    try {
      const result = runAutoBackup();
      db.prepare('INSERT INTO backup_logs (file_name, kind, size_bytes) VALUES (?,?,?)')
        .run(result.fileName, 'AUTO', result.size);
      console.log(`[backup] Automatic backup created: ${result.fileName} (${result.size} bytes)`);
    } catch (e) {
      console.error('[backup] Automatic backup failed:', e.message);
    }
  }
  // Run one shortly after startup (so a long-lived server builds up a history even if
  // it's restarted more often than once a week), then on the regular interval.
  setTimeout(tick, 60 * 1000);
  setInterval(tick, intervalMs);
}

module.exports = { createBackupZip, runAutoBackup, pruneOldBackups, scheduleWeeklyBackups, BACKUPS_DIR };
