#!/usr/bin/env bash
# Prepares an Ubuntu 24.04 VM on a local network (no public IP, no domain) as the staging server.
# Run once on the VM, as root, from a clone of this repository:
#
#   git clone https://github.com/teenShirt/serenova-poultry-erp.git && cd serenova-poultry-erp
#   sudo RUNNER_TOKEN=<token> bash scripts/deploy/setup-staging-vm.sh
#
# Another site already on port 80? Add HTTP_PORT=8080 (or any free port) before "bash".
#
# RUNNER_TOKEN: GitHub → repository Settings → Actions → Runners → New self-hosted runner (Linux);
# copy the value after --token (valid for one hour). Without it, everything except the runner is set up.
#
# GitHub's own machines cannot reach a VM without a public address, so the staging job runs on a
# GitHub Actions runner installed here (label "serenova-staging") and deploys to this machine over
# SSH (127.0.0.1) with the same scripts as production. The site is plain HTTP on the VM's address,
# so secure cookies are off: staging only, never for real customer data.
#
# Safe to run again: existing passwords, keys and .env are kept.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$REPO_DIR/deploy/serenova.service" ]] || { echo "Run from a clone of the repository" >&2; exit 1; }

BASE=/opt/serenova
# Its own folder: the VM may already have a runner for another repository in /opt/actions-runner.
RUNNER_DIR=/opt/actions-runner-serenova-poultry
RUNNER_LABEL=serenova-staging
# Port nginx serves the app on; set HTTP_PORT=8080 (say) when another site already uses port 80.
HTTP_PORT="${HTTP_PORT:-80}"
REPO_URL=https://github.com/teenShirt/serenova-poultry-erp
SECRETS=/root/serenova-staging
IP="$(hostname -I | awk '{print $1}')"
URL="http://$IP"
[[ "$HTTP_PORT" == 80 ]] || URL="$URL:$HTTP_PORT"
export DEBIAN_FRONTEND=noninteractive

log() { echo; echo "== $*"; }
rand() { openssl rand -hex "$1"; }

log "Packages"
apt-get update -q
apt-get install -yq ca-certificates curl git gnupg nginx openssh-server openssl lsb-release jq

if ! command -v node > /dev/null || [[ "$(node -v)" != v22.* ]]; then
  log "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

if ! command -v mysqld > /dev/null; then
  log "MySQL 8.4 (the version CI tests with)"
  echo "mysql-apt-config mysql-apt-config/select-server select mysql-8.4-lts" | debconf-set-selections
  if curl -fsSLo /tmp/mysql-apt-config.deb https://repo.mysql.com/mysql-apt-config_0.8.33-1_all.deb \
    && dpkg -i /tmp/mysql-apt-config.deb && apt-get update -q && apt-get install -yq mysql-server; then
    :
  else
    echo "MySQL 8.4 repository unavailable: installing Ubuntu's MySQL 8.0 instead"
    apt-get install -yq mysql-server
  fi
fi
systemctl enable --now mysql ssh

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
[[ -f "$SECRETS/db_password" ]] || rand 24 > "$SECRETS/db_password"
DB_PASSWORD="$(cat "$SECRETS/db_password")"

log "Database and its account"
mysql <<SQL
CREATE DATABASE IF NOT EXISTS serenova CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;
CREATE DATABASE IF NOT EXISTS serenova_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;
CREATE USER IF NOT EXISTS 'serenova'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'serenova'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON serenova.* TO 'serenova'@'localhost';
GRANT ALL PRIVILEGES ON serenova_restore_test.* TO 'serenova'@'localhost';
SQL

log "Accounts: serenova (runs the app), deploy (installs releases), github-runner (runs the staging job)"
id serenova > /dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin serenova
id deploy > /dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
id github-runner > /dev/null 2>&1 || useradd --create-home --shell /bin/bash github-runner

# deploy owns the releases and the "current" link; only serenova can read the settings and data.
mkdir -p "$BASE/releases" "$BASE/shared/data/backups"
chown deploy:deploy "$BASE" "$BASE/releases"
chown serenova:serenova "$BASE/shared" "$BASE/shared/data" "$BASE/shared/data/backups"
chmod 711 "$BASE/shared"
chmod 750 "$BASE/shared/data"

if [[ ! -f "$BASE/shared/.env" ]]; then
  log "Settings ($BASE/shared/.env)"
  sed -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$DB_PASSWORD|" \
    -e "s|^BACKUP_ENCRYPTION_KEY=.*|BACKUP_ENCRYPTION_KEY=$(rand 32)|" \
    -e "s|^SETUP_KEY=.*|SETUP_KEY=$(rand 24)|" \
    -e "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" \
    "$REPO_DIR/.env.staging.example" > "$BASE/shared/.env"
fi
chown serenova:serenova "$BASE/shared/.env"
chmod 600 "$BASE/shared/.env"

log "Service"
install -m 644 "$REPO_DIR/deploy/serenova.service" /etc/systemd/system/serenova.service
systemctl daemon-reload
systemctl enable serenova
cat > /etc/sudoers.d/serenova-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart serenova, /usr/bin/journalctl -u serenova *
SUDO
chmod 440 /etc/sudoers.d/serenova-deploy
visudo -cf /etc/sudoers.d/serenova-deploy

log "nginx: $URL → the app"
cat > /etc/nginx/sites-available/serenova <<NGINX
server {
    listen $HTTP_PORT default_server;
    server_name _;
    client_max_body_size 512m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/serenova /etc/nginx/sites-enabled/serenova
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
if ufw status 2> /dev/null | grep -q "Status: active"; then ufw allow "$HTTP_PORT/tcp"; ufw allow OpenSSH; fi

log "Deploy key (the staging job signs in as deploy@127.0.0.1)"
[[ -f "$SECRETS/deploy_key" ]] || ssh-keygen -q -t ed25519 -N "" -C "serenova-staging-deploy" -f "$SECRETS/deploy_key"
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qF "$(cat "$SECRETS/deploy_key.pub")" /home/deploy/.ssh/authorized_keys || cat "$SECRETS/deploy_key.pub" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
ssh-keyscan -t ed25519 127.0.0.1 2> /dev/null > "$SECRETS/known_hosts"

if [[ -n "${RUNNER_TOKEN:-}" && ! -f "$RUNNER_DIR/.runner" ]]; then
  log "GitHub Actions runner (label $RUNNER_LABEL)"
  VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')"
  mkdir -p "$RUNNER_DIR"
  curl -fsSL "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz" | tar -xz -C "$RUNNER_DIR"
  chown -R github-runner:github-runner "$RUNNER_DIR"
  (
    cd "$RUNNER_DIR"
    ./bin/installdependencies.sh
    sudo -u github-runner ./config.sh --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" \
      --name "$(hostname)-staging" --labels "$RUNNER_LABEL" --no-default-labels --replace
    ./svc.sh install github-runner
    ./svc.sh start
  )
elif [[ ! -f "$RUNNER_DIR/.runner" ]]; then
  echo
  echo "!! Runner not installed: run again with RUNNER_TOKEN=<token> (see the top of this script)."
fi

cat <<DONE

==================================================================================================
Staging VM ready. Now in GitHub → repository Settings:

Environments → New environment "staging" → Environment secrets:
  DEPLOY_SSH_KEY      = contents of $SECRETS/deploy_key        (sudo cat $SECRETS/deploy_key)
  DEPLOY_KNOWN_HOSTS  = contents of $SECRETS/known_hosts       (sudo cat $SECRETS/known_hosts)

Secrets and variables → Actions → Variables:
  STAGING_RUNNER = $RUNNER_LABEL
  STAGING_HOST   = 127.0.0.1
  STAGING_USER   = deploy
  STAGING_URL    = $URL

Then Actions → Deploy → Run workflow. Afterwards open $URL and finish the first-run setup
with the SETUP_KEY from $BASE/shared/.env   (sudo grep SETUP_KEY $BASE/shared/.env)

Keep a copy of BACKUP_ENCRYPTION_KEY from that file somewhere apart from this VM.
==================================================================================================
DONE
