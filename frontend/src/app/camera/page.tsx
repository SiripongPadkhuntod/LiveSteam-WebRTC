"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectionState, LocalVideoTrack, Room, RoomEvent, Track, VideoPresets } from "livekit-client";
import { findRoomByCode, getConnectionToken, participantID, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Camera, Video, MonitorOff, UserX, Square, Info, MonitorUp, FileVideo, SwitchCamera } from "lucide-react";

type SourceType = "camera" | "screen" | "file";
type CameraFacingMode = "user" | "environment";

const cameraResolution = { width: 1920, height: 1080, frameRate: 30 };

function cameraVideoConstraints(facingMode: CameraFacingMode): MediaTrackConstraints {
  return {
    width: { ideal: cameraResolution.width },
    height: { ideal: cameraResolution.height },
    frameRate: { ideal: cameraResolution.frameRate, max: cameraResolution.frameRate },
    facingMode: { ideal: facingMode },
  };
}

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const identityRef = useRef("");
  const mediaElementRef = useRef<HTMLVideoElement | HTMLCanvasElement | null>(null);
  const drawLoopRef = useRef<number>(0);

  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [message, setMessage] = useState("กรอก Room Code เพื่อเชื่อมต่อเข้าห้อง");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<BroadcastRoom | null>(null);
  const [cameraName, setCameraName] = useState("Source");

  const [sourceType, setSourceType] = useState<SourceType>("camera");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [cameraFacingMode, setCameraFacingMode] = useState<CameraFacingMode>("environment");
  const [switchingCamera, setSwitchingCamera] = useState(false);

  useEffect(() => {
    identityRef.current = participantID("camera");
    const shortID = identityRef.current.split("-").pop()?.substring(0, 4).toUpperCase();
    setCameraName(`Source-${shortID}`);
  }, []);

  useEffect(() => () => {
    void stopCamera();
  }, []);

  async function getStreamFromSource(): Promise<MediaStream> {
    if (sourceType === "camera") {
      return await navigator.mediaDevices.getUserMedia({
        video: cameraVideoConstraints(cameraFacingMode),
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } else if (sourceType === "screen") {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } else if (sourceType === "file") {
      if (!mediaFile) throw new Error("กรุณาเลือกไฟล์ Media ก่อน");
      const url = URL.createObjectURL(mediaFile);
      if (mediaFile.type.startsWith("video/")) {
        const vid = document.createElement("video");
        vid.src = url;
        vid.loop = true;
        vid.crossOrigin = "anonymous";
        vid.muted = false;
        await vid.play().catch(() => {
          vid.muted = true;
          return vid.play();
        });
        mediaElementRef.current = vid;
        return (vid as unknown as { captureStream: () => MediaStream }).captureStream();
      } else if (mediaFile.type.startsWith("image/")) {
        const img = new window.Image();
        img.src = url;
        await new Promise((resolve) => { img.onload = resolve; });
        const canvas = document.createElement("canvas");
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext("2d");
        const stream = (canvas as unknown as { captureStream: (fps: number) => MediaStream }).captureStream(30);
        const draw = () => {
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.fillStyle = "black";
            ctx.fillRect(0,0, canvas.width, canvas.height);
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            const x = (canvas.width - w) / 2;
            const y = (canvas.height - h) / 2;
            ctx.drawImage(img, x, y, w, h);
          }
          drawLoopRef.current = requestAnimationFrame(draw);
        };
        draw();
        mediaElementRef.current = canvas;
        return stream;
      } else {
        throw new Error("รองรับเฉพาะไฟล์รูปภาพหรือวิดีโอเท่านั้น");
      }
    }
    throw new Error("ไม่รู้จักประเภทของ Source");
  }

  async function startCamera() {
    const normalizedCode = roomCode.trim().replaceAll("-", "").toUpperCase();
    if (!normalizedCode) {
      setStatus("error");
      setMessage("กรุณากรอก Room Code");
      return;
    }

    setStatus("connecting");
    setMessage("กำลังตรวจสอบ Room Code…");
    try {
      const roomInfo = await findRoomByCode(normalizedCode);
      setRoomCode(roomInfo.code);
      setMessage("กำลังโหลด Source…");

      const stream = await getStreamFromSource();
      localStream.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      await connectToRoom(roomInfo);
      setConnectedRoom(roomInfo);
      setStatus("connected");
      setMessage(`เชื่อมต่อ ${roomInfo.name} แล้ว`);
    } catch (error) {
      await stopCamera();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ");
    }
  }

  async function connectToRoom(roomInfo: BroadcastRoom) {
    const credentials = await getConnectionToken(identityRef.current, roomInfo.id, "broadcaster");
    const room = new Room({ adaptiveStream: false, dynacast: true });

    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => setConnectionState(state));
    room.on(RoomEvent.Disconnected, () => setConnectionState("Disconnected"));
    room.on(RoomEvent.DataReceived, async (payload) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type === "disconnect-camera" || data.type === "disconnect-source") {
          await stopCamera();
          setMessage("Studio นำ Source นี้ออกจากห้องแล้ว");
        }
      } catch (error) {
        console.error("Invalid camera control message", error);
      }
    });

    await room.connect(credentials.url, credentials.token);
    roomRef.current = room;

    room.localParticipant.setTrackSubscriptionPermissions(false, [
      { participantIdentity: roomInfo.studioIdentity, allowAll: true },
      { participantIdentity: `bridge-${roomInfo.id}`, allowAll: true },
      { participantIdentity: `compositor-${roomInfo.id}`, allowAll: true },
    ]);

    const videoTrack = localStream.current?.getVideoTracks()[0];
    const audioTrack = localStream.current?.getAudioTracks()[0];
    if (!videoTrack) throw new Error("ไม่พบ Video Track จาก Source");

    videoTrack.contentHint = "detail";
    const localVideoTrack = new LocalVideoTrack(
      videoTrack,
      sourceType === "camera" ? cameraVideoConstraints(cameraFacingMode) : undefined,
      sourceType !== "camera",
    );

    await room.localParticipant.publishTrack(localVideoTrack, {
      name: "camera-video",
      source: Track.Source.Camera,
      simulcast: true,
      videoCodec: "h264",
      backupCodec: false,
      degradationPreference: "maintain-resolution",
      videoEncoding: {
        ...VideoPresets.h1080.encoding,
        maxBitrate: 6_000_000,
        maxFramerate: 30,
        priority: "high",
      },
    });
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack.clone(), {
        name: "camera-audio",
        source: Track.Source.Microphone,
      });
    }
  }

  async function switchMobileCamera() {
    if (sourceType !== "camera" || switchingCamera) return;
    const nextFacingMode: CameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";

    if (status !== "connected") {
      setCameraFacingMode(nextFacingMode);
      return;
    }

    const publishedTrack = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
    if (!publishedTrack) {
      setMessage("ไม่พบ Video Track สำหรับสลับกล้อง");
      return;
    }

    setSwitchingCamera(true);
    setMessage(`กำลังเปลี่ยนเป็น${nextFacingMode === "environment" ? "กล้องหลัง" : "กล้องหน้า"}…`);
    try {
      await publishedTrack.restartTrack({
        facingMode: nextFacingMode,
        resolution: cameraResolution,
        frameRate: cameraResolution.frameRate,
      });
      syncPreviewTrack(publishedTrack.mediaStreamTrack);
      setCameraFacingMode(nextFacingMode);
      setMessage(`เปลี่ยนเป็น${nextFacingMode === "environment" ? "กล้องหลัง" : "กล้องหน้า"}แล้ว`);
    } catch (error) {
      // restartTrack stops the old camera before acquiring the new one (needed
      // by mobile Safari), so make one best-effort attempt to restore it.
      try {
        await publishedTrack.restartTrack({
          facingMode: cameraFacingMode,
          resolution: cameraResolution,
          frameRate: cameraResolution.frameRate,
        });
        syncPreviewTrack(publishedTrack.mediaStreamTrack);
      } catch {
        // Preserve the original switch error; reconnecting remains available.
      }
      setMessage(error instanceof Error ? error.message : "เปลี่ยนกล้องไม่สำเร็จ");
    } finally {
      setSwitchingCamera(false);
    }
  }

  function syncPreviewTrack(videoTrack: MediaStreamTrack) {
    const stream = localStream.current;
    if (!stream) return;
    stream.getVideoTracks().forEach((track) => stream.removeTrack(track));
    stream.addTrack(videoTrack);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.srcObject = stream;
    }
  }

  async function stopCamera() {
    roomRef.current?.disconnect();
    roomRef.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    if (drawLoopRef.current) cancelAnimationFrame(drawLoopRef.current);
    if (mediaElementRef.current && mediaElementRef.current instanceof HTMLVideoElement) {
      mediaElementRef.current.pause();
      mediaElementRef.current.removeAttribute("src");
      mediaElementRef.current.load();
    }
    mediaElementRef.current = null;

    setStatus("idle");
    setConnectedRoom(null);
    setConnectionState("Disconnected");
  }

  const isWorking = status === "connecting" || status === "connected";

  return (
    <main className="shell studio-page" style={{ paddingBottom: 120 }}>
      <header className="topbar">
        <Link className="brand" href="/">
          <div className="brand-dot" />
          LocalStream
        </Link>
        <div className="status-cluster" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <Badge variant={status === "connected" ? "live" : "default"} showDot>
            {status === "connected" ? "CONNECTED" : status === "connecting" ? "CONNECTING" : "OFFLINE"}
          </Badge>
          <span className="connection text-sm">SFU · {connectionState}</span>
        </div>
      </header>

      <section className="studio-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "32px 0" }}>
        <div>
          <p className="eyebrow" style={{ color: "var(--brand-accent)", marginBottom: "8px" }}>BROADCAST SOURCE</p>
          <h1 className="h1">{cameraName}</h1>
        </div>
        <div className="room-label text-sm" style={{ textAlign: "right" }}>
          <span style={{ display: "block", color: "var(--text-tertiary)", fontSize: "11px", letterSpacing: "0.1em", marginBottom: "4px" }}>
            ROOM
          </span>
          {connectedRoom ? `${connectedRoom.name} · ${connectedRoom.code}` : "NOT CONNECTED"}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "24px" }}>
        {!isWorking && (
          <Card style={{ maxWidth: "600px", margin: "0 auto", width: "100%" }}>
            <CardBody style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px" }}>
              <div style={{ textAlign: "center", marginBottom: "16px" }}>
                <Video size={32} style={{ margin: "0 auto 12px", color: "var(--brand-accent)" }} />
                <h2 className="h3">ตั้งค่าการส่งสัญญาณภาพ</h2>
                <p className="text-sm" style={{ marginTop: "8px" }}>เลือกประเภทสื่อที่คุณต้องการถ่ายทอดสด</p>
              </div>

              <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap", justifyContent: "center" }}>
                <Button variant={sourceType === "camera" ? "primary" : "secondary"} onClick={() => setSourceType("camera")}>
                  <Camera size={16} /> กล้องเว็บแคม
                </Button>
                <Button variant={sourceType === "screen" ? "primary" : "secondary"} onClick={() => setSourceType("screen")}>
                  <MonitorUp size={16} /> แชร์หน้าจอ
                </Button>
                <Button variant={sourceType === "file" ? "primary" : "secondary"} onClick={() => setSourceType("file")}>
                  <FileVideo size={16} /> ไฟล์รูป/วิดีโอ
                </Button>
              </div>

              {sourceType === "camera" && (
                <div style={{ display: "flex", gap: "12px", alignItems: "center", justifyContent: "center", flexWrap: "wrap", padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "8px" }}>
                  <span className="text-sm">กล้องเริ่มต้น</span>
                  <Button variant={cameraFacingMode === "environment" ? "primary" : "secondary"} onClick={() => setCameraFacingMode("environment")}>
                    กล้องหลัง
                  </Button>
                  <Button variant={cameraFacingMode === "user" ? "primary" : "secondary"} onClick={() => setCameraFacingMode("user")}>
                    กล้องหน้า
                  </Button>
                </div>
              )}

              {sourceType === "file" && (
                <div style={{ marginBottom: "16px", padding: "16px", border: "1px dashed var(--border-strong)", borderRadius: "8px" }}>
                   <label className="text-sm" style={{ display: "block", marginBottom: "8px", fontWeight: 600 }}>เลือกไฟล์สื่อ (Image / Video)</label>
                   <input type="file" accept="video/*,image/*" onChange={(e) => setMediaFile(e.target.files?.[0] || null)} style={{ width: "100%" }} />
                </div>
              )}

              <Input
                label="ROOM CODE"
                id="room-code"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase())}
                placeholder="เช่น A7K9P2"
                maxLength={8}
                style={{ textAlign: "center", fontSize: "24px", letterSpacing: "0.2em", height: "60px", fontWeight: 700 }}
              />
              <Button 
                variant="primary" 
                size="lg" 
                onClick={startCamera} 
                disabled={!roomCode.trim() || (sourceType === "file" && !mediaFile)}
                style={{ width: "100%", marginTop: "8px" }}
              >
                เชื่อมต่อและส่งสัญญาณภาพ
              </Button>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "16px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Video size={18} style={{ color: "var(--text-secondary)" }} />
              <span style={{ fontWeight: 600 }}>Live Feed</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" }}>
              <span className="text-sm">
                {sourceType === "camera" ? (cameraFacingMode === "environment" ? "กล้องหลัง" : "กล้องหน้า") : "ภาพที่ส่งไปยัง Studio"}
              </span>
              {sourceType === "camera" && status === "connected" && (
                <Button variant="secondary" size="sm" onClick={switchMobileCamera} disabled={switchingCamera} isLoading={switchingCamera}>
                  <SwitchCamera size={16} /> สลับกล้อง
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <div className="program-frame" style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain", transform: sourceType === "camera" && cameraFacingMode === "user" ? "scaleX(-1)" : "scaleX(1)" }} />
              {!isWorking && (
                <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at center, #1a1a1a 0, #0a0a0a 100%)" }}>
                  <MonitorOff size={32} style={{ color: "var(--text-tertiary)", marginBottom: "16px" }} />
                  <span style={{ fontSize: "12px", letterSpacing: "0.15em", fontWeight: 600, color: "var(--text-secondary)" }}>NOT ACTIVE</span>
                  <p className="text-sm" style={{ marginTop: "8px" }}>
                    เชื่อมต่อเพื่อดูภาพตัวอย่าง
                  </p>
                </div>
              )}
              {status === "connected" && (
                <Badge variant="success" showDot style={{ position: "absolute", top: "16px", left: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
                  CONNECTED · {connectedRoom?.code}
                </Badge>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <footer className="control-dock" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 24px", background: "rgba(10,10,10,0.85)", backdropFilter: "blur(12px)", borderTop: "1px solid var(--border-strong)", zIndex: 100 }}>
        <div style={{ color: status === "error" ? "var(--danger)" : "var(--text-secondary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          {status === "error" ? <UserX size={16} /> : <Info size={16} />}
          {message}
        </div>
        <div className="dock-actions" style={{ display: "flex", gap: "12px" }}>
          {!isWorking && (
             <Link href="/channels">
               <Button variant="ghost">กลับ</Button>
             </Link>
          )}
          {isWorking && (
            <Button variant="danger" onClick={stopCamera}>
              <Square size={16} /> หยุดการทำงาน
            </Button>
          )}
        </div>
      </footer>
    </main>
  );
}
