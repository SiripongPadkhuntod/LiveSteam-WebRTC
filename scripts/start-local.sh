#!/bin/sh
set -eu

if [ -z "${LIVEKIT_NODE_IP:-}" ]; then
  LIVEKIT_NODE_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
fi
if [ -z "${LIVEKIT_NODE_IP:-}" ]; then
  LIVEKIT_NODE_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
if [ -z "${LIVEKIT_NODE_IP:-}" ]; then
  LIVEKIT_NODE_IP="127.0.0.1"
fi

export LIVEKIT_NODE_IP
docker compose -f infrastructure/docker-compose.yml up -d
echo "LiveKit is advertising ${LIVEKIT_NODE_IP} to WebRTC clients"
