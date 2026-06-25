#!/bin/sh
set -eu

STATE_DIR="${BATSHIT_CLOUDFLARED_STATE_DIR:-/runtime/cloudflared}"
STATUS_PATH="${BATSHIT_CLOUDFLARED_STATUS_PATH:-${STATE_DIR}/status.json}"
LOG_PATH="${BATSHIT_CLOUDFLARED_LOG_PATH:-${STATE_DIR}/cloudflared.log}"
PUBLIC_URL_PATH="${STATE_DIR}/public-url.txt"
PIPE_PATH="${STATE_DIR}/cloudflared.pipe"
TARGET_URL="${BATSHIT_CLOUDFLARED_TARGET_URL:-http://batshit-server:5600}"
METRICS_ADDR="${BATSHIT_CLOUDFLARED_METRICS:-0.0.0.0:20241}"
HEARTBEAT_SECONDS="${BATSHIT_CLOUDFLARED_HEARTBEAT_SECONDS:-15}"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
VERSION="$(cloudflared --version 2>/dev/null | sed -n 's/^cloudflared version \([^ ]*\).*/\1/p')"
PID=""
READER_PID=""
HEARTBEAT_PID=""

mkdir -p "${STATE_DIR}"
rm -f "${PIPE_PATH}" "${PUBLIC_URL_PATH}" "${LOG_PATH}"

write_status() {
  status="$1"
  public_url="${2:-}"
  error="${3:-}"
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  jq -n \
    --arg mode "docker-sidecar" \
    --arg status "${status}" \
    --arg publicUrl "${public_url}" \
    --arg targetUrl "${TARGET_URL}" \
    --arg startedAt "${STARTED_AT}" \
    --arg lastSeenAt "${now}" \
    --arg version "${VERSION:-unknown}" \
    --arg logPath "${LOG_PATH}" \
    --arg error "${error}" \
    '{
      mode: $mode,
      status: $status,
      publicUrl: (if $publicUrl == "" then null else $publicUrl end),
      targetUrl: $targetUrl,
      startedAt: $startedAt,
      lastSeenAt: $lastSeenAt,
      version: $version,
      logPath: $logPath,
      error: (if $error == "" then null else $error end)
    }' > "${STATUS_PATH}.tmp"
  mv "${STATUS_PATH}.tmp" "${STATUS_PATH}"
}

public_url_from_file() {
  if [ -s "${PUBLIC_URL_PATH}" ]; then
    head -n 1 "${PUBLIC_URL_PATH}"
  else
    printf ''
  fi
}

cleanup() {
  write_status "stopping" "$(public_url_from_file)" ""
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
  fi
  if [ -n "${READER_PID}" ]; then kill "${READER_PID}" 2>/dev/null || true; fi
  if [ -n "${HEARTBEAT_PID}" ]; then kill "${HEARTBEAT_PID}" 2>/dev/null || true; fi
  rm -f "${PIPE_PATH}" "${PUBLIC_URL_PATH}"
  write_status "stopped" "" ""
  exit 0
}

trap cleanup INT TERM

write_status "starting" "" ""
mkfifo "${PIPE_PATH}"

cloudflared tunnel --no-autoupdate --metrics "${METRICS_ADDR}" --url "${TARGET_URL}" > "${PIPE_PATH}" 2>&1 &
PID="$!"

(
  while kill -0 "${PID}" 2>/dev/null; do
    current_public_url="$(public_url_from_file)"
    if [ -n "${current_public_url}" ]; then
      write_status "running" "${current_public_url}" ""
    else
      write_status "starting" "" ""
    fi
    sleep "${HEARTBEAT_SECONDS}"
  done
) &
HEARTBEAT_PID="$!"

(
  while IFS= read -r line; do
    printf '%s\n' "${line}" >> "${LOG_PATH}"
    maybe_url="$(printf '%s\n' "${line}" | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | head -n 1 || true)"
    if [ -n "${maybe_url}" ]; then
      printf '%s\n' "${maybe_url}" > "${PUBLIC_URL_PATH}"
      write_status "running" "${maybe_url}" ""
    fi
  done < "${PIPE_PATH}"
) &
READER_PID="$!"

set +e
wait "${PID}"
EXIT_CODE="$?"
set -e

kill "${READER_PID}" "${HEARTBEAT_PID}" 2>/dev/null || true
wait "${READER_PID}" 2>/dev/null || true
wait "${HEARTBEAT_PID}" 2>/dev/null || true

ERROR_TAIL="$(tail -n 20 "${LOG_PATH}" 2>/dev/null || true)"
rm -f "${PIPE_PATH}" "${PUBLIC_URL_PATH}"
write_status "exited" "" "${ERROR_TAIL}"
exit "${EXIT_CODE}"
