#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./load-test.sh [options]

Examples:
  ./load-test.sh
  ./load-test.sh --users 500 --concurrency 50
  ./load-test.sh --source-room room-ab12cd --duration 5m
  ./load-test.sh --source-room channel-2 --skip-livekit
  API_URL=http://192.168.1.10:8080/api/token LIVEKIT_URL=ws://192.168.1.10:7980 ./load-test.sh

Options:
  -u, --users N          Number of simulated viewers. Default: 200
  -c, --concurrency N    Parallel token requests. Default: 25
  -r, --room ROOM        LiveKit room to test. Default: SOURCE_ROOM-program for d1, SOURCE_ROOM for source
      --source-room ROOM Source room used to derive the default program room. Default: channel-2
      --api-url URL      Control API token endpoint. Default: http://127.0.0.1:8080/api/token
      --health-url URL   Control API health endpoint. Default: http://127.0.0.1:8080/health
      --origin URL       Origin header used for token requests. Default: http://127.0.0.1:3001
      --livekit-url URL  LiveKit signaling URL. Default: ws://127.0.0.1:7980 for d1, ws://127.0.0.1:7880 for source
      --target TARGET    Token target: d1 or source. Default: d1
      --duration TIME    LiveKit test duration, such as 5m or 1h. Default: run until canceled
      --num-per-second N Number of LiveKit testers to start every second. Default: 5
      --skip-api         Skip token API load test.
      --skip-livekit     Skip LiveKit subscriber load test.
  -h, --help             Show this help.

Environment variables can also be used:
  USERS, CONCURRENCY, SOURCE_ROOM, ROOM, API_URL, HEALTH_URL, ORIGIN,
  TARGET, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  PUBLISHERS, SUBSCRIBERS, IDENTITY_PREFIX, VIDEO_RESOLUTION, DURATION,
  NUM_PER_SECOND, LIVEKIT_CLI.
EOF
}

SOURCE_ROOM="${SOURCE_ROOM:-channel-2}"
ROOM="${ROOM:-}"
USERS="${USERS:-200}"
CONCURRENCY="${CONCURRENCY:-25}"
API_URL="${API_URL:-http://127.0.0.1:8080/api/token}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"
ORIGIN="${ORIGIN:-http://127.0.0.1:3001}"
TARGET="${TARGET:-d1}"
LIVEKIT_URL="${LIVEKIT_URL:-}"
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-}"
PUBLISHERS="${PUBLISHERS:-0}"
SUBSCRIBERS="${SUBSCRIBERS:-}"
IDENTITY_PREFIX="${IDENTITY_PREFIX:-viewer-}"
VIDEO_RESOLUTION="${VIDEO_RESOLUTION:-high}"
DURATION="${DURATION:-}"
NUM_PER_SECOND="${NUM_PER_SECOND:-5}"
LIVEKIT_CLI="${LIVEKIT_CLI:-livekit-cli}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-10}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
SKIP_API="${SKIP_API:-0}"
SKIP_LIVEKIT="${SKIP_LIVEKIT:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--users)
      USERS="$2"
      shift 2
      ;;
    -c|--concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    -r|--room)
      ROOM="$2"
      shift 2
      ;;
    --source-room)
      SOURCE_ROOM="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --health-url)
      HEALTH_URL="$2"
      shift 2
      ;;
    --origin)
      ORIGIN="$2"
      shift 2
      ;;
    --livekit-url)
      LIVEKIT_URL="$2"
      shift 2
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --duration)
      DURATION="$2"
      shift 2
      ;;
    --num-per-second)
      NUM_PER_SECOND="$2"
      shift 2
      ;;
    --skip-api)
      SKIP_API=1
      shift
      ;;
    --skip-livekit)
      SKIP_LIVEKIT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SUBSCRIBERS" ]]; then
  SUBSCRIBERS="$USERS"
fi

require_positive_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer. Got: $value" >&2
    exit 2
  fi
}

require_non_negative_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer. Got: $value" >&2
    exit 2
  fi
}

require_positive_int "USERS" "$USERS"
require_positive_int "CONCURRENCY" "$CONCURRENCY"
require_non_negative_int "PUBLISHERS" "$PUBLISHERS"
require_non_negative_int "SUBSCRIBERS" "$SUBSCRIBERS"
require_positive_int "NUM_PER_SECOND" "$NUM_PER_SECOND"

if [[ "$TARGET" != "d1" && "$TARGET" != "source" ]]; then
  echo "TARGET must be d1 or source. Got: $TARGET" >&2
  exit 2
fi

if [[ "$TARGET" == "source" ]]; then
  ROOM="${ROOM:-$SOURCE_ROOM}"
  LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
  LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
  LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-devsecret_devsecret_devsecret_12345}"
else
  ROOM="${ROOM:-${SOURCE_ROOM}-program}"
  LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7980}"
  LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-d1key}"
  LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-d1secret_d1secret_d1secret_12345}"
fi

TOKEN_RESULTS="$(mktemp "${TMPDIR:-/tmp}/localstream-token-results.XXXXXX")"
SORTED_RESULTS=""
trap 'rm -f "$TOKEN_RESULTS" ${SORTED_RESULTS:+"$SORTED_RESULTS"}' EXIT

print_config() {
  cat <<EOF
Load test configuration
  users:        $USERS
  concurrency:  $CONCURRENCY
  source room:  $SOURCE_ROOM
  room:         $ROOM
  token target: $TARGET
  api url:      $API_URL
  livekit url:  $LIVEKIT_URL
  subscribers:  $SUBSCRIBERS
  livekit rate: $NUM_PER_SECOND/sec
EOF
  if [[ "$TARGET" == "d1" ]]; then
    echo "  watch UI:     /studio?channel=$SOURCE_ROOM or /watch?channel=$SOURCE_ROOM"
  fi
  if [[ -n "$DURATION" ]]; then
    echo "  duration:     $DURATION"
  else
    echo "  duration:     until canceled"
  fi
}

check_control_api() {
  if [[ "$SKIP_API" == "1" ]]; then
    return
  fi

  echo "Checking Control API health: $HEALTH_URL"
  curl -fsS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" "$HEALTH_URL" >/dev/null
}

run_token_load_test() {
  if [[ "$SKIP_API" == "1" ]]; then
    echo "Skipping token API load test."
    return
  fi

  echo "Requesting $USERS viewer tokens with concurrency $CONCURRENCY..."
  : > "$TOKEN_RESULTS"

  export API_URL ORIGIN ROOM TARGET REQUEST_TIMEOUT CONNECT_TIMEOUT TOKEN_RESULTS
  seq 1 "$USERS" | xargs -P "$CONCURRENCY" -I "{}" bash -c '
    i="$1"
    payload=$(printf "{\"identity\":\"bot-viewer-%s\",\"room\":\"%s\",\"role\":\"viewer\",\"target\":\"%s\"}" "$i" "$ROOM" "$TARGET")
    curl -sS -o /dev/null \
      -w "%{http_code} %{time_total}\n" \
      --connect-timeout "$CONNECT_TIMEOUT" \
      --max-time "$REQUEST_TIMEOUT" \
      -X POST "$API_URL" \
      -H "Accept: */*" \
      -H "Content-Type: application/json" \
      -H "Origin: $ORIGIN" \
      -H "Referer: $ORIGIN/" \
      -H "User-Agent: LocalStream-LoadTest/1.0" \
      --data-raw "$payload" >> "$TOKEN_RESULTS" 2>/dev/null || echo "000 0" >> "$TOKEN_RESULTS"
  ' _ "{}"

  summarize_token_results
}

summarize_token_results() {
  local total
  total="$(wc -l < "$TOKEN_RESULTS" | tr -d ' ')"
  if [[ "$total" == "0" ]]; then
    echo "No token request results were captured."
    exit 1
  fi

  SORTED_RESULTS="$(mktemp "${TMPDIR:-/tmp}/localstream-token-results-sorted.XXXXXX")"
  sort -k2,2n "$TOKEN_RESULTS" > "$SORTED_RESULTS"

  awk -v sorted_results="$SORTED_RESULTS" '
    {
      code=$1
      latency=$2 + 0
      count++
      if (code >= 200 && code < 300) ok++; else failed++
      sum += latency
      if (count == 1 || latency < min) min = latency
      if (latency > max) max = latency
      status[code]++
    }
    END {
      p50_index = int((count * 0.50) + 0.999999)
      p95_index = int((count * 0.95) + 0.999999)
      if (p50_index < 1) p50_index = 1
      if (p95_index < 1) p95_index = 1
      while ((getline line < sorted_results) > 0) {
        split(line, fields, " ")
        row++
        if (row == p50_index) p50 = fields[2] + 0
        if (row == p95_index) p95 = fields[2] + 0
      }
      close(sorted_results)
      printf "Token API summary\n"
      printf "  total:   %d\n", count
      printf "  success: %d\n", ok + 0
      printf "  failed:  %d\n", failed + 0
      printf "  avg:     %.3fs\n", sum / count
      printf "  p50:     %.3fs\n", p50
      printf "  p95:     %.3fs\n", p95
      printf "  min:     %.3fs\n", min
      printf "  max:     %.3fs\n", max
      printf "  status:"
      for (code in status) printf " %s=%d", code, status[code]
      printf "\n"
      if ((failed + 0) > 0) exit 1
    }
  ' "$TOKEN_RESULTS"
  rm -f "$SORTED_RESULTS"
  SORTED_RESULTS=""
}

run_livekit_load_test() {
  if [[ "$SKIP_LIVEKIT" == "1" ]]; then
    echo "Skipping LiveKit subscriber load test."
    return
  fi

  if ! command -v "$LIVEKIT_CLI" >/dev/null 2>&1; then
    cat >&2 <<EOF
Cannot find '$LIVEKIT_CLI'.
Install LiveKit CLI, set LIVEKIT_CLI to the command path, or run with --skip-livekit.
EOF
    exit 127
  fi

  echo "Starting LiveKit load test: $SUBSCRIBERS subscribers in $ROOM..."
  local args=(
    load-test
    --url "$LIVEKIT_URL" \
    --api-key "$LIVEKIT_API_KEY" \
    --api-secret "$LIVEKIT_API_SECRET" \
    --room "$ROOM" \
    --publishers "$PUBLISHERS" \
    --subscribers "$SUBSCRIBERS" \
    --identity-prefix "$IDENTITY_PREFIX" \
    --video-resolution "$VIDEO_RESOLUTION" \
    --num-per-second "$NUM_PER_SECOND"
  )
  if [[ -n "$DURATION" ]]; then
    args+=(--duration "$DURATION")
  fi
  "$LIVEKIT_CLI" "${args[@]}"
}

print_config
check_control_api
run_token_load_test
run_livekit_load_test
