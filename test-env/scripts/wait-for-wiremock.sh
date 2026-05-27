#!/usr/bin/env sh
# Wait until WireMock answers the admin health probe.
# Usage: wait-for-wiremock.sh [base-url] [timeout-seconds]
set -eu

BASE_URL="${1:-http://127.0.0.1:18080}"
TIMEOUT="${2:-60}"
DEADLINE=$(( $(date +%s) + TIMEOUT ))

while :; do
  if curl -fsS "${BASE_URL}/__admin/health" >/dev/null 2>&1; then
    echo "wiremock ready at ${BASE_URL}"
    exit 0
  fi
  if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    echo "wiremock did not become healthy within ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
done
