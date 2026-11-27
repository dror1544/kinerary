#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# </dev/null matters now that this whole script arrives over the same ssh
# stdin stream `bash -s` reads from (#185): without it, a `pct exec ...--
# true` that relays/drains its inherited fd 0 (lxc-attach-style stdio
# relaying can do this even though `true` itself never reads) could consume
# bytes meant for the BOOTSTRAP_INNER heredoc below, on any of up to 30
# retries — truncating or shifting it silently. Under the old argv-based
# transport this couldn't happen: the whole script arrived as one argv
# string, never as a stdin stream a nested command could share.
for i in $(seq 1 30); do pct exec 203 -- true </dev/null 2>/dev/null && break; sleep 2; done

pct exec 203 -- bash -s <<'BOOTSTRAP_INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# The template generates only C.utf8; without this every apt/perl invocation
# emits several lines of "Setting locale failed" warnings, which is what
# masked a real EACCES behind truncated stderr on 2026-08-28.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
apt-get update -qq
# build-essential is not optional: server/package.json pulls in better-sqlite3,
# a native module, and npm falls back to a node-gyp build whenever no prebuilt
# binary matches the platform. Without a compiler deploy.sh's own
# `npm install --production` fails and the service never starts.
apt-get install -y -qq curl nginx ca-certificates gnupg build-essential >/dev/null
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi

mkdir -p /opt/kinerary/trips /opt/kinerary/site
mkdir -p /nfs/tokyo-2026/media/avatars
ln -sfn /nfs/tokyo-2026/media/avatars /opt/kinerary/site/avatars

if [ ! -f /opt/kinerary/.env ]; then
  JWT_SECRET=$(head -c 32 /dev/urandom | base64)
  # Hex, not base64: setup-mcp.sh copies this value around by
  # `grep '^HERMES_API_KEY=' | cut -d= -f2-`, so it must not contain '='.
  HERMES_API_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  cat > /opt/kinerary/.env <<ENVEOF
TRIP_DIR=/opt/kinerary/trips/tokyo-2026
DATA_DIR=/nfs/tokyo-2026/server-data
TRIP_DOCUMENTS_DIR=/nfs/tokyo-2026/documents
PORT=3000
TRIP_DESIGN_VARIANT=modern
JWT_SECRET=${JWT_SECRET}
HERMES_API_KEY=${HERMES_API_KEY}
ENVEOF
  printf 'SEED_PASSWORD=%s\n' seed-pass-fixture >> /opt/kinerary/.env
  printf 'CONTROL_PLANE_EXCHANGE_KEY=%s\n' exchange-key-fixture >> /opt/kinerary/.env
  printf 'HERMES_URL=%s\n' http://bridge.example:4300 >> /opt/kinerary/.env
  chmod 600 /opt/kinerary/.env
fi

cat > /etc/systemd/system/kinerary-server.service <<'UNITEOF'
[Unit]
Description=Kinerary Trip Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/kinerary/server
EnvironmentFile=/opt/kinerary/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

cat > /etc/nginx/sites-available/kinerary <<'NGINXEOF'
server {
  listen 8080;
  server_name _;
  root /opt/kinerary/site;
  index index.html;

  add_header X-Content-Type-Options nosniff;
  add_header X-Frame-Options DENY;
  add_header X-XSS-Protection "1; mode=block";

  location ~ ^/api/trivia/(events|public-events) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
  }

  location ^~ /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
    client_max_body_size 500m;
  }

  # An organizer's own Claude or ChatGPT (server/trip-mcp). Express answers
  # 404 on all of these unless the trip set TRIP_MCP_ENABLED, so routing them
  # on every trip exposes nothing; without these blocks they are static 404s
  # and the feature cannot be switched on without editing nginx by hand.
  location = /mcp {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 5m;
  }

  # The connector's upload pages (/mcp/upload-confirmation/<id>,
  # /mcp/upload-logo, /mcp/upload-photos): plain pages the site serves, which
  # `= /mcp` above does not match. The uploads themselves go to /api/.
  location ^~ /mcp/upload- {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location ^~ /oauth/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    # Registration and token requests are a few hundred bytes.
    client_max_body_size 64k;
  }

  location ^~ /.well-known/oauth- {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /photo/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location ~* \.(html)$ {
    add_header Cache-Control "no-cache, must-revalidate";
    try_files $uri =404;
  }

  # The classic app's own script and stylesheet are NOT content-hashed, and a
  # trip's hostname outlives the trip: a slug comes back, a container is
  # rebuilt, and the browser is holding the last trip's app.js. With no
  # Cache-Control at all it may serve that from cache without asking. On
  # 2026-09-12 a deployed fix was invisible to the organizer for exactly this
  # reason — the page revalidated, the script it loads did not.
  location ~* ^/[^/]+\.(js|css)$ {
    add_header Cache-Control "no-cache, must-revalidate";
    try_files $uri =404;
  }

  # The modern bundle IS content-hashed, so a changed file is a changed name and
  # the old one can be kept forever.
  location ^~ /modern/assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  location /avatars/ {
    return 404;
  }

  location ^~ /confirmations/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location ~* \.(md|txt|rtf|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|pkpass)$ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location / {
    try_files $uri $uri/ =404;
  }
}
NGINXEOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/kinerary /etc/nginx/sites-enabled/kinerary
systemctl daemon-reload
systemctl enable nginx kinerary-server >/dev/null 2>&1 || true
systemctl restart nginx
BOOTSTRAP_INNER
