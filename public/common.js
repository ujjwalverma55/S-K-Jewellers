// common.js — shared client-side helpers. No build step, loaded as a plain <script>.
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}

async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

async function requireUser(allowedRoles) {
  try {
    const me = await api('/api/me');
    if (allowedRoles && !allowedRoles.includes(me.role)) {
      window.location.href = '/';
      return null;
    }
    return me;
  } catch (e) {
    window.location.href = '/';
    return null;
  }
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

function fmtDate(d) {
  if (!d) return '—';
  return d;
}

function statusBadge(status) {
  const label = (status || '').replace(/_/g, ' ');
  return `<span class="badge ${status}">${label}</span>`;
}

function ledgerBadge(status) {
  if (!status) return '—';
  const label = status === 'LENA' ? 'Lena Hai (We owe)' : 'Dena Hai (Owed to us)';
  return `<span class="badge ${status}">${label}</span>`;
}

function timelinessBadge(t) {
  const map = {
    ON_TIME: ['DELIVERED', 'On Time'],
    LATE: ['ON_HOLD', 'Delivered Late'],
    OVERDUE: ['ON_HOLD', 'Overdue'],
    ON_TRACK: ['IN_PROGRESS', 'On Track'],
    NOT_APPLICABLE: [null, null],
  };
  const [cls, label] = map[t] || [null, null];
  if (!cls) return '';
  return `<span class="badge ${cls}">${label}</span>`;
}

// ---------- Export helpers (SheetJS for Excel, jsPDF+autotable for PDF) ----------
// Pages that call these must include the relevant CDN <script> tags themselves:
//   https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
//   https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
//   https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js
function exportRowsToExcel(filename, sheetName, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : filename + '.xlsx');
}

// Stamps a repeating, semi-transparent diagonal "SK JEWELLERS" watermark across the
// FULL background of every page in the given jsPDF document. Applied last (after all
// content/pages exist) so it covers the whole page consistently regardless of how many
// pages autoTable ended up generating. Uses jsPDF's GState opacity support when
// available; if that ever isn't supported by the loaded jsPDF build, falls back to a
// plain light-gray watermark (still visible, just without true transparency) rather
// than failing the whole export.
function addWatermarkToPdf(doc, text) {
  text = text || 'SK JEWELLERS';
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let usedGState = false;
    try {
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.08 }));
      usedGState = true;
    } catch (e) { /* GState not available in this jsPDF build — fall back below */ }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(34);
    doc.setTextColor(usedGState ? 120 : 235);
    const stepX = 85, stepY = 55;
    for (let y = -stepY; y < pageHeight + stepY; y += stepY) {
      for (let x = -stepX; x < pageWidth + stepX; x += stepX) {
        doc.text(text, x, y, { angle: 45 });
      }
    }
    if (usedGState) doc.restoreGraphicsState();
  }
}

function exportRowsToPdf(filename, title, headers, rows) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: rows.length && headers.length > 6 ? 'landscape' : 'portrait' });
  doc.setFontSize(14);
  doc.text(title || 'SK Jewellers — Export', 14, 16);
  doc.setFontSize(9);
  doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, 14, 22);
  doc.autoTable({ head: [headers], body: rows, startY: 28, styles: { fontSize: 7 }, headStyles: { fillColor: [184, 134, 11] } });
  addWatermarkToPdf(doc);
  doc.save(filename.endsWith('.pdf') ? filename : filename + '.pdf');
}

function exportOrderSlipPdf(pkg) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text('SK JEWELLERS', 14, 18);
  doc.setFontSize(10);
  doc.text("Gents' Ring Manufacturing — Order Slip", 14, 25);
  doc.setLineWidth(0.5);
  doc.line(14, 28, 196, 28);

  const rows = [
    ['Package Code', pkg.package_code],
    ['Customer', `${pkg.customer.code} — ${pkg.customer.name}`],
    ['Firm', pkg.customer.firm_name || '—'],
    ['Package Weight / Karat', `${fmtNum(pkg.weight_grams)} g @ ${fmtNum(pkg.karat)}k`],
    ['Fine Gold (g)', fmtNum(pkg.fine_gold_grams)],
    ['Making Charge', `${fmtNum(pkg.making_karat)}k / ${fmtNum(pkg.making_charge_fine_gold_grams)} g`],
    ['Net Fine Gold (g)', fmtNum(pkg.net_fine_gold_grams)],
    ['Ledger Status', pkg.ledger_status === 'LENA' ? 'Lena Hai (we owe)' : pkg.ledger_status === 'DENA' ? 'Dena Hai (owed to us)' : '—'],
    ['Credit Fine Gold (g)', fmtNum(pkg.credit_fine_gold_grams)],
    ['Net Balance (g)', fmtNum(pkg.net_balance_fine_gold_grams)],
    ['Credit Date', fmtDate(pkg.credit_date)],
    ['Estimated Completion', fmtDate(pkg.estimated_completion_date)],
    ['Delivery Date', fmtDate(pkg.delivery_date)],
    ['Status', (pkg.package_status || '').replace(/_/g, ' ')],
    ['HUID Number', pkg.huid_number || '—'],
    ['Remarks', pkg.remarks || '—'],
  ];
  if (pkg.received_by_name) rows.push(['Received By', pkg.received_by_name]);
  if (pkg.late_reason) rows.push(['Late Delivery Reason', pkg.late_reason]);

  doc.autoTable({ body: rows, startY: 34, styles: { fontSize: 10 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } } });
  addWatermarkToPdf(doc);
  doc.save(`order-slip-${pkg.package_code}.pdf`);
}

// ---------- WhatsApp share ----------
function buildOrderStatusMessage(pkg) {
  const statusLabel = (pkg.package_status || '').replace(/_/g, ' ');
  let msg = `*SK Jewellers — Order Update*\n\n`;
  msg += `Package: ${pkg.package_code}\n`;
  msg += `Customer: ${pkg.customer.name}\n`;
  msg += `Status: ${statusLabel}\n`;
  if (pkg.estimated_completion_date) msg += `Estimated Completion: ${pkg.estimated_completion_date}\n`;
  if (pkg.delivery_date) msg += `Delivered On: ${pkg.delivery_date}\n`;
  if (pkg.received_by_name) msg += `Received By: ${pkg.received_by_name}\n`;
  if (pkg.huid_number) msg += `HUID: ${pkg.huid_number}\n`;
  msg += `\nThank you for choosing SK Jewellers!`;
  return msg;
}

function shareOrderOnWhatsApp(pkg) {
  const message = buildOrderStatusMessage(pkg);
  let phone = (pkg.customer && pkg.customer.phone_number || '').replace(/[^0-9]/g, '');
  if (phone && phone.length === 10) phone = '91' + phone; // default to India country code if a bare 10-digit number was saved
  const url = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildTopbar(user, activePath) {
  const navByRole = {
    OWNER: [
      ['/owner/', 'Dashboard'], ['/owner/packages.html', 'Orders'], ['/owner/customers.html', 'Customers'],
      ['/owner/admin.html', 'Admin / Config'], ['/owner/camera.html', 'Camera Capture'], ['/owner/attendance.html', 'Attendance'],
      ['/owner/backups.html', 'Backups'],
    ],
    MAKER: [
      ['/maker/', 'My Jobs'], ['/maker/camera.html', 'Camera Capture'], ['/maker/attendance.html', 'Attendance'],
    ],
    CUSTOMER: [
      ['/customer/', 'My Orders'],
    ],
  };
  const nav = navByRole[user.role] || [];
  const links = nav.map(([href, label]) =>
    `<a href="${href}" class="${activePath === href ? 'active' : ''}">${label}</a>`).join('');
  return `
    <div class="topbar">
      <div class="brand">SK JEWELLERS <small>Gents' Ring Manufacturing — ${escapeHtml(user.role)} PANEL</small></div>
      <nav>${links}</nav>
      <div class="userbox">
        ${escapeHtml(user.name)}
        <button onclick="doLogout()">Log out</button>
      </div>
    </div>`;
}

// ---------- Live metal price widget (shared across Owner/Maker/Customer dashboards) ----------
// The shop's currency is set once by the Owner in Admin > Settings; everyone sees the
// same rate. If the live API is unreachable (no internet, API down), the server falls
// back to the last cached price and tells us via "source":"cached" — we show that
// plainly rather than pretending it's live, so nobody is misled about freshness.
async function loadMetalPriceWidget(bodyElId, currencyLabelElId) {
  const body = document.getElementById(bodyElId);
  const currencyLabelEl = currencyLabelElId ? document.getElementById(currencyLabelElId) : null;
  if (!body) return;
  try {
    const d = await api('/api/metal-prices');
    if (currencyLabelEl) currencyLabelEl.textContent = '(' + d.currency + ' per gram)';
    const sourceNote = d.source === 'cached'
      ? `<span class="muted">(showing last known price — live price unavailable right now)</span>`
      : `<span class="muted">(live, updated ${new Date(d.fetchedAt).toLocaleTimeString('en-IN')})</span>`;
    body.innerHTML = `
      <div class="row" style="gap:24px;">
        <div><span style="font-size:1.3rem; font-weight:700;">🥇 ${fmtNum(d.goldPerGram)}</span> <span class="muted">Gold / g</span></div>
        <div><span style="font-size:1.3rem; font-weight:700;">🥈 ${fmtNum(d.silverPerGram)}</span> <span class="muted">Silver / g</span></div>
      </div>
      <div style="margin-top:6px;">${sourceNote}</div>`;
  } catch (err) {
    body.innerHTML = `<span class="muted">Live price unavailable right now (no internet or price service down). This does not affect order data — try again later.</span>`;
  }
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  window.location.href = '/';
}
