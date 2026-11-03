# RA Ledger Solutions

Marketing site (static HTML) plus a client portal at `/portal/`, served by one small Node server.
No npm dependencies. Requires **Node 22.13+** (uses the built-in `node:sqlite`).

## Run

```bash
STAFF_EMAIL=you@example.com STAFF_PASSWORD='a long passphrase' npm start
```

Open http://localhost:3000. On first start the staff account is created from those variables
(afterwards they are ignored, so you can remove them). Add more staff from the portal's **Staff accounts** screen (or
`npm run create-user -- staff <email> <password>`). Client accounts are created from the Clients screen.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `DATA_DIR` | `./data` | SQLite database and uploaded files. **Back this up.** |
| `NODE_ENV=production` | | Marks the session cookie `Secure` (needs HTTPS) |
| `TRUST_PROXY=1` | | Use `X-Forwarded-For` for login throttling when behind a reverse proxy |

## Billing

Staff: **Billing** (top tab) and each client's **Billing** tab.
- Invoices start as drafts; **Send to client** assigns the next number (INV-0001, ...), locks the invoice and emails the client.
- Sent invoices can't be edited or deleted, only voided (and only before any payment is recorded). Numbers are never reused.
- Record payments (check, ACH, card, cash, Zelle) including partial payments; remove one only to correct a mistake.
- Optional "pay online" link per invoice (e.g. a QuickBooks or Stripe payment link); clients see a **Pay online** button.
- Monthly fees: set per client, then **Create drafts** for a month on the Billing page (one per client per month).
- Clients see their invoices, balance due, and a printable / PDF version (`/portal/invoice.html`).
- A client with invoice history can't be deleted, so records are kept.
- No sales tax lines: add one as a line item if a service is taxable.

## Email notifications

Off until `SMTP_HOST` and `MAIL_FROM` are set. When on:
- Client uploads a document or sends a message -> email to staff.
- Staff publishes a report/document or replies -> email to that client.
- Clients can opt out under **Account** (staff can also change it on the client's Account tab; the client list shows "Email off").
  Opting out only stops emails *to that client*; staff are still emailed about that client's uploads and messages.
- Bursts are batched: 10 uploads in a minute is one email ("10 new documents"). Window: `NOTIFY_DELAY_MS` (default 90000).
- Emails never contain file names or message text, only who, what kind, how many, and a sign-in link.
- Mail failures are logged and never block uploads or messages. Pending (unsent) notifications are lost if the server restarts.

| Variable | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Mail server (port 587 uses STARTTLS; default 587) |
| `SMTP_SECURE=1` | Implicit TLS (port 465) instead of STARTTLS |
| `SMTP_USER`, `SMTP_PASS` | Login (Gmail/Google Workspace: use an app password) |
| `MAIL_FROM` | e.g. `RA Ledger Solutions <no-reply@raledgersolutions.com>` |
| `NOTIFY_STAFF_EMAIL` | Comma-separated staff recipients (default: every staff user's login email) |
| `PORTAL_URL` | Public site URL for the link in emails, e.g. `https://raledgersolutions.com` |

The server refuses to send credentials or mail without TLS.

## Deploying (Google Cloud free server)

Runs at $0/month on Google Cloud's always-free `e2-micro` VM, which keeps data on a 30 GB disk.

1. Create the VM in **Compute Engine > VM instances**:
   - Region **us-east1**, **us-central1** or **us-west1** (only these are free).
   - Machine type **e2-micro**.
   - Boot disk: **Debian 12**, type **Standard persistent disk** (not Balanced), **30 GB**.
   - Firewall: allow **HTTP** and **HTTPS**.
2. **VPC network > IP addresses**: promote the VM's external IP to **static** so it never changes.
3. Click **SSH** on the VM and run (with your domain and staff email):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/ramiahmad1-sys/raledgersolutions/main/deploy/gcp-setup.sh | sudo bash -s -- raledgersolutions.com you@example.com
   ```
   It prints the server IP and a one-time staff password.
4. In GoDaddy DNS: `A @` to the server IP and `CNAME www` to `raledgersolutions.com`. HTTPS is issued automatically.

Afterwards: `sudo raledger-update` deploys the latest `main`; email settings live in `/etc/raledger.env`.
Daily backups go to `/var/lib/raledger/backups` (14 days, same disk).

## Deploying (Render)

`render.yaml` defines everything: a Node web service on the Starter plan with a 5 GB disk at `/var/data`.

1. Merge the portal PR into `main`.
2. In Render: **New > Blueprint**, connect GitHub, pick `ramiahmad1-sys/raledgersolutions`, apply.
3. When prompted, fill in `STAFF_EMAIL` and `STAFF_PASSWORD` (10+ chars); leave the SMTP ones blank to start with email off.
4. Open the `https://raledgersolutions.onrender.com` URL Render gives you, sign in at `/portal/`, then
   **delete `STAFF_PASSWORD`** from the service's Environment tab (it's only used on first start).
5. Custom domain: service **Settings > Custom Domains**, add `raledgersolutions.com` and `www.raledgersolutions.com`.
   In GoDaddy **DNS**, change only the `@` A record and the `www` CNAME to the values Render shows.
   Leave MX/TXT records alone. Render issues the HTTPS certificate automatically.

Pushing to `main` redeploys. Render snapshots the disk daily; also download a copy periodically.
The server serves the whole site, so once DNS points to Render the old host is no longer used.

Other hosts: any Node 22.13+ host with a persistent disk and HTTPS works; set the same variables.
Apache/PHP-only shared hosting (the `.htaccess` here) cannot run it.

## Security notes
- Passwords: scrypt with per-user salt; sessions are random tokens (only the hash is stored), HttpOnly + SameSite=Strict, 14 days.
- Login throttling: 8 failures per IP and per email per 15 minutes.
- Clients can only see their own company's data; enforced on the server for every endpoint (see `server/api.test.js`).
- Uploaded files are stored outside the web root, served only to authorized users as attachments.
- Files are stored unencrypted on the server disk. Use an encrypted volume and backups if you hold sensitive client records.

## Tests
`npm test`
