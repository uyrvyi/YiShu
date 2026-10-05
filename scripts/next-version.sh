#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec docker compose -f docker-compose.next-version.yml --profile preview "$@"
