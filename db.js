// db.js — SQLite data layer for SK Jewellers app.
// Uses Node's built-in experimental node:sqlite module — NO npm install required.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Defaults to a "data" folder next to this file, but can be overridden with the
// DATA_DIR environment variable — useful on hosts (like Render) where the persistent
// disk gets mounted at a path that doesn't necessarily line up with __dirname. If you
// set a custom mount path in render.yaml (or the Render dashboard), set DATA_DIR to
// that same path so the database/backups actually land on the persistent disk instead
// of the container's ephemeral filesystem.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'skjewellers.sqlite');

const isNew = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('OWNER','MAKER','CUSTOMER')),
    customer_id INTEGER,
    -- Employee profile fields (mainly used for MAKER role, but not restricted to it)
    phone_number TEXT,
    date_of_birth TEXT,
    address TEXT,
    blood_group TEXT,
    bank_account_number TEXT,
    bank_name TEXT,
    bank_ifsc TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    firm_name TEXT,
    city TEXT,
    state TEXT,
    gst_number TEXT,
    phone_number TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    package_code TEXT NOT NULL UNIQUE,
    weight_grams REAL,
    karat REAL,
    fine_gold_grams REAL,
    making_karat REAL,
    making_charge_fine_gold_grams REAL,
    net_fine_gold_grams REAL,
    credit_date TEXT,
    ledger_status TEXT CHECK(ledger_status IN ('LENA','DENA')),
    credit_weight_grams REAL,
    fine_weight_credit_type TEXT CHECK(fine_weight_credit_type IN ('FINE','BREAD')),
    credit_fine_gold_grams REAL,
    net_balance_fine_gold_grams REAL,
    delivery_date TEXT,
    estimated_completion_date TEXT,
    late_reason TEXT,
    received_by_name TEXT,
    package_status TEXT DEFAULT 'IN_PROGRESS',
    huid_number TEXT,
    remarks TEXT,
    assigned_maker_id INTEGER REFERENCES users(id),
    order_group_code TEXT, -- links several individual ring packages (different weights/karats)
                            -- that together make up one customer order (Use Case 2). Not unique:
                            -- many packages can share the same group code.
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    package_id INTEGER REFERENCES packages(id),
    employee_id INTEGER REFERENCES users(id), -- employee profile photo/ID proof/documents
    file_path TEXT NOT NULL,
    original_name TEXT,
    type TEXT CHECK(type IN ('PHOTO','DOCUMENT')) DEFAULT 'PHOTO',
    note TEXT,
    is_profile_photo INTEGER DEFAULT 0, -- marks the one PHOTO to show as the customer/employee's thumbnail
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Gold brought back by a customer to settle an outstanding balance, with no new
  -- order/package attached (Use Case 1). Mirrors the existing package-level credit
  -- fields (credit_weight_grams / fine_weight_credit_type / credit_fine_gold_grams) so
  -- the owner sees the same Fine/Bread + karat concept they already use on orders.
  CREATE TABLE IF NOT EXISTS gold_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    receipt_date TEXT NOT NULL,
    weight_grams REAL NOT NULL,
    karat REAL NOT NULL,
    fine_weight_credit_type TEXT CHECK(fine_weight_credit_type IN ('FINE','BREAD')) DEFAULT 'FINE',
    fine_gold_grams REAL, -- computed: weight_grams * karat / 100
    note TEXT,
    recorded_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Gold commission owed to a Maker for a delivered order (Use Case 3), computed
  -- automatically when a package becomes DELIVERED, using the shop-wide commission
  -- rate set in app_settings (e.g. a 100g delivered order at 0.2% pays 200mg of gold —
  -- matches the owner's own example). Rate is applied against the package's raw
  -- weight_grams, not the fine-gold-adjusted figure, to keep this easy for the owner
  -- to verify by hand. rate_percent_used is snapshotted at computation time so later
  -- rate changes never retroactively alter historical entries.
  CREATE TABLE IF NOT EXISTS maker_commission_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maker_id INTEGER NOT NULL REFERENCES users(id),
    package_id INTEGER REFERENCES packages(id),
    package_code TEXT, -- denormalized so the entry still reads sensibly if the package is later deleted
    base_weight_grams REAL, -- the package's weight_grams used as the commission base
    rate_percent_used REAL,
    commission_fine_gold_grams REAL,
    paid INTEGER DEFAULT 0,
    paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS production_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES packages(id),
    note TEXT NOT NULL,
    status_at_time TEXT,
    updated_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maker_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    present INTEGER DEFAULT 1,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(maker_id, date)
  );

  CREATE TABLE IF NOT EXISTS config_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_key TEXT NOT NULL,
    value TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(list_key, value)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS backup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    kind TEXT CHECK(kind IN ('MANUAL','AUTO')) DEFAULT 'AUTO',
    size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Shop-wide key/value settings (e.g. which country/currency to show metal prices in).
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT
  );

  -- Caches the last successfully-fetched gold/silver price so the dashboard always has
  -- something to show even if the live price API is briefly unreachable.
  CREATE TABLE IF NOT EXISTS metal_price_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency_code TEXT NOT NULL,
    gold_price_per_gram REAL,
    silver_price_per_gram REAL,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  `);

  // Idempotent column additions for databases created before these columns existed.
  // node:sqlite doesn't support "ADD COLUMN IF NOT EXISTS", so we probe + try/catch instead.
  const pkgCols = db.prepare("PRAGMA table_info(packages)").all().map(c => c.name);
  if (!pkgCols.includes('estimated_completion_date')) {
    db.exec('ALTER TABLE packages ADD COLUMN estimated_completion_date TEXT');
  }
  if (!pkgCols.includes('late_reason')) {
    db.exec('ALTER TABLE packages ADD COLUMN late_reason TEXT');
  }
  if (!pkgCols.includes('received_by_name')) {
    db.exec('ALTER TABLE packages ADD COLUMN received_by_name TEXT');
  }
  const custCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
  if (!custCols.includes('phone_number')) {
    db.exec('ALTER TABLE customers ADD COLUMN phone_number TEXT');
  }
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  const userColsToAdd = ['phone_number', 'date_of_birth', 'address', 'blood_group', 'bank_account_number', 'bank_name', 'bank_ifsc'];
  for (const col of userColsToAdd) {
    if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
  const attCols = db.prepare("PRAGMA table_info(attachments)").all().map(c => c.name);
  if (!attCols.includes('employee_id')) {
    db.exec('ALTER TABLE attachments ADD COLUMN employee_id INTEGER REFERENCES users(id)');
  }
  if (!attCols.includes('is_profile_photo')) {
    db.exec('ALTER TABLE attachments ADD COLUMN is_profile_photo INTEGER DEFAULT 0');
  }
  const pkgCols2 = db.prepare("PRAGMA table_info(packages)").all().map(c => c.name);
  if (!pkgCols2.includes('order_group_code')) {
    db.exec('ALTER TABLE packages ADD COLUMN order_group_code TEXT');
  }

  // Make sure shop-wide settings exist even for databases that were created before
  // app_settings (or these specific keys) existed — seed() only runs on a brand-new DB.
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?,?)`).run('METAL_PRICE_COUNTRY', 'IN');
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?,?)`).run('METAL_PRICE_CURRENCY', 'INR');
  // Maker commission rate: % of a delivered package's net fine gold grams, paid to the
  // assigned Maker as gold. e.g. "0.2" means 0.2% of delivered fine gold (so a 100g/92k
  // order's ~92g net fine gold would generate ~0.184g commission — tune this to match
  // whatever rate the owner actually pays; it's editable in Admin > Settings).
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?,?)`).run('MAKER_COMMISSION_RATE_PERCENT', '0.2');
}

function seed() {
  const customerCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  if (customerCount > 0) return; // already seeded

  const insCustomer = db.prepare(`INSERT INTO customers (code,name,firm_name,city,state,gst_number,phone_number,notes) VALUES (?,?,?,?,?,?,?,?)`);
  const customers = [
    ['C001', 'Ramesh Kumar', 'Kumar Jewels', 'Jaipur', 'Rajasthan', null, '9876500001', null],
    ['C002', 'Sunita Sharma', 'SS Gold Works', 'Surat', 'Gujarat', null, '9876500002', null],
    ['C003', 'Anil Mehta', 'AM Traders', 'Mumbai', 'Maharashtra', null, '9876500003', null],
  ];
  const custIds = {};
  for (const c of customers) {
    const info = insCustomer.run(...c);
    custIds[c[0]] = Number(info.lastInsertRowid);
  }

  const insUser = db.prepare(`INSERT INTO users (name,email,password,role,customer_id) VALUES (?,?,?,?,?)`);
  const ownerInfo = insUser.run('SK Jewellers Owner', 'owner@skjewellers.com', 'owner123', 'OWNER', null);
  const makerInfo = insUser.run('Suresh (Maker)', 'maker@skjewellers.com', 'maker123', 'MAKER', null);
  const custUserInfo = insUser.run('Ramesh Kumar', 'customer@skjewellers.com', 'customer123', 'CUSTOMER', custIds['C001']);
  const ownerId = Number(ownerInfo.lastInsertRowid);
  const makerId = Number(makerInfo.lastInsertRowid);

  // Sample employee profile details for the demo maker, so the new Admin > Employees
  // tab has something real to show immediately.
  db.prepare(`UPDATE users SET phone_number=?, date_of_birth=?, address=?, blood_group=?,
    bank_account_number=?, bank_name=?, bank_ifsc=? WHERE id=?`)
    .run('9876512345', '1992-06-15', '12 Johari Bazaar, Jaipur, Rajasthan', 'B+',
      '1234567890123', 'State Bank of India', 'SBIN0001234', makerId);

  // Real data extracted from Gold_Jewellery_Business_v2.xlsx "All Transactions" sheet.
  // Columns: custCode, srNo, pkgCode, weight, karat, fineGold, makingKarat, makingChargeFineGold,
  //          netFineGold, creditDate, ledgerStatus, creditWeight, creditType, creditFineGold,
  //          netBalance, deliveryDate, pkgStatus, huid
  const rows = [
    ['C001',1,'PKG-C001-01',100,92,92,2,2,94,'2024-01-10','Lena Hai',80,'Fine',80,14,'2024-01-25','Delivered','HUID10001'],
    ['C001',2,'PKG-C001-02',150,92,138,2,3,141,'2024-02-05','Lena Hai',120,'Fine',120,21,null,'In Progress','HUID10002'],
    ['C001',3,'PKG-C001-03',80,75,60,1.5,1.2,61.2,'2024-02-20','Dena Hai',60,'Bread',45,-16.2,'2024-03-01','Delivered','HUID10003'],
    ['C001',4,'PKG-C001-04',200,92,184,2,4,188,'2024-03-10','Lena Hai',null,'Fine',null,null,null,'In Progress','HUID10004'],
    ['C001',5,'PKG-C001-05',60,75,45,1.5,0.9,45.9,'2024-03-20','Lena Hai',50,'Fine',50,-4.1,null,'On Hold','HUID10005'],
    ['C002',1,'PKG-C002-01',120,92,110.4,2,2.4,112.8,'2024-01-15','Dena Hai',100,'Fine',100,-12.8,'2024-01-28','Delivered','HUID20001'],
    ['C002',2,'PKG-C002-02',90,75,67.5,1.5,1.35,68.85,'2024-02-10','Lena Hai',70,'Bread',52.5,16.35,null,'In Progress','HUID20002'],
    ['C002',3,'PKG-C002-03',180,92,165.6,2,3.6,169.2,'2024-03-05','Lena Hai',150,'Fine',150,19.2,'2024-03-18','Delivered','HUID20003'],
    ['C002',4,'PKG-C002-04',50,58,29,1,0.5,29.5,'2024-03-25','Dena Hai',null,'Fine',null,null,null,'In Progress','HUID20004'],
    ['C003',1,'PKG-C003-01',250,92,230,2,5,235,'2024-01-20','Lena Hai',200,'Fine',200,35,'2024-02-05','Delivered','HUID30001'],
    ['C003',2,'PKG-C003-02',110,75,82.5,1.5,1.65,84.15,'2024-02-15','Lena Hai',90,'Bread',67.5,16.65,null,'In Progress','HUID30002'],
    ['C003',3,'PKG-C003-03',70,92,64.4,2,1.4,65.8,'2024-03-12','Dena Hai',60,'Fine',60,-5.8,'2024-03-22','Delivered','HUID30003'],
    ['C003',4,'PKG-C003-04',300,92,276,2,6,282,'2024-04-01','Lena Hai',240,'Fine',240,42,null,'In Progress','HUID30004'],
    ['C003',5,'PKG-C003-05',85,75,63.75,1.5,1.275,65.025,'2024-04-10','Lena Hai',null,'Fine',null,null,null,'On Hold','HUID30005'],
    ['C003',6,'PKG-C003-06',40,58,23.2,1,0.4,23.6,'2024-04-15','Dena Hai',35,'Bread',20.3,-3.3,'2024-04-25','Delivered','HUID30006'],
  ];

  const insPkg = db.prepare(`INSERT INTO packages
    (customer_id, package_code, weight_grams, karat, fine_gold_grams, making_karat, making_charge_fine_gold_grams,
     net_fine_gold_grams, credit_date, ledger_status, credit_weight_grams, fine_weight_credit_type,
     credit_fine_gold_grams, net_balance_fine_gold_grams, delivery_date, estimated_completion_date, late_reason,
     package_status, huid_number, assigned_maker_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const statusMap = { 'Delivered':'DELIVERED', 'In Progress':'IN_PROGRESS', 'On Hold':'ON_HOLD', 'Cancelled':'CANCELLED' };
  const ledgerMap = { 'Lena Hai':'LENA', 'Dena Hai':'DENA' };
  const creditTypeMap = { 'Fine':'FINE', 'Bread':'BREAD' };

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  for (const r of rows) {
    const [custCode,,pkgCode,weight,karat,fineGold,makingKarat,makingChargeFineGold,netFineGold,
      creditDate,ledgerStatus,creditWeight,creditType,creditFineGold,netBalance,deliveryDate,pkgStatus,huid] = r;
    // Seed a plausible 15-day turnaround estimate from the credit date, so existing demo
    // orders already demonstrate the on-time / overdue / late-delivered tracking.
    const estimatedDate = creditDate ? addDays(creditDate, 15) : null;
    let lateReason = null;
    if (deliveryDate && estimatedDate && deliveryDate > estimatedDate) {
      lateReason = 'Demo data: delayed due to gold supply timing.';
    }
    insPkg.run(
      custIds[custCode], pkgCode, weight, karat, fineGold, makingKarat, makingChargeFineGold,
      netFineGold, creditDate, ledgerMap[ledgerStatus] || null, creditWeight, creditTypeMap[creditType] || null,
      creditFineGold, netBalance, deliveryDate, estimatedDate, lateReason,
      statusMap[pkgStatus] || 'IN_PROGRESS', huid, makerId
    );
  }

  // Config lists for admin-managed dropdowns
  const insConfig = db.prepare(`INSERT INTO config_lists (list_key, value, sort_order) VALUES (?,?,?)`);
  const configs = [
    ['PACKAGE_STATUS', 'IN_PROGRESS', 1], ['PACKAGE_STATUS', 'DELIVERED', 2],
    ['PACKAGE_STATUS', 'ON_HOLD', 3], ['PACKAGE_STATUS', 'CANCELLED', 4],
    ['LEDGER_STATUS', 'LENA', 1], ['LEDGER_STATUS', 'DENA', 2],
    ['CREDIT_TYPE', 'FINE', 1], ['CREDIT_TYPE', 'BREAD', 2],
    ['KARAT_OPTIONS', '58', 1], ['KARAT_OPTIONS', '75', 2], ['KARAT_OPTIONS', '92', 3], ['KARAT_OPTIONS', '99', 4],
  ];
  for (const c of configs) insConfig.run(...c);

  // A few sample production updates
  const firstPkg = db.prepare(`SELECT id FROM packages WHERE package_code = 'PKG-C001-02'`).get();
  if (firstPkg) {
    db.prepare(`INSERT INTO production_updates (package_id, note, status_at_time, updated_by) VALUES (?,?,?,?)`)
      .run(firstPkg.id, 'Gold melted and alloy mixed to required karat.', 'IN_PROGRESS', makerId);
    db.prepare(`INSERT INTO production_updates (package_id, note, status_at_time, updated_by) VALUES (?,?,?,?)`)
      .run(firstPkg.id, 'Ring casting done, moving to polishing.', 'IN_PROGRESS', makerId);
  }

  console.log('Seeded database with demo data from Gold_Jewellery_Business_v2.xlsx');
}

migrate();
seed();

function nullify(v) { return v === undefined ? null : v; }

function computePackageDerived(p) {
  const fineGold = (p.weight_grams != null && p.karat != null) ? +(p.weight_grams * p.karat / 100).toFixed(3) : nullify(p.fine_gold_grams);
  const netFineGold = (fineGold != null && p.making_charge_fine_gold_grams != null)
    ? +(fineGold + Number(p.making_charge_fine_gold_grams)).toFixed(3) : nullify(p.net_fine_gold_grams);
  let netBalance = nullify(p.net_balance_fine_gold_grams);
  if (netFineGold != null && p.credit_fine_gold_grams != null) {
    netBalance = +(netFineGold - Number(p.credit_fine_gold_grams)).toFixed(3);
  }
  return { fine_gold_grams: nullify(fineGold), net_fine_gold_grams: nullify(netFineGold), net_balance_fine_gold_grams: nullify(netBalance) };
}

// Converts a standalone gold receipt (Use Case 1: customer brings gold later to settle
// an old balance, with no new order attached) into fine-gold grams, the same unit used
// everywhere else in the ledger. "Bread" (impure) gold still has a karat/purity value —
// the owner enters whatever karat applies, same as they would for a package's credit.
function computeGoldReceiptFineGrams(weightGrams, karat) {
  if (weightGrams == null || karat == null) return null;
  return +(Number(weightGrams) * Number(karat) / 100).toFixed(3);
}

// Computes a "delivery_timeliness" tag for a package without storing it:
// - NOT_APPLICABLE: no estimated date set, or order cancelled
// - ON_TRACK: not yet delivered, estimate is still in the future
// - OVERDUE: not yet delivered, estimate has passed
// - ON_TIME: delivered on or before the estimate
// - LATE: delivered after the estimate
function computeTimeliness(p, todayStr) {
  if (!p.estimated_completion_date || p.package_status === 'CANCELLED') return 'NOT_APPLICABLE';
  const today = todayStr || new Date().toISOString().slice(0, 10);
  if (p.package_status === 'DELIVERED') {
    if (!p.delivery_date) return 'NOT_APPLICABLE';
    return p.delivery_date > p.estimated_completion_date ? 'LATE' : 'ON_TIME';
  }
  return today > p.estimated_completion_date ? 'OVERDUE' : 'ON_TRACK';
}

module.exports = { db, computePackageDerived, computeTimeliness, computeGoldReceiptFineGrams, DB_PATH, DATA_DIR, isNew };
