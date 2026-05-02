#!/bin/sh
set -e

ensure_attrs() {
  temporal operator search-attribute create --name LoanStatus --type Keyword >/dev/null 2>&1 || true
  temporal operator search-attribute create --name FailedActivity --type Keyword >/dev/null 2>&1 || true
}

if nc -z localhost 7233 2>/dev/null; then
  echo "Temporal already on :7233 — ensuring search attributes exist..."
  ensure_attrs
  exec npx concurrently -k -n worker,web -c green,yellow "npm start" "npm run web"
else
  exec npx concurrently -k -n server,worker,web -c blue,green,yellow \
    "temporal server start-dev --search-attribute LoanStatus=Keyword --search-attribute FailedActivity=Keyword" \
    "npx wait-on tcp:7233 && npm start" \
    "npx wait-on tcp:7233 && npm run web"
fi
