# LocalStream API Specification (ภาษาไทย)

เอกสารนี้อ้างอิงจากโค้ดปัจจุบัน ครอบคลุม Go Control API, Next.js BFF, Compositor diagnostics และข้อความที่ส่งผ่าน LiveKit DataChannel

## ที่อยู่และกติกากลาง

- Control API โดยตรง: `http://localhost:8080`
- BFF ของหน้าเว็บ: origin เดียวกับ frontend ปกติคือ `http://localhost:3001/api/*`
- Compositor diagnostics: `http://localhost:8090`
- Error ทั่วไปเป็น JSON รูป `{"error":"ข้อความ"}`
- Go API ปฏิเสธ JSON field ที่ไม่รู้จัก
- body ของ token/room/bridge ไม่เกิน 1 MiB, scene ไม่เกิน 8 MiB, asset จริงไม่เกิน 5 MiB
- HTTP API เหล่านี้ยังไม่มีระบบ login หรือ room authorization

## Control API

### `GET /health`

ตอบ `200 {"status":"ok"}`

### `POST /api/token`

สร้าง LiveKit JWT อายุ 2 ชั่วโมง

```json
{"identity":"camera-1a2b3c4d","room":"room-ab12cd","role":"broadcaster","target":"source"}
```

| Field | เงื่อนไข |
|---|---|
| `identity` | จำเป็นหลัง trim, ยาวไม่เกิน 128 ตัว |
| `room` | จำเป็นหลัง trim, ยาวไม่เกิน 128 ตัว |
| `role` | `broadcaster`, `monitor`, `viewer` |
| `target` | ไม่ใส่/`source` หรือ `d1` |

| Role | publish media | subscribe | publish data |
|---|---:|---:|---:|
| broadcaster | ได้ | ได้ | ได้ |
| monitor | ไม่ได้ | ได้ | ได้ |
| viewer | ไม่ได้ | ได้ | ไม่ได้ |

`target=source` ใช้ credential/URL ของ Source LiveKit พอร์ต 7880; `target=d1` ใช้ D1 พอร์ต 7980

```json
{"token":"<jwt>","url":"ws://localhost:7880"}
```

Error: `400` JSON/field/role/target ไม่ถูกต้อง, `500` สร้าง JWT ไม่สำเร็จ

### `POST /api/rooms`

```json
{"name":"ประมูลรอบเย็น"}
```

`name` ต้องมีค่าและไม่เกิน 120 ตัว ระบบสร้าง code 6 ตัวจาก `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` ซึ่งตัดอักขระที่สับสนออก

ตอบ `201`:

```json
{
  "id":"room-abc234","name":"ประมูลรอบเย็น","code":"ABC234",
  "studioIdentity":"studio-room-abc234","createdAt":"2026-07-10T12:00:00Z"
}
```

Room อยู่ใน memory และหายเมื่อ backend restart Error: `400` input ไม่ถูกต้อง, `500` สุ่ม code ไม่สำเร็จ

### `GET /api/rooms`

- ไม่มี query: ตอบ `{"rooms":[...]}` โดยลำดับไม่รับประกัน; frontend เป็นผู้ sort ตาม `createdAt`
- `?code=abc-234`: trim, ลบ `-`, แปลง uppercase แล้วคืน room object โดยตรง
- ไม่พบ code: `404 {"error":"room code not found"}`

### `POST /api/bridge`

สร้าง/ยืนยัน in-process RTP Bridge จาก `<room>` ไป `<room>-program` แบบ idempotent

```json
{"room":"room-abc234"}
```

`room` จำเป็นและไม่เกิน 128 ตัว ตอบ `200`:

```json
{
  "room":"room-abc234","identity":"program-room-abc234",
  "d1Room":"room-abc234-program","created":true,"passthrough":true
}
```

เรียกซ้ำได้ `created:false` Error: `400` input ผิด, `502` URL/การเชื่อม LiveKit ผิดพลาด ปัจจุบันไม่มี DELETE/stop endpoint สำหรับ session

### `GET /api/scenes/{room}`

`room` ต้องยาว 1–128 ตัวและใช้เฉพาะ ASCII letter, digit, `-`, `_` ถ้ายังไม่มีข้อมูลจะคืน default:

```json
{
  "id":"room-abc234-main","name":"Main Scene","revision":1,
  "output":{"width":1920,"height":1080,"fps":60},"layers":[]
}
```

Error: `400` room ผิดรูปแบบ, `503` repository ใช้งานไม่ได้

### `PUT /api/scenes/{room}`

เก็บ Program Scene เดียวต่อห้อง Server บังคับ `id=<room>-main` และเติม `name="Main Scene"` เมื่อว่าง

```json
{
  "id":"ค่าถูกแทนโดย server","name":"Main Scene","revision":2,
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

- output ต้องเป็น 1920×1080 60 fps เท่านั้น
- ไม่เกิน 64 layers
- ทุก layer ต้องมี `id`, `name`, `type:"image"`
- `src` ต้องขึ้นต้น `/` หรือ `data:image/`
- `x,y >= 0`, `width,height >= 1` และกรอบต้องไม่เลยประมาณ 100%
- `opacity` อยู่ 0–1
- ถ้ามีข้อมูลเดิม `revision` ใหม่ต้องมากกว่าเดิม

เมื่อสำเร็จจะเก็บ Redis/memory และถ้าใช้ Redis จะ publish `{"room":...,"scene":...}` ไป channel `scene.updates` แล้วตอบ `200` ด้วย scene ที่ normalize แล้ว

Revision ซ้ำ/เก่าตอบ `409` พร้อม scene ปัจจุบัน:

```json
{"error":"scene revision conflict","scene":{"id":"...","revision":3}}
```

Error อื่น: `400` room/JSON/scene ผิด, `503` store ล้มเหลว Lock ป้องกัน concurrent update ได้เฉพาะใน API process เดียว ยังไม่มี Redis CAS สำหรับหลาย replica

### `POST /api/assets`

รับ `multipart/form-data` field `file` ตรวจชนิดจาก bytes รองรับ PNG, JPEG, WebP, GIF และไฟล์จริงไม่เกิน 5 MiB

ตอบ `201`:

```json
{
  "id":"0123456789abcdef0123456789abcdef.png",
  "url":"/api/assets/0123456789abcdef0123456789abcdef.png",
  "contentType":"image/png","size":12345
}
```

ID คือ 16 bytes แรกของ SHA-256 แปลงเป็น hex 32 ตัวพร้อม extension มาตรฐาน ไฟล์ bytes เหมือนกันได้ path เดิม

Error: `400` multipart/file/size ผิด, `415` ไม่ใช่ชนิดที่รองรับ, `500` เขียน storage ไม่สำเร็จ

### `GET /api/assets/{id}`

ID ต้องเป็น hex 32 ตัวและ `.png/.jpg/.webp/.gif` เท่านั้น ตอบ binary พร้อม `Cache-Control: public, max-age=31536000, immutable` และ `X-Content-Type-Options: nosniff`

Error: `400` ID ผิด, `404` ไม่พบ, `500` อ่านไม่ได้

## Next.js BFF

Frontend proxy ไป `CONTROL_API_URL` ซึ่ง default เป็น `http://127.0.0.1:8080`

| Route | Method | พฤติกรรมเพิ่มจาก Control API |
|---|---|---|
| `/api/token` | POST | แทน `url` ด้วย `LIVEKIT_PUBLIC_URL`/`D1_LIVEKIT_PUBLIC_URL`; ถ้าไม่มีจึง derive URL สำหรับ LAN |
| `/api/rooms` | GET, POST | ส่ง query เดิมไป upstream |
| `/api/bridge` | POST | proxy JSON |
| `/api/scenes/[room]` | GET, PUT | proxy JSON แบบ no-store |
| `/api/assets` | POST | บังคับ multipart แล้วส่ง raw body |
| `/api/assets/[id]` | GET | proxy binary พร้อม immutable cache |

เชื่อม backend ไม่ได้ตอบ localized error `502` Explicit public URL มีลำดับสำคัญสูงสุด ส่วน host-derived URL ใช้เฉพาะ localhost, loopback หรือ private IPv4

## LiveKit DataChannel messages

ทุกข้อความเป็น UTF-8 JSON แบบ reliable

### Studio → Bridge/Compositor ใน Source room

ส่งตรงไป `bridge-<room>` และ `compositor-<room>`:

```json
{"type":"program-start","sourceId":"camera-1a2b3c4d"}
{"type":"program-switch","sourceId":"camera-9e8f7a6b"}
{"type":"program-stop"}
```

Receiver รับเฉพาะ sender identity ที่ขึ้นต้น `studio-`

### Studio → Source รายตัว

```json
{"type":"disconnect-source"}
```

หน้า Camera รองรับชื่อเดิม `disconnect-camera` ด้วย นี่คือคำขอให้หน้า source disconnect เอง ไม่ใช่ server-side eviction

### Studio → Viewer ใน D1 room

```json
{"type":"program-scene","scene":{"id":"...","revision":2,"output":{"width":1920,"height":1080,"fps":60},"layers":[]}}
```

ส่ง broadcast ตอน Start/Cut และส่งแบบเจาะจงให้ Viewer ใหม่ที่ identity ขึ้นต้น `viewer-` ขณะ Studio online

## Compositor API พอร์ต 8090

- `GET /health`: `200` พร้อม `mode:"control-runtime"` และสถานะแต่ละ room เช่น revision, visible layers, asset readiness, Source/D1 connection, video source count และ output readiness
- `GET /ready`: `200 {"status":"ready"}` หลัง Redis พร้อมและโหลด Scene เดิมเสร็จ มิฉะนั้น `503`
- `GET /metrics`: Prometheus text มี `compositor_rooms` และ `compositor_rooms_assets_ready`

## CORS

Go API อนุญาต method `GET, POST, PUT, OPTIONS` และ header `Content-Type, Authorization` Origin แบบ exact มาจาก `ALLOWED_ORIGINS` ค่าเริ่มต้นคือ localhost พอร์ต 3000/3001 เมื่อ `ALLOW_PRIVATE_ORIGINS=true` จะเพิ่ม HTTP(S) localhost/private/loopback IP แต่ยังจำกัดพอร์ต 3000/3001 หาก origin ไม่ผ่าน request ยังถูกประมวลผล แต่ browser จะไม่เห็น CORS header ที่ยอมรับ origin นั้น

ฉบับภาษาอังกฤษและรายละเอียดเดียวกัน: [api_spec.md](api_spec.md)
