#!/usr/bin/env bash
# Copies the release built by the workflow to a server and runs remote-deploy.sh there.
# Environment (set by .github/workflows/deploy.yml): SSH_KEY, KNOWN_HOSTS, HOST, USER_NAME, SHA.
set -euo pipefail

: "${SSH_KEY:?}" "${KNOWN_HOSTS:?}" "${HOST:?}" "${USER_NAME:?}" "${SHA:?}"
mkdir -p ~/.ssh
chmod 700 ~/.ssh
printf '%s\n' "$SSH_KEY" > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
# The server's host key is pinned (no "trust on first use").
printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
SSH=(ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$USER_NAME@$HOST")

TARBALL="release-$SHA.tgz"
scp -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$TARBALL" scripts/deploy/remote-deploy.sh "$USER_NAME@$HOST:/tmp/"
"${SSH[@]}" "bash /tmp/remote-deploy.sh '$SHA' '/tmp/$TARBALL' && rm -f '/tmp/$TARBALL'"
rm -f ~/.ssh/deploy_key
