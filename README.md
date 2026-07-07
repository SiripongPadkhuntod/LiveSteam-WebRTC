# LocalStream

Local WebRTC broadcast studio with two camera previews, one switchable program feed, and a return monitor that subscribes through the SFU.

## Architecture

- **Frontend:** Next.js + TypeScript + LiveKit Client
- **Control API:** Go; creates short-lived, role-limited LiveKit tokens
- **Media:** LiveKit SFU + Redis, running locally with Docker Compose
- **Room codes:** Studio creates a room and shares its six-character code with camera devices
- **Camera sources:** each `/camera` page enters a room code and publishes directly into that LiveKit room
- **Microphone sources:** each `/microphone` page enters a room code and publishes audio without video
- **Studio input:** subscribes to raw camera and microphone sources from the private Source Room
- **Output publisher:** a separate LiveKit participant/session publishes `program-video` and `program-audio` together into an isolated Program Room
- **Audio mixer:** Studio selects any combination of camera and microphone audio, adjusts per-source volume, and mixes them into one `program-audio` track
- **Program monitor:** a separate subscribe-only LiveKit connection in the studio page
- **Viewer:** joins only the Program Room and selectively subscribes to `program-video` and `program-audio`; it never joins the raw Source Room

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

Open `/channels`, create a broadcast room, and share the generated six-character code with each source device. On `/camera`, enter that code for video and camera audio; use `/microphone` for an audio-only source. Cameras and microphones publish directly into the room. Studio selects the Program video and mixes the required audio sources before starting the broadcast. Viewers receive only the Program tracks.

Room records are currently stored in Go process memory for local development. Restarting the Go backend clears the room list and invalidates previously generated codes.

## Local network testing

`localhost` is a browser secure context, but a LAN IP over plain HTTP is not. To test from phones or other computers, put the frontend, API, and LiveKit signaling endpoint behind locally trusted HTTPS/WSS (for example with `mkcert` and Caddy), advertise the host LAN IP to LiveKit, and allow TCP 7880/7881 plus UDP 7882 through the host firewall.

## Configuration

The checked-in credentials are development-only. Override them before using any shared environment:

```bash
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret_devsecret_devsecret_12345
LIVEKIT_URL=
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

Run `make infra-up`; it detects the Mac LAN address and configures LiveKit to advertise that address. Start the frontend on all interfaces, then open the viewer URL from another device using the Mac IP, for example:

```text
http://192.168.1.10:3001/watch
```

The viewer page works over LAN HTTP. Camera and microphone capture on a non-localhost device requires HTTPS because browsers only expose `getUserMedia` in a secure context.
