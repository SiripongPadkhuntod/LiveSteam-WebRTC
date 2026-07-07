# LocalStream

Local WebRTC broadcast studio with two camera previews, one switchable program feed, and a return monitor that subscribes through the SFU.

## Architecture

- **Frontend:** Next.js + TypeScript + LiveKit Client
- **Control API:** Go; creates short-lived, role-limited LiveKit tokens
- **Source media:** LiveKit SFU + Redis receives raw camera/microphone sources for Studio
- **D1 simulator:** a second isolated LiveKit SFU + Redis pair receives exactly one Program Publisher Session and serves viewers
- **Room codes:** Studio creates a room and shares its six-character code with camera devices
- **Camera sources:** each `/camera` page enters a room code and publishes directly into that LiveKit room
- **Microphone sources:** each `/microphone` page enters a room code and publishes audio without video
- **Studio input:** subscribes to raw camera and microphone sources from the private Source Room
- **Program bridge:** Go subscribes to the selected H.264 source on the Source SFU and forwards its RTP packets to D1 without browser Canvas capture or a second video encode
- **Output publisher:** the Go bridge is the only D1 publisher; one participant/session publishes `program-video` and `program-audio` under stream `program`
- **Video switching:** Studio sends a reliable control message to the bridge; the bridge requests an IDR keyframe and preserves RTP sequence/timestamp continuity across cameras
- **Audio mixer:** Studio selects any combination of camera and microphone audio, adjusts per-source volume, publishes one mixed track to the Source SFU, and the Go bridge forwards it to D1
- **Program monitor:** Studio joins D1 as a subscribe-only participant and sees the same Program tracks as viewers
- **Viewer:** joins only the Program Room on D1 and selectively subscribes to `program-video` and `program-audio`; it never joins the Source SFU

## Requirements

- Node.js 20+
- Go 1.24+
- Docker with Docker Compose
- One or more camera devices connected to Macs, iPhones, or other source computers

## Run locally

Open three terminals from the repository root.

```bash
make infra-up
```

```bash
make backend
```

```bash
cd frontend
npm install
npm run dev
```

Open:

- Studio: http://localhost:3000/studio
- Viewer: http://localhost:3000/watch
- Camera source: http://localhost:3000/camera
- Channels: http://localhost:3000/channels
- API health: http://localhost:8080/health

Local WebRTC endpoints:

- Source SFU signaling/TCP/UDP: `7880` / `7881` / `7882`
- D1 signaling/TCP/UDP: `7980` / `7981` / `7982`
- LAN HTTPS application: `3443`
- Source/D1 secure signaling gateways: `7443` / `7444`

Open `/channels`, create a broadcast room, and share the generated six-character code with each source device. On `/camera`, enter that code for video and camera audio; use `/microphone` for an audio-only source. Cameras and microphones publish directly into the room. Studio selects the Program video and mixes the required audio sources before starting the broadcast. Viewers receive only the Program tracks.

Room records are currently stored in Go process memory for local development. Restarting the Go backend clears the room list and invalidates previously generated codes.

## Local network testing from a phone or another computer

`make infra-up` detects the host LAN IP and starts Caddy with locally trusted HTTPS for the application plus WSS gateways for both LiveKit servers. WebRTC media does not pass through Caddy; it continues directly over the LiveKit UDP/TCP media ports.

The first time a device connects, install Caddy's local CA certificate:

1. Keep the server and device on the same Wi-Fi/LAN.
2. Run `make infra-up` and note the LAN IP printed by the command.
3. On the other device, open `http://LAN_IP:8081/root.crt` and install the certificate.
4. On iPhone/iPad, also enable it under **Settings > General > About > Certificate Trust Settings**.
5. Open `https://LAN_IP:3443/camera` or `https://LAN_IP:3443/microphone`.

For example, if the server prints `192.168.1.10`:

```text
Certificate: http://192.168.1.10:8081/root.crt
Camera:      https://192.168.1.10:3443/camera
Microphone:  https://192.168.1.10:3443/microphone
Studio:      https://192.168.1.10:3443/studio
Viewer:      https://192.168.1.10:3443/watch
```

Allow inbound TCP `3443`, `7443`, `7444`, `7881`, `7981`, `8081` and UDP `7882`, `7982` in the host firewall. The certificate is only for LAN development; do not distribute Caddy's CA private key. Internet clients still require a public deployment and TURN.

## Configuration

The checked-in credentials are development-only. Override them before using any shared environment:

```bash
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret_devsecret_devsecret_12345
LIVEKIT_URL=
D1_LIVEKIT_API_KEY=d1key
D1_LIVEKIT_API_SECRET=d1secret_d1secret_d1secret_12345
D1_LIVEKIT_URL=
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
ALLOW_PRIVATE_ORIGINS=true
```

Frontend API URL:

```bash
# Leave unset to use the same-origin Next.js proxy at /api/token.
NEXT_PUBLIC_API_URL=
CONTROL_API_URL=http://127.0.0.1:8080
# Set this when LiveKit signaling is exposed through HTTPS/WSS.
LIVEKIT_PUBLIC_URL=
D1_LIVEKIT_PUBLIC_URL=
```

## Test a camera through Microsoft Dev Tunnels

Expose both frontend port `3001` and LiveKit signaling port `7880` on the same tunnel. The browser calls `/api/token` on port 3001, so port 8080 does not need a public tunnel.

Before starting Next.js, configure the public WSS endpoint generated for port 7880:

```bash
cd frontend
LIVEKIT_PUBLIC_URL=wss://YOUR-TUNNEL-ID-7880.REGION.devtunnels.ms npm run dev -- -p 3001
```

Then open the HTTPS URL for port 3001. Restart Next.js whenever `LIVEKIT_PUBLIC_URL` changes.

This local setup still advertises the Mac's LAN address for WebRTC media over UDP 7882, so camera devices must be on the same LAN. Devices outside that LAN require a publicly reachable LiveKit deployment or TURN server; tunneling only the web page is not enough.

Never expose the LiveKit API secret in frontend code.

## Viewer on another device in the LAN

Use the same HTTPS entry point, for example `https://192.168.1.10:3443/watch`. Viewers receive secure D1 signaling through port `7444`, while D1 media travels over UDP `7982` with TCP `7981` as the fallback.
