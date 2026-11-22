#!/usr/bin/env bash
set -euo pipefail

# Posts an HMAC-SHA256 signed telephony/DTMF event back to Node.js backend
PROVIDER_CALL_ID="${1:-}"
EVENT_TYPE="${2:-completed}"
DIGIT="${3:-}"
DURATION_SEC="${4:-0}"

BACKEND_URL="${FLOWMIND_BACKEND_URL:-http://backend:4000}"
SECRET="${TELEPHONY_WEBHOOK_SECRET:-telephony-callback-hmac-secret}"
EVENT_ID="ast-${PROVIDER_CALL_ID}-${EVENT_TYPE}-${RANDOM}-$(date +%s%N)"

if [ -n "${DIGIT}" ]; then
  PAYLOAD=$(printf '{"providerEventId":"%s","provider":"asterisk","providerCallId":"%s","eventType":"%s","digit":"%s","durationSec":%s}' \
    "${EVENT_ID}" "${PROVIDER_CALL_ID}" "${EVENT_TYPE}" "${DIGIT}" "${DURATION_SEC}")
else
  PAYLOAD=$(printf '{"providerEventId":"%s","provider":"asterisk","providerCallId":"%s","eventType":"%s","durationSec":%s}' \
    "${EVENT_ID}" "${PROVIDER_CALL_ID}" "${EVENT_TYPE}" "${DURATION_SEC}")
fi

SIG=$(printf '%s' "${PAYLOAD}" | openssl dgst -sha256 -hmac "${SECRET}" | awk '{print $NF}')

curl -sS -X POST "${BACKEND_URL}/api/webhooks/telephony/events" \
  -H "Content-Type: application/json" \
  -H "X-Telephony-Signature: sha256=${SIG}" \
  -d "${PAYLOAD}" >/dev/null
