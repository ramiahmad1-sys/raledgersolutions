# RA Ledger Solutions

Marketing site (static HTML) plus a client portal at `/portal/`, served by one small Node server.
No npm dependencies. Requires **Node 22.5+** (uses the built-in `node:sqlite`).

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

## Deploying

The Node server needs a host that can run Node (a small VPS, Render, Fly.io, Railway, etc. with a
persistent disk for `DATA_DIR`). Classic shared hosting that only runs Apache/PHP (the `.htaccess` here) cannot run it.
Put it behind HTTPS (e.g. Caddy or nginx, or the platform's TLS) and set `NODE_ENV=production`.
Point raledgersolutions.com at the server; it serves the website and the portal together.

## Security notes
- Passwords: scrypt with per-user salt; sessions are random tokens (only the hash is stored), HttpOnly + SameSite=Strict, 14 days.
- Login throttling: 8 failures per IP and per email per 15 minutes.
- Clients can only see their own company's data; enforced on the server for every endpoint (see `server/api.test.js`).
- Uploaded files are stored outside the web root, served only to authorized users as attachments.
- Files are stored unencrypted on the server disk. Use an encrypted volume and backups if you hold sensitive client records.

## Tests
`npm test`
