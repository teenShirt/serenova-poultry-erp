#!/usr/bin/env bash
# Copies the release built by the workflow to a server and runs remote-deploy.sh there.
# Environment (set by .github/workflows/deploy.yml): SSH_KEY, KNOWN_HOSTS, HOST, USER_NAME, SHA.
set -euo pipefail

: "${HOST:?}" "${USER_NAME:?}" "${SHA:?}"
mkdir -p ~/.ssh
chmod 700 ~/.ssh
KEY="$HOME/.ssh/deploy_key"
if [[ "$HOST" == 127.0.0.1 || "$HOST" == localhost ]]; then
  # A runner on the server itself deploys to this machine: the host key is read here, not over the
  # network, and the deploy key kept here by setup-staging-vm.sh is used instead of the secret.
  KNOWN_HOSTS="${KNOWN_HOSTS:-$HOST $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)}"
  if [[ -f "$HOME/.ssh/serenova_deploy_key" ]]; then KEY="$HOME/.ssh/serenova_deploy_key"; fi
fi
: "${KNOWN_HOSTS:?}"
if [[ "$KEY" == "$HOME/.ssh/deploy_key" ]]; then
  : "${SSH_KEY:?}"
  printf '%s\n' "$SSH_KEY" > "$KEY"
  chmod 600 "$KEY"
fi
# The server's host key is pinned (no "trust on first use").
printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$USER_NAME@$HOST")

TARBALL="release-$SHA.tgz"
scp -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$TARBALL" scripts/deploy/remote-deploy.sh "$USER_NAME@$HOST:/tmp/"
"${SSH[@]}" "bash /tmp/remote-deploy.sh '$SHA' '/tmp/$TARBALL' && rm -f '/tmp/$TARBALL'"
rm -f ~/.ssh/deploy_key
