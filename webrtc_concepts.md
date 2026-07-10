# WebRTC Concepts ของ LocalStream

เอกสารนี้อธิบายแนวคิด WebRTC โดยผูกกับสิ่งที่โค้ดทำจริง ไม่ใช่คำอธิบาย WebRTC ทั่วไปเพียงอย่างเดียว

## 1. Signaling กับ Media เป็นคนละเส้นทาง

การ `room.connect(url, token)` เริ่มจาก WebSocket signaling เพื่อเข้าห้อง แลกข้อมูล participant/track และตกลงการเชื่อมต่อ แต่ภาพและเสียงหลังจากนั้นวิ่งผ่าน WebRTC transport โดยตรงไป LiveKit

ใน LAN stack:

- Caddy รับ WSS ที่ `:7443` แล้ว proxy ไป Source LiveKit `:7880`
- Caddy รับ WSS ที่ `:7444` แล้ว proxy ไป D1 `:7980`
- media ใช้ UDP `7882/7982` เป็นหลัก หรือ TCP `7881/7981` เมื่อจำเป็น

ดังนั้นเปิดแค่ HTTPS/WSS port ไม่พอ ถ้า firewall ปิด media ports การเข้าห้องอาจสำเร็จแต่ภาพ/เสียงไม่มา

## 2. ICE, candidate และ LAN IP

WebRTC ต้องหา address ที่คู่สื่อสารเข้าถึงได้ LiveKit ถูกสั่ง `--node-ip ${LIVEKIT_NODE_IP}` เพื่อประกาศ LAN IP จริงของ host แทน IP ภายใน container หากประกาศ `127.0.0.1` ให้มือถือ มือถือจะพยายามเชื่อมกลับหาตัวเอง

โปรเจกต์นี้ไม่มี TURN server และตั้ง `use_external_ip:false` จึงเหมาะกับเครื่องใน LAN เดียวกันมากกว่าการข้าม NAT/อินเทอร์เน็ต Production ที่มีผู้ใช้ภายนอกมักต้องมี public candidate, firewall rules และ TURN fallback

## 3. TLS และ Secure Context

เบราว์เซอร์มือถืออนุญาต `getUserMedia()` บน secure context หน้า LAN จึงใช้ Caddy Local CA:

1. ดาวน์โหลด `http://<LAN_IP>:8081/root.crt`
2. ติดตั้งและ Trust CA บนอุปกรณ์
3. เปิดแอปผ่าน `https://<LAN_IP>:3443`

การ Trust หน้าเว็บอย่างเดียวไม่พอ WSS signaling ที่ `:7443/:7444` ใช้ certificate จาก CA เดียวกัน จึงต้อง Trust CA ระดับอุปกรณ์

## 4. LiveKit SFU ไม่ใช่ Database และไม่ใช่ Video Mixer

SFU รับ RTP จาก publisher แล้ว forward ให้ subscriber โดยปกติไม่ถอดรหัสภาพและไม่รวมหลายภาพเป็นเฟรมใหม่ LocalStream ใช้ SFU สองชุด:

- Source SFU: มี camera/microphone, Studio, Bridge และ Compositor เป็นพื้นที่หลังบ้าน
- D1 SFU: มี Program publisher, Studio monitor และ Viewer เป็นพื้นที่ผู้ชม

การแยกห้องลดโอกาสที่ Viewer จะ subscribe กล้องดิบโดยไม่ได้ตั้งใจ Viewer ได้ token ของ D1 room `<source-room>-program` เท่านั้น อย่างไรก็ตามนี่เป็น architecture isolation ไม่ใช่ security boundary ที่สมบูรณ์ เพราะ Token API ยังไม่มีการยืนยันผู้ใช้

## 5. Track, publication, participant และชื่อที่ระบบพึ่งพา

โค้ดตัดสินบทบาทจาก prefix/name หลายจุด:

| สิ่ง | รูปแบบปัจจุบัน |
|---|---|
| Camera identity | `camera-<random>` |
| Microphone identity | `microphone-<random>` |
| Studio source identity | `studio-<room>` |
| Bridge identity | `bridge-<room>` |
| Compositor identity | `compositor-<room>` |
| Viewer identity | `viewer-<random>` |
| Camera video | `camera-video` |
| Camera audio | `camera-audio` |
| Mic audio | `microphone-audio` |
| Studio mixed audio | `program-mix-audio` |
| Bridge outputs | `program-video`, `program-audio` |
| Compositor output | `compositor-preview-video` |

เปลี่ยนชื่อเหล่านี้โดยแก้เพียงฝั่งเดียวจะทำให้ subscription, bridge forwarding, viewer count หรือ control message หยุดทำงาน

## 6. H.264 single encoding และเหตุผลที่ปิด simulcast

Camera ขอ 1920×1080/30, H.264, bitrate สูงสุด 6 Mbps และปิด simulcast/dynacast สำหรับ publication หลัก จุดประสงค์คือให้ Bridge และ Compositor ได้ bitstream ที่ต่อเนื่อง ไม่เกิดการเปลี่ยน simulcast layer ซึ่งอาจเปลี่ยน SPS/PPS หรือคุณสมบัติ decoder กลาง session

Studio ยังเรียก `setVideoQuality(HIGH/LOW)` เพื่อบอกความต้องการ แต่ source publication เป็น single encoding จึงไม่มีหลาย simulcast layers ให้เลือกจริงเหมือนระบบ simulcast เต็มรูปแบบ ข้อความใน UI/เอกสารต้องไม่รับประกันว่าจะประหยัด bandwidth ด้วย low layer ใน configuration นี้

## 7. RTP passthrough และความต่อเนื่องเมื่อ Cut

Bridge subscribe `camera-video` ของทุกกล้อง แต่ forward เฉพาะ `activeSource` ไป D1 โดยสร้าง local RTP track ชื่อ `program-video` ข้อดีคือไม่มี decode/encode เพิ่ม จึงลด latency และ CPU รวมทั้งรักษาคุณภาพจาก source

ปัญหาคือ RTP ของกล้องแต่ละตัวมี sequence number, timestamp และ SSRC context ของตัวเอง หากต่อแพ็กเก็ตดิบทันที decoder ปลายทางอาจเห็นลำดับกระโดดและภาพอ้างอิงจากคนละกล้อง

เมื่อ Start/Switch Bridge จึง:

1. ตั้ง `waitKeyframe=true`
2. ส่ง RTCP PLI ไปกล้องที่เลือกทุก 250 ms สูงสุด 3 วินาที
3. buffer แพ็กเก็ตของ timestamp ปัจจุบันจนพบ H.264 IDR
4. เริ่มส่งตั้งแต่ access unit ที่มี IDR
5. เขียน sequence ต่อทีละหนึ่งและ map timestamp ต่อจาก output เดิม (video step เริ่มต้น 3000 ที่ clock 90 kHz)
6. ลบ RTP header extensions ก่อนส่ง output

ตัวตรวจ IDR รองรับ single NAL type 5, STAP-A และ FU-A start เท่านั้น ดังนั้นเส้นทางนี้ผูกกับ H.264 อย่างชัดเจน

## 8. RTCP PLI/FIR จาก Viewer ย้อนถึง Source

เมื่อ Viewer เข้าระหว่าง GOP อาจต้องรอ keyframe `programRTPTrack` จึงอ่าน RTCP feedback ของ downstream track หากพบ PLI หรือ FIR จะเรียก `requestActiveKeyframe()` แล้วส่ง PLI ต่อไปยังกล้อง active ผ่าน Source LiveKit กลไกนี้ช่วยลดจอดำสำหรับ Viewer ที่เข้ากลางรายการ

## 9. Audio mixing อยู่ใน Browser

Studio subscribe audio ของ camera/microphone แล้วใช้ Web Audio graph:

```text
Remote audio track -> MediaStreamSource -> GainNode -> MediaStreamDestination
```

เฉพาะ source ที่ `enabled` จะต่อเข้า destination ค่า volume 0–100 ถูกแปลงเป็น gain 0–1 จากนั้น `LocalAudioTrack` ของ destination ถูก publish กลับ Source room ชื่อ `program-mix-audio` Bridge subscribe track นี้และ passthrough เป็น `program-audio` ที่ D1

ผลตามมา:

- Studio browser เป็นส่วนหนึ่งของ media plane ไม่ใช่แค่รีโมตคอนโทรล
- ปิดแท็บ/AudioContext ล้มเหลวแล้ว Program Audio หยุด
- การ mute Program Audio คือ mute publication/output ไม่ได้หยุด camera source เดิม
- browser autoplay policy อาจบล็อกเสียง monitor/viewer จึงมีปุ่มเปิดเสียงอีกครั้ง

## 10. DataChannel และ reliability

LiveKit `publishData(..., {reliable:true})` ใช้ส่ง control/scene JSON:

- Source room: `program-start`, `program-switch`, `program-stop`, `disconnect-source`
- D1 room: `program-scene`

Reliable เหมาะกับ state/control ที่ไม่ควรหาย ต่างจาก media RTP ที่ยอมทิ้งแพ็กเก็ตเก่าเพื่อรักษาเวลาจริง Scene snapshot มีขนาดเล็กกว่า media มาก แต่ไม่ควรใช้ DataChannel ส่งไฟล์ภาพ จึง upload asset ผ่าน HTTP แล้วส่งเพียง URL ใน Scene

## 11. Scene overlay: metadata plane กับ pixel plane

เส้นทางหลักแยกเป็น:

- pixel plane: `program-video` จาก Bridge
- metadata plane: `program-scene` จาก Studio
- Viewer ใช้ React/CSS วาง `<img>` ตาม `x/y/width/height` เปอร์เซ็นต์, opacity, z-index, flip และ rotation ทับวิดีโอ

ข้อดีคือ Bridge ไม่ต้อง encode ใหม่ แต่ภาพที่บันทึกจาก track โดยตรงไม่มี overlay และอุปกรณ์ Viewer แต่ละเครื่องเป็นผู้ render กราฟิกเอง

Reference Compositor เป็นอีกแนวทาง: อ่าน Scene จาก Redis, ส่งกล้องที่เลือกเข้า FFmpeg, scale/pad เป็น 1920×1080, overlay asset แล้ว encode H.264 60 fps เป็น `compositor-preview-video` นี่คือ pixel composition จริงแต่เพิ่ม CPU, latency และ re-encode ปัจจุบัน Viewer/Studio เลือก `program-video` ก่อนและใช้ compositor output เฉพาะเมื่อ direct track ไม่มี

## 12. Subscription permission และสิ่งที่มันป้องกัน

Camera จำกัด subscriber ที่อนุญาตไว้เป็น Studio identity, Bridge และ Compositor ส่วน microphone-only อนุญาต Studio เท่านั้น ช่วยไม่ให้ participant อื่นใน Source room subscribe track ได้ตามใจ แต่:

- permission ถูกตั้งหลัง connect
- identity string ต้องตรงกับที่ room creation/Studio ใช้
- ยังต้องป้องกัน Token API และ credential ฝั่ง server

## 13. Latency, quality และ scale

Latency โดยรวมเกิดจาก capture/encode, network, SFU forwarding, keyframe wait ตอน Cut, jitter buffer, decode/render และ AudioContext ส่วน Bridge passthrough ตัดขั้น decode/encode ฝั่ง server ออก แต่ไม่ทำให้ latency เป็นศูนย์

จำนวน Viewer เพิ่มภาระ egress และ WebRTC connection ที่ D1 ไม่ได้เพิ่ม upload จาก Camera โดยตรง Source SFU/Bridge มี stream หลักเพียงไม่กี่เส้น แต่การรองรับผู้ชมจำนวนมากยังต้องวัด CPU, bandwidth, packet loss, ICE success และ LiveKit node capacity จริง `load-test.sh` จึงแยก token load test จาก LiveKit subscriber test

## 14. สิ่งที่ควรเพิ่มก่อน Production

- authentication และ authorization ก่อนออก token/สร้าง bridge
- TURN/TLS/public networking ที่เหมาะกับผู้ใช้นอก LAN
- persistent room store และ distributed bridge ownership/cleanup
- rate limit, request tracing, metrics ของ Control API/Bridge
- codec negotiation/fallback ที่ระบุชัด หรือบังคับ H.264 end-to-end อย่างตรวจสอบได้
- Scene state synchronization ที่มี source of truth เดียวและ Redis CAS สำหรับหลาย API replicas
- strategy เมื่อ Studio browser ปิด เช่น server-side audio mixer หรือ supervised producer client
