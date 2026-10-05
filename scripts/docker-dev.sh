#!/bin/sh
set -eu

pnpm install --frozen-lockfile

# Also provision the isolated test database when an existing data volume is reused.
psql --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE yishu_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'yishu_test')
\gexec
SQL
pnpm exec prisma migrate deploy
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec prisma migrate deploy

# API integration tests import the Worker's compiled exports on a clean checkout.
pnpm build:packages
pnpm --filter @yishu/worker build
exec pnpm --parallel -r run dev
