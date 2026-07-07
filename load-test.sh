#!/bin/bash

# จำนวนคนดูที่ต้องการเทส
USERS=200
ROOM="channel-2"
API_URL="http://192.168.0.188:8080/api/token"

echo "🚀 [1/2] กำลังยิง API ไปที่ Backend เพื่อจำลองการขอ Token และเพิ่มยอดคนดู..."
for i in $(seq 1 $USERS); do
  curl -s -X POST "$API_URL" \
    -H 'Accept: */*' \
    -H 'Content-Type: application/json' \
    -H 'Origin: http://192.168.0.188:3001' \
    -H 'Referer: http://192.168.0.188:3001/' \
    -H 'User-Agent: LoadTest-Bot/1.0' \
    --data-raw "{\"identity\":\"bot-viewer-$i\",\"room\":\"$ROOM\",\"role\":\"viewer\"}" > /dev/null
    
  echo -n "."
done
echo " เสร็จเรียบร้อย!"
echo ""

echo "📹 [2/2] กำลังเริ่มโหลดเทสสตรีมมิ่งผ่าน LiveKit ($USERS subscribers)..."
livekit-cli load-test \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret devsecret_devsecret_devsecret_12345 \
  --room "$ROOM" \
  --publishers 0 \
  --subscribers "$USERS" \
  --identity-prefix "viewer-" \
  --video-resolution 720p
