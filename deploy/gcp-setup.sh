#!/usr/bin/env bash
# One-shot setup for a Debian 12 server (e.g. Google Cloud always-free e2-micro).
# Installs Node 22 + Caddy (automatic HTTPS), runs the client portal as a locked-down systemd service,
# adds swap, daily backups and automatic security updates. Safe to re-run.
#
# The server hosts the portal only, on its own address (e.g. portal.raledgersolutions.com).
# The marketing website is hosted separately (Netlify). Visits to anything other than the portal redirect to it.
#
# Usage (on the server):  curl -fsSL <raw url of this file> | sudo bash -s -- <portal-domain> <staff-email>
#   e.g.  ... | sudo bash -s -- portal.raledgersolutions.com you@example.com
set -euo pipefail

DOMAIN="${1:-}"; STAFF_EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$STAFF_EMAIL" ]]; then echo "Usage: gcp-setup.sh <portal-domain> <staff-email>   (e.g. portal.raledgersolutions.com)"; exit 1; fi
# DNS record name to create: the part before the registered domain ("portal" for portal.raledgersolutions.com, "@" for a bare domain)
if [[ "$DOMAIN" == *.*.* ]]; then RECORD="${DOMAIN%%.*}"; ZONE="${DOMAIN#*.}"; else RECORD="@"; ZONE="$DOMAIN"; fi
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
REPO="https://github.com/ramiahmad1-sys/raledgersolutions.git"
BRANCH="${BRANCH:-main}"
APP=/opt/raledgersolutions
DATA=/var/lib/raledger
ENVF=/etc/raledger.env
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

say "Adding 1 GB swap (the free server has only 1 GB RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Installing packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades
if ! node -v 2>/dev/null | grep -Eq '^v(2[2-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
echo "Node $(node -v), $(caddy version | cut -d' ' -f1)"

say "Downloading the app"
id raledger >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin raledger
if [[ -d "$APP/.git" ]]; then git -C "$APP" fetch -q --depth 1 origin "$BRANCH" && git -C "$APP" reset -q --hard FETCH_HEAD
else git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP"; fi
mkdir -p "$DATA/backups" && chown -R raledger:raledger "$DATA" && chmod 700 "$DATA"

FIRST_PASSWORD=""
if [[ ! -f "$ENVF" ]]; then
  FIRST_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('base64url'))")"
  cat > "$ENVF" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA
TRUST_PROXY=1
PORTAL_URL=https://$DOMAIN
STAFF_EMAIL=$STAFF_EMAIL
STAFF_PASSWORD=$FIRST_PASSWORD
# Email notifications: fill in, then run: sudo systemctl restart raledger
#SMTP_HOST=smtp.gmail.com
#SMTP_USER=you@gmail.com
#SMTP_PASS=your-16-letter-app-password
#MAIL_FROM=RA Ledger Solutions <you@gmail.com>
ENV
  chmod 600 "$ENVF"
fi

say "Creating the service"
cat > /etc/systemd/system/raledger.service <<UNIT
[Unit]
Description=RA Ledger Solutions website and client portal
After=network-online.target
Wants=network-online.target

[Service]
User=raledger
Group=raledger
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

cat > /tmp/Caddyfile.new <<CADDY
$DOMAIN {
	encode gzip
	request_body {
		max_size 20MB
	}
	@notportal {
		not path /portal/* /api/* /healthz
	}
	redir @notportal /portal/ 302
	reverse_proxy 127.0.0.1:3000
}
CADDY
caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy config is invalid; not changed."; exit 1; }
install -m 644 /tmp/Caddyfile.new /etc/caddy/Caddyfile

cat > /usr/local/bin/raledger-backup <<'BK'
#!/usr/bin/env bash
# Daily copy of the database and uploaded files, kept 14 days (same disk: protects against mistakes, not disk loss).
set -euo pipefail
D=/var/lib/raledger; B=$D/backups; S=$(date +%F)
rm -f "$B/portal-$S.db"
node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('$D/portal.db').exec(\"VACUUM INTO '$B/portal-$S.db'\")"
tar -czf "$B/files-$S.tar.gz" -C "$D" files
chown raledger:raledger "$B"/*; chmod 600 "$B"/*
find "$B" -type f -mtime +14 -delete
BK
cat > /usr/local/bin/raledger-update <<UP
#!/usr/bin/env bash
# Pull the latest code from GitHub and restart.
set -euo pipefail
git -C $APP fetch -q --depth 1 origin $BRANCH && git -C $APP reset -q --hard FETCH_HEAD
systemctl restart raledger && sleep 2 && curl -fsS http://127.0.0.1:3000/healthz && echo " - updated to \$(git -C $APP log -1 --format='%h %s')"
UP
chmod 755 /usr/local/bin/raledger-backup /usr/local/bin/raledger-update
echo "17 3 * * * root /usr/local/bin/raledger-backup >/dev/null 2>&1" > /etc/cron.d/raledger-backup

systemctl daemon-reload
systemctl enable -q raledger caddy
systemctl restart raledger
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/healthz >/dev/null || { journalctl -u raledger -n 30 --no-pager; echo "The app did not start (see log above)."; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:3000/ || { echo "Website pages are not being served."; exit 1; }
systemctl reload caddy || systemctl restart caddy

# The first staff account now exists in the database; don't keep its password on disk.
sed -i '/^STAFF_PASSWORD=/d' "$ENVF"

IP="$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || curl -fsS -m 5 https://api.ipify.org || echo "(see VM instances page)")"
say "Done. The app is running."
cat <<MSG

  Server IP address:  $IP

  In GoDaddy DNS for $ZONE, add ONE record:
    Type A,  Name $RECORD,  Value $IP
  (do not change the @ / www records of your website, or MX/TXT records)

  After DNS updates, open https://$DOMAIN  (HTTPS is set up automatically)
MSG
if [[ -n "$FIRST_PASSWORD" ]]; then cat <<MSG

  Staff login:  $STAFF_EMAIL
  Temporary password (shown only once, write it down, then change it under Account):
      $FIRST_PASSWORD
MSG
fi
cat <<MSG

  Useful commands:  sudo raledger-update        (deploy latest code from GitHub)
                    sudo journalctl -u raledger -f   (live log)
                    sudo nano $ENVF   (email settings), then: sudo systemctl restart raledger
MSG
