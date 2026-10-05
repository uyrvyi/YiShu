#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if command -v docker >/dev/null 2>&1; then
  DOCKER=docker
elif [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
  DOCKER=docker
else
  printf '%s\n' 'Docker Desktop is required.' >&2
  exit 1
fi

# Docker's CLI token requests do not inherit macOS System Settings proxies.
if [ -z "${HTTPS_PROXY:-${https_proxy:-}}" ] && command -v scutil >/dev/null 2>&1; then
  DEV_PROXY_SETTINGS=$(scutil --proxy)
  DEV_PROXY_ENABLED=$(printf '%s\n' "$DEV_PROXY_SETTINGS" | awk '/HTTPSEnable :/ {print $3}')
  if [ "$DEV_PROXY_ENABLED" = 1 ]; then
    DEV_PROXY_HOST=$(printf '%s\n' "$DEV_PROXY_SETTINGS" | awk '/HTTPSProxy :/ {print $3}')
    DEV_PROXY_PORT=$(printf '%s\n' "$DEV_PROXY_SETTINGS" | awk '/HTTPSPort :/ {print $3}')
    export HTTPS_PROXY="http://$DEV_PROXY_HOST:$DEV_PROXY_PORT"
    export HTTP_PROXY="${HTTP_PROXY:-$HTTPS_PROXY}"
    export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"
  fi
fi

if [ "$#" -gt 0 ]; then
  exec "$DOCKER" compose "$@"
fi

"$DOCKER" compose build dev
DEV_HOST_IP=${DEV_HOST_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}
export DEV_HOST_IP
"$DOCKER" compose run --rm --no-deps -e DEV_HOST_IP dev node scripts/docker-init-env.mjs
exec "$DOCKER" compose up -d --wait --wait-timeout 600
