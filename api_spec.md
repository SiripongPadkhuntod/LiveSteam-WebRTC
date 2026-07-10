# LocalStream API Specification

This document describes the current Go Control API, the Next.js same-origin proxy (BFF), the compositor diagnostics API, and LiveKit data messages used by the application.

## Endpoints and conventions

- Direct Control API: `http://localhost:8080`
- Browser BFF: same origin as the frontend, normally `http://localhost:3001/api/*`
- Compositor diagnostics: `http://localhost:8090`
- JSON responses use `Content-Type: application/json`.
- JSON errors use `{ "error": "message" }` unless noted.
- Request JSON is strict: unknown fields are rejected by the Go API.
- Token/room/bridge bodies are limited to 1 MiB; scene bodies to 8 MiB; asset files to 5 MiB plus multipart overhead.
- There is currently no application authentication on these HTTP endpoints.

## Control API

### `GET /health`

Returns `200`:

```json
{"status":"ok"}
```

### `POST /api/token`

Creates a LiveKit JWT valid for two hours.

```json
{
  "identity": "camera-1a2b3c4d",
  "room": "room-ab12cd",
  "role": "broadcaster",
  "target": "source"
}
```

| Field | Rules |
|---|---|
| `identity` | required after trimming, max 128 characters |
| `room` | required after trimming, max 128 characters |
| `role` | `broadcaster`, `monitor`, or `viewer` |
| `target` | optional; empty/`source` or `d1` |

Grant matrix:

| Role | join | publish media | subscribe | publish data |
|---|---:|---:|---:|---:|
| broadcaster | yes | yes | yes | yes |
| monitor | yes | no | yes | yes |
| viewer | yes | no | yes | no |

`target=source` signs with Source LiveKit credentials and returns its URL/port 7880. `target=d1` uses D1 credentials and port 7980.

Response `200`:

```json
{"token":"<jwt>","url":"ws://localhost:7880"}
```

Errors: `400` invalid JSON, missing/long identity or room, invalid role, or invalid target; `500` JWT creation failure.

### `POST /api/rooms`

Creates an in-memory room record.

```json
{"name":"Evening Auction"}
```

`name` is trimmed, required, and at most 120 characters. The six-character code uses `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (ambiguous `I`, `O`, `0`, `1` are excluded).

Response `201`:

```json
{
  "id":"room-abc234",
  "name":"Evening Auction",
  "code":"ABC234",
  "studioIdentity":"studio-room-abc234",
  "createdAt":"2026-07-10T12:00:00Z"
}
```

Errors: `400` invalid JSON/name; `500` code generation failure. Records disappear on backend restart.

### `GET /api/rooms`

Without a query, returns `200` and `{ "rooms": [...] }`. Ordering is unspecified; the frontend sorts by `createdAt`.

With `?code=abc-234`, hyphens/outer whitespace are removed and the value is uppercased. Returns the room object directly or `404 {"error":"room code not found"}`.

### `POST /api/bridge`

Idempotently creates an in-process bridge from source room `<room>` to D1 room `<room>-program`.

```json
{"room":"room-abc234"}
```

`room` is trimmed, required, max 128 characters.

Response `200`:

```json
{
  "room":"room-abc234",
  "identity":"program-room-abc234",
  "d1Room":"room-abc234-program",
  "created":true,
  "passthrough":true
}
```

Repeated calls return the same session with `created:false`. Errors: `400` invalid input; `502` missing/unreachable internal LiveKit URLs or connection failure. Sessions have no HTTP stop/delete endpoint.

### `GET /api/scenes/{room}`

`room` must be 1–128 ASCII letters, digits, `-`, or `_`. Returns the Redis/memory scene, or a default scene when none exists:

```json
{
  "id":"room-abc234-main",
  "name":"Main Scene",
  "revision":1,
  "output":{"width":1920,"height":1080,"fps":60},
  "layers":[]
}
```

Errors: `400` invalid room; `503` repository unavailable.

### `PUT /api/scenes/{room}`

Stores one revisioned Program Scene. The server overwrites `id` with `<room>-main` and defaults an empty `name` to `Main Scene`.

```json
{
  "id":"ignored-by-server",
  "name":"Main Scene",
  "revision":2,
  "sourceId":"camera-1a2b3c4d",
  "output":{"width":1920,"height":1080,"fps":60},
  "layers":[{
    "id":"logo","type":"image","name":"logo.png",
    "src":"/api/assets/0123456789abcdef0123456789abcdef.png",
    "x":70,"y":5,"width":25,"height":25,"opacity":1,
    "zIndex":1,"visible":true,"flipH":false,"flipV":false,"rotation":0
  }]
}
```

Validation:

- output must be exactly 1920×1080 at 60 fps;
- at most 64 layers;
- each layer needs non-empty `id`/`name` and `type:"image"`;
- `src` must start with `/` or `data:image/`;
- `x,y >= 0`, `width,height >= 1`, and the rectangle must remain within approximately 0–100%;
- opacity must be 0–1;
- when a stored scene exists, incoming `revision` must be strictly greater.

On success the repository stores the scene and, when Redis-backed, publishes `{"room":...,"scene":...}` to `scene.updates`. Returns `200` with the normalized scene. A stale revision returns `409`:

```json
{"error":"scene revision conflict","scene":{"id":"...","revision":3}}
```

Other errors: `400` invalid room/JSON/scene; `503` repository failure. Concurrency is serialized only per API process; multi-replica Redis compare-and-set is not implemented.

### `POST /api/assets`

Accepts `multipart/form-data` with one `file`. Content is detected from bytes, not trusted from the filename. Supported types are PNG, JPEG, WebP, and GIF; maximum content size is 5 MiB.

Response `201`:

```json
{
  "id":"0123456789abcdef0123456789abcdef.png",
  "url":"/api/assets/0123456789abcdef0123456789abcdef.png",
  "contentType":"image/png",
  "size":12345
}
```

The ID is the first 16 bytes of SHA-256 encoded as 32 lowercase hex characters plus a normalized extension. Uploading identical bytes is idempotent at the file level.

Errors: `400` malformed/missing/empty/oversized upload; `415` unsupported bytes; `500` storage failure.

### `GET /api/assets/{id}`

The ID must match the 32-hex-plus-supported-extension shape and cannot contain path traversal. Returns binary content with detected extension MIME type, `Cache-Control: public, max-age=31536000, immutable`, and `X-Content-Type-Options: nosniff`.

Errors: `400` invalid ID; `404` absent file; `500` read failure.

## Next.js BFF routes

The frontend proxies these same-origin routes to `CONTROL_API_URL` (default `http://127.0.0.1:8080`):

| Route | Methods | Notes |
|---|---|---|
| `/api/token` | POST | forwards JSON; replaces successful `url` with `LIVEKIT_PUBLIC_URL`/`D1_LIVEKIT_PUBLIC_URL`, or derives LAN `ws(s)://host:7880/7980` |
| `/api/rooms` | GET, POST | preserves query string |
| `/api/bridge` | POST | direct JSON proxy |
| `/api/scenes/[room]` | GET, PUT | direct JSON proxy, no-store |
| `/api/assets` | POST | requires multipart and forwards raw body |
| `/api/assets/[id]` | GET | returns binary with immutable cache headers |

Proxy/network failures return localized JSON errors with `502`. Explicit public LiveKit URLs take precedence over host-derived URLs. Host derivation is only used for localhost, loopback, or RFC1918 IPv4 hosts.

## LiveKit application messages

All messages are UTF-8 JSON sent reliably.

### Source room: Studio → bridge/compositor

Destination identities: `bridge-<room>` and `compositor-<room>`.

```json
{"type":"program-start","sourceId":"camera-1a2b3c4d"}
{"type":"program-switch","sourceId":"camera-9e8f7a6b"}
{"type":"program-stop"}
```

Receivers accept messages only when sender identity starts with `studio-`.

### Source room: Studio → one source

```json
{"type":"disconnect-source"}
```

Camera also accepts legacy `disconnect-camera`. The message asks the page to disconnect; it is not server-side participant eviction.

### D1 room: Studio → viewers

```json
{"type":"program-scene","scene":{"id":"...","revision":2,"output":{"width":1920,"height":1080,"fps":60},"layers":[]}}
```

Broadcast on Start/Cut; sent directly to each newly connected `viewer-` participant while Studio is online.

## Compositor diagnostics API

### `GET :8090/health`

Returns `200` with `status`, `mode:"control-runtime"`, and runtime records containing room, revision, visible layer count, asset readiness, Source/D1 connection state, video source count, output readiness, status, and update time.

### `GET :8090/ready`

Returns `200 {"status":"ready"}` after Redis is reachable and existing scenes load; otherwise `503 {"status":"not-ready"}`.

### `GET :8090/metrics`

Prometheus text with `compositor_rooms` and `compositor_rooms_assets_ready`.

## CORS

The Go API permits `GET, POST, PUT, OPTIONS` and headers `Content-Type, Authorization`. Exact origins come from `ALLOWED_ORIGINS` (default localhost ports 3000/3001). When `ALLOW_PRIVATE_ORIGINS=true`, HTTP(S) localhost/private/loopback IP origins are additionally accepted only on ports 3000 or 3001. Requests are still processed when an Origin is not allowed; the browser simply receives no matching CORS header.
