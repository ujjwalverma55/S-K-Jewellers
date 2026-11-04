# SK Jewellers — Order, Production & Gold Ledger System (v2)

A web app that replaces the paper gold-jewellery transaction register with a digital system for SK Jewellers (gents' ring manufacturing). Built with **zero external dependencies** — only Node.js's own built-in modules (`http`, `node:sqlite`, `zlib`) — so there is nothing to `npm install` and nothing that can break from a dependency update.

## Two versions exist side by side

This is **v2**, living in the `app-v2/` folder. The original version is untouched in the sibling `app/` folder. They are completely independent — separate code, separate database file, separate uploads folder — so nothing about v1 changed and you can go back to it any time by just running `node server.js` inside `app/` instead of `app-v2/`. Once you're confident v2 is working the way you want, you can retire `app/` (or keep it as a reference).

## What's new in v2

- **Due dates / on-time tracking**: every order now requires an "Estimated Completion Date." The app automatically flags orders as On Track, Overdue (past due, not yet delivered), On Time (delivered by the estimate), or Delivered Late. If anyone — owner or maker — tries to mark an order "Delivered" after its due date, the app requires them to type a reason first. Over time this builds a real record of *why* things run late.
- **Interactive dashboard charts**: the Owner dashboard now has a status breakdown donut chart, an on-time-vs-late bar chart, a monthly order volume trend line, an on-time delivery rate %, and a banner alerting you to any currently overdue orders.
- **Excel + PDF export**: every major table (Orders, Customers, your own orders as a Customer) has "Export Excel" and "Export PDF" buttons. Individual orders can also be exported as a one-page PDF "order slip." All exports run in your browser — nothing is uploaded anywhere.
- **Backups**: a new "Backups" page (Owner only) with a one-click "Backup Now" button that downloads a `.zip` containing a full database snapshot plus every uploaded photo/document. The app also automatically creates a backup like this roughly once a week while it's running, keeping the most recent 8. See the "Backup strategy" section below for what this does and doesn't protect against.
- **WhatsApp Share**: a "Share on WhatsApp" button on any order's detail view opens WhatsApp with a pre-filled status message, addressed to the customer's saved phone number if you've added one (Admin → Customers now has a Phone Number field).
- **Backups now include real Excel/CSV files, not just the database**: every backup `.zip` also contains ready-to-open `customers.xlsx` and `orders.xlsx` (open directly in Excel/Sheets, no app needed) and `workers_directory.csv` / `attendance_log.csv` for employee data.
- **Received By (Name)**: marking any order "Delivered" now requires recording who physically received it. Both Owner and Maker can set this field; it shows on the Orders table, the order slip PDF, and the WhatsApp status message.
- **Maker access is now restricted to active jobs only**: a Maker's "My Jobs" list only ever shows orders currently assigned to them that aren't yet Delivered/Cancelled — no history browsing. A Maker can edit exactly three things on their assigned orders: status, delivery date, and Received By name. Everything else (weight, karat, customer, pricing, etc.) can only be changed by the Owner.
- **Employee profiles for Makers**: Admin → Employees is a new tab where the Owner can record each Maker's phone number, date of birth, address, blood group, bank account details, and upload a profile photo or ID-proof/supporting documents — all private to the Owner.
- **PDF watermark**: every exported PDF (table exports and individual order slips) now has a faint, repeating diagonal "SK JEWELLERS" watermark covering the full page background.
- **Mobile-responsive design**: every page now reflows cleanly on phones and small tablets — stacked navigation, single-column forms, full-width buttons, scrollable tabs — using the same visual style as before.
- **More dashboard widgets**: the Owner dashboard now also shows a "Top Customers by Net Fine Gold" chart and a live "Recent Activity" feed (latest production notes and order status changes).
- **Live Gold/Silver price**: a widget on every dashboard (Owner, Maker, Customer) shows the current gold and silver price per gram, in the shop's chosen currency (set once by the Owner in Admin → Settings). If the live price service is ever unreachable, it falls back to the last known price rather than breaking — see "Notes on the live metal price widget" below.
- **Gold settlement ledger (no new order needed)**: use this when a customer brings gold later to settle an old balance — for example, they already received a 100g order but some gold was still owed, and days later they drop off gold (fine or impure "bread" gold — enter whichever karat applies) to settle it. Record it from Customers → Gold Ledger; it reduces that customer's overall outstanding balance immediately, without needing to attach it to any specific past order. Customers can see their own gold receipt history on their own portal.
- **Order Groups — multiple rings as one order**: if a single customer order is actually several individual rings of different weights (e.g. 10 rings at 1.5g, the rest at 2.5g, totaling ~100g), give them all the same Order Group code when creating each one (the Orders page suggests reusing a customer's existing group codes). Each ring stays its own independently trackable, editable, deliverable package — but the Orders page can filter by group and shows a rollup card (ring count + total weight) whenever a group is in view.
- **Maker gold commission**: Makers now automatically earn a gold commission when they deliver an order they're assigned to — e.g. at a 0.2% rate, delivering a 100g order earns 0.2g (200mg) of gold. The rate is a single company-wide setting (Admin → Settings → Maker Gold Commission Rate). Each Maker sees their own running commission total and history on their dashboard; the Owner sees everyone's in Admin → Maker Commissions, and can mark entries paid once settled. This is tracked separately from weekly cash salary, which stays outside the app as before. Past commission entries always keep the rate that was in effect when they were earned, even if the rate is changed later.
- **Profile photos for Customers and Makers**: both can now have a profile photo, shown as a small thumbnail directly in the Customers table and the Admin → Employees cards (falls back to the person's initial if no photo is set yet). Upload it from the Edit Customer / Edit Employee form.

Everything from v1 — three role-based logins, the gold ledger math, camera capture + OCR, the no-code admin config page, attendance — is still here and works the same way.

## Demo logins

| Role | Email | Password |
|------|-------|----------|
| Owner / Admin | `owner@skjewellers.com` | `owner123` |
| Maker | `maker@skjewellers.com` | `maker123` |
| Customer | `customer@skjewellers.com` | `customer123` |

These credentials are **not** displayed on the public login page by default — the demo-credentials box only appears if the server is started with the environment variable `SHOW_DEMO_CREDENTIALS=1` set. Leave it unset for any deployment holding real business data; it's meant for local testing/demos only.

The database is seeded automatically on first run with the 3 customers and 15 packages from your `Gold_Jewellery_Business_v2.xlsx`, now with estimated completion dates added (roughly 15 days after each order's credit date) so you can see the on-time/overdue/late tracking working immediately on real-looking data. One seeded order is deliberately marked "Delivered Late" with a demo reason, so you can see what that looks like.

## Running it locally

Requires **Node.js 22.5 or newer**. Check your version with `node -v`.

```bash
cd app-v2
node server.js
```

Then open **http://localhost:3000**. No `npm install` step.

To use the camera feature from your phone, make sure your phone and computer are on the same WiFi, find your computer's local IP (e.g. `192.168.1.5`), and open `http://192.168.1.5:3000` on your phone instead of `localhost`.

### Where your data lives

- Database: `app-v2/data/skjewellers.sqlite`
- Uploaded photos/documents: `app-v2/uploads/`
- Automatic backups: `app-v2/data/backups/`

All created automatically — don't delete them unless you want to wipe your data.

These are the defaults when running locally with `node server.js` and no extra configuration. On a host like Render where the persistent disk mounts at a different path, set the `DATA_DIR` and `UPLOADS_DIR` environment variables to point there instead (see the Deployment section below) — the app will create and use whatever folders those variables point to.

## Backup strategy — what's actually protected, and what isn't

Three layers exist now:

1. **Automatic weekly backup** (built in, no setup): while the server is running, it saves a `.zip` snapshot to `app-v2/data/backups/` roughly once a week, keeping the 8 most recent. This protects you against *accidentally deleting or corrupting data inside the app* — you can always go back to last week's snapshot.
2. **Manual "Backup Now" button** (Owner → Backups page): downloads the same kind of `.zip` to your Downloads folder on demand, any time you want — e.g. right before trying something new, or at the end of a busy day.
3. **What neither of these protects against**: both of the above only exist *on this same computer*. If this computer is lost, stolen, has its hard drive fail, or gets a virus, both the live data and the automatic backups go with it.

**To be properly protected, make a habit of:** after clicking "Backup Now," copy that downloaded `.zip` file somewhere physically or geographically separate — a USB drive you keep elsewhere, a free Google Drive or Dropbox folder, or just email it to yourself. Doing this even once a month would mean you could never lose more than a month of records, even in a worst-case scenario (theft, fire, hardware failure). This was a deliberate choice to keep things simple and free rather than requiring an email/cloud account to be configured up front — you can always ask for that to be added later if you'd prefer it fully automatic.

## Deploying so it's accessible from anywhere (not just shop WiFi)

This app needs a host with **persistent disk storage** for a long-running Node process, which rules out Vercel (serverless/ephemeral filesystem). We recommend **Render.com**.

**Important — verify Render's current disk pricing before you start.** This app genuinely needs a persistent disk (the database and every uploaded photo/document live on it) — Render has historically required at least their lowest *paid* instance tier for a disk, not the fully free one. Check [render.com/pricing](https://render.com/pricing) for their current plans before choosing one, since this wasn't re-verified live while writing this doc.

### Option A — one-click setup via the included `render.yaml` Blueprint (recommended)

This repo includes a `render.yaml` file that describes the whole service — disk, environment variables, health check — so Render can set it up automatically instead of you clicking through each setting by hand.

1. **Put this project in a GitHub repository.** Push the contents of this `app-v2/` folder (not the whole project folder — just `app-v2/` and its contents, including `render.yaml`) to a new GitHub repo.
2. **Sign up at [render.com](https://render.com)**.
3. Click **New +** → **Blueprint**, and connect it to your GitHub repository. Render will read `render.yaml` and show you the service it's about to create (including the disk) before anything is charged or deployed — review it, then confirm.
4. Once deployed, you'll get a public URL like `https://sk-jewellers.onrender.com`.
5. Log in with the demo credentials (see "Demo logins" above — remember these aren't shown on the live login page unless `SHOW_DEMO_CREDENTIALS=1` is set), then immediately go to **Admin → Users** and change the Owner password (and repurpose or delete the demo Maker/Customer accounts).

If you'd rather adjust anything first — the plan tier, disk size, or region — open `render.yaml` and edit it before pushing; the comments inside explain each setting.

### Option B — manual setup through the dashboard

If you'd rather not use the Blueprint, the same result can be configured by hand:

1. Push `app-v2/` to a GitHub repo, as in Option A.
2. Sign up at render.com, click **New +** → **Web Service**, connect your GitHub repository.
3. Configure the service:
   - **Runtime**: Node
   - **Build Command**: *(leave blank — nothing to install)*
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/healthz`
4. Add a **persistent disk**: Service settings → **Disks** → **Add Disk**, mount path `/var/data` (or any path you prefer), 1 GB is plenty to start.
5. Add **environment variables** (Service settings → **Environment**):
   - `NODE_ENV` = `production`
   - `DATA_DIR` = *(the disk's mount path)* + `/db`, e.g. `/var/data/db`
   - `UPLOADS_DIR` = *(the disk's mount path)* + `/uploads`, e.g. `/var/data/uploads`
6. Click **Create Web Service**, then log in and lock down the demo accounts as in step 5 of Option A.

### A note on `NODE_ENV=production`

Setting this hides detailed internal error messages from anyone using the live site (they'll see a generic "something went wrong" instead) while still logging the full error on the server for you to diagnose. Leave it unset while developing locally so you can see the real error messages.

### Security hardening — done before going live

This app was originally built simple and dependency-free, with a few shortcuts that were fine on a private shop computer but would matter once reachable from the internet. All of the following have now been fixed, still with zero npm dependencies (everything uses Node's own built-in `crypto` module):

- **Passwords are now hashed with scrypt** (a salted, slow-to-brute-force algorithm), not stored as plain text or a bare unsalted hash. Any account created before this change upgrades automatically, with no action needed, the next time that person logs in successfully.
- **Login attempts are rate-limited**: after 8 failed attempts against the same email address within 10 minutes, further attempts against that account are blocked for a few minutes, even if the correct password is eventually tried. This specifically targets repeated guesses against one account, not just one IP, so a shared shop/office internet connection can't get accidentally locked out by someone mistyping their own password.
- **All API traffic is rate-limited** to a generous per-visitor ceiling, to blunt scripted abuse without affecting normal clicking-around use.
- **Sessions expire after 7 days server-side**, independent of the cookie itself, and the "Secure" cookie flag is automatically set whenever the app is accessed over HTTPS (which Render's free tier provides automatically) — it stays off for local HTTP testing so `node server.js` on your own computer still works normally.
- **Changing a password immediately logs out every other session** for that account, so a stolen session cookie stops working the moment the Owner resets a compromised account's password.
- **File uploads are restricted** to the file types this app actually needs (photos, PDF, Word, Excel) and capped at 15MB, and anything uploaded that isn't a safe-to-display image/PDF is served as a forced download rather than rendered inline — this closes off a trick where a disguised file (e.g. a `.html` file renamed to look like a photo) could otherwise run inside the app's own pages.
- **Path-traversal protection** on both static file serving and uploaded file serving, so a crafted URL can't reach files outside their intended folders.
- **Security response headers** (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) are sent on every response.
- **Server error messages are generic** by default in production (set `NODE_ENV=production` on your host) — internal details like file paths or database errors are logged on the server, not shown to whoever triggered them. Leave `NODE_ENV` unset while developing locally to keep seeing the detailed message.
- **Basic input validation**: email format and an 8-character-minimum password are now enforced when creating or editing any user account.

None of this changes day-to-day correctness — orders, the gold ledger, backups, and everything else still work exactly the same. This hardening pass only applies to `app-v2/`; `app/` (v1) was intentionally left untouched, per your earlier choice to keep it as a pure fallback.

### Alternative: Railway.app

Same idea — persistent volume + long-running Node process, free trial credit, nearly identical setup steps.

### If you specifically need Vercel

Still a demo/preview-only option — every cold start resets the database and loses uploaded photos. Not suitable for real daily use. Would need a different build (external Postgres + external file storage) to work properly on Vercel.

## Notes on the OCR / Camera feature

Unchanged from v1: Tesseract.js runs entirely in the browser, no third-party AI service involved, no API key, no cost. Always review extracted text before saving — handwriting accuracy varies.

## Notes on the new charts and export libraries

The dashboard charts use **Chart.js**, and the Excel/PDF exports use **SheetJS** and **jsPDF** — all three loaded from a CDN via `<script>` tags in the relevant pages, the same lightweight approach already used for Tesseract.js. None of these are npm dependencies; nothing needed to be installed to build this.

## Notes on the live metal price widget

The gold/silver price comes from two free, no-API-key public endpoints: goldprice.org's own public data feed (USD price per troy ounce, converted to price-per-gram) and open.er-api.com for currency conversion into whatever currency the shop is configured for (Admin → Settings). Both are plain HTTPS requests using Node's built-in `https` module — no npm dependency added.

If either service is briefly unreachable (no internet, API down or changed), the widget automatically falls back to showing the last price it successfully fetched, clearly labeled as "showing last known price" so you're never shown stale data without knowing it. The very first time the app runs with no internet access at all, there's no cached price yet, so the widget shows a short "unavailable right now" message instead — this never affects orders, customers, or any other part of the app.

Since this is a live internet service, it's worth keeping in mind that the exact price may differ slightly from your local bullion dealer's rate (making charges, local premiums, and import duties aren't included) — treat it as a reference point, not a quote.

## Project structure

```
app-v2/
  server.js       — the whole backend: HTTP server, routing, auth, all API endpoints
  db.js           — database schema + seed data + gold math + on-time/late calculation
  backup.js       — manual + automatic backup logic (database snapshot + Excel/CSV exports)
  zip-writer.js   — hand-written ZIP file writer (used by backup.js and xlsx-writer.js, no npm archiver)
  xlsx-writer.js  — hand-written minimal .xlsx file builder (used by backup.js, no npm exceljs/xlsx)
  helpers.js      — small utilities (sessions, password hashing, rate limiting, multipart parsing)
  render.yaml     — Render.com Blueprint (disk + env vars + health check) for one-click deployment
  public/         — all frontend pages (plain HTML/CSS/JS, no build step)
    index.html    — login page
    owner/        — Dashboard (charts, top customers, activity feed, live metal price), Orders, Customers,
                    Admin/Config (Users, Employees, Dropdown Lists, Customer Documents, Settings), Camera,
                    Attendance, Backups
    maker/        — Maker's job list (active jobs only, late-reason + receiver-name prompts), Camera, Attendance
    customer/     — Customer's read-only order view (with export buttons)
  data/           — SQLite database file + backups/ subfolder (created automatically)
  uploads/        — uploaded photos/documents, including employee profile photos/ID proof (created automatically)
```

Because everything is plain Node.js and plain HTML/CSS/JS with no build step, any web developer (or a future session with me) can open any file and edit it directly.
