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

## Phone app (installable web app)

The portal installs to a phone's home screen and opens full screen like an app (no app store).
- iPhone/iPad: open the portal in Safari, tap Share, then **Add to Home Screen**.
- Android: Chrome shows **Install app** (also a button in the portal header).

`portal/sw.js` caches only the app's own static files and shows `offline.html` without a connection.
It never caches `/api/` responses, documents or invoices, so no client data is stored on the device by the app.
Files: `portal/manifest.webmanifest`, `portal/icons/`.

## Email notifications

Off until `SMTP_HOST` and `MAIL_FROM` are set. While off, notifications are dropped silently, so the
server logs a warning at startup and staff see **"Email notifications are off"** on the Clients screen.

When on:
- Client uploads a document or sends a message -> email to staff.
- Staff publishes a report/document or replies -> email to that client.
- Clients can opt out under **Account** (staff can also change it on the client's Account tab; the client list shows "Email off").
  Opting out only stops emails *to that client*; staff are still emailed about that client's uploads and messages.
- Bursts are batched: 10 uploads in a minute is one email ("10 new documents"). Window: `NOTIFY_DELAY_MS` (default 90000).
- Emails never contain file names or message text, only who, what kind, how many, and a sign-in link.
- Mail failures are logged and never block uploads or messages. Pending (unsent) notifications are lost if the server restarts.
- A send that fails for a temporary reason is retried 3 times (`NOTIFY_RETRY_MS`, default 2000ms backoff).
  A permanent SMTP 5xx (bad credentials, rejected recipient) is not retried; it is logged as
  `Email notification NOT DELIVERED` with the subject and recipients, so it can still be followed up by hand.

| Variable | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Mail server (port 587 uses STARTTLS; default 587) |
| `SMTP_SECURE=1` | Implicit TLS (port 465) instead of STARTTLS |
| `SMTP_USER`, `SMTP_PASS` | Login (Gmail/Google Workspace: use an app password) |
| `MAIL_FROM` | e.g. `RA Ledger Solutions <no-reply@raledgersolutions.com>` |
| `NOTIFY_STAFF_EMAIL` | Comma-separated staff recipients (default: every staff user's login email) |
| `NOTIFY_RETRY_MS` | Backoff between send attempts (default 2000) |
| `PORTAL_URL` | Public portal URL for the link in emails, e.g. `https://portal.raledgersolutions.com` |

The server refuses to send credentials or mail without TLS.

### Settings that are known to work

**Resend** (same account the phone agent uses, so one API key covers both):

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend                      # the literal word, not an email address
SMTP_PASS=re_...                      # a Resend API key
MAIL_FROM=RA Ledger Solutions <no-reply@raledgersolutions.com>
```

The portal emails clients, so the `MAIL_FROM` domain must be verified in Resend first.
An unverified account can only send from `onboarding@resend.dev`, and only to the account owner's
own address — enough to test, not enough for clients.

**Gmail / Google Workspace:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` your full
address, and `SMTP_PASS` an [app password](https://support.google.com/accounts/answer/185833)
(a normal account password is rejected, and an app password requires 2-step verification).

## Deploying (Google Cloud free server)

**Current setup:** the portal runs at `https://portal.raledgersolutions.com` on a Google Cloud always-free `e2-micro` VM
(30 GB disk). The marketing website at `raledgersolutions.com` / `www` is hosted on **Netlify**, separately. The HTML
pages in this repo are an older copy of the site; the server redirects everything except `/portal/`, `/api/` and
`/healthz` to the portal.

To rebuild the server from scratch:

1. Create the VM in **Compute Engine > VM instances**:
   - Region **us-east1**, **us-central1** or **us-west1** (only these are free).
   - Machine type **e2-micro**.
   - Boot disk: **Debian 12**, type **Standard persistent disk** (not Balanced), **30 GB**.
   - Firewall: allow **HTTP** and **HTTPS**.
2. **VPC network > IP addresses**: promote the VM's external IP to **static** so it never changes.
3. Click **SSH** on the VM and run (with your domain and staff email):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/ramiahmad1-sys/raledgersolutions/main/deploy/gcp-setup.sh | sudo bash -s -- portal.raledgersolutions.com you@example.com
   ```
   It prints the server IP and a one-time staff password.
4. In GoDaddy DNS add one record: type **A**, name **`portal`**, value = the server IP. Don't touch the `@`/`www`
   records (those point to Netlify). HTTPS is issued automatically once the record resolves.
5. Turn on email notifications: put the `SMTP_*` and `MAIL_FROM` settings in `/etc/raledger.env`
   (Gmail: an app password), then `sudo systemctl restart raledger`.

Afterwards: `sudo raledger-update` deploys the latest `main`; email settings live in `/etc/raledger.env`.
Daily backups go to `/var/lib/raledger/backups` (14 days, same disk).

## Deploying (Render)

`render.yaml` defines everything: a Node web service on the Starter plan with a 5 GB disk at `/var/data`.

1. Merge the portal PR into `main`.
2. In Render: **New > Blueprint**, connect GitHub, pick `ramiahmad1-sys/raledgersolutions`, apply.
3. When prompted, fill in `STAFF_EMAIL` and `STAFF_PASSWORD` (10+ chars); leave the SMTP ones blank to start with email off.
4. Open the `https://raledgersolutions.onrender.com` URL Render gives you, sign in at `/portal/`, then
   **delete `STAFF_PASSWORD`** from the service's Environment tab (it's only used on first start).
5. Custom domain: service **Settings > Custom Domains**, add `portal.raledgersolutions.com`.
   In GoDaddy **DNS**, add only the `portal` record Render shows. Leave the website's `@`/`www` records and MX/TXT alone.

Pushing to `main` redeploys. Render snapshots the disk daily; also download a copy periodically.

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
