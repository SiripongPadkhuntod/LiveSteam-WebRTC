"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectionState, LocalVideoTrack, Room, RoomEvent, Track } from "livekit-client";
import { findRoomByCode, getConnectionToken, participantID, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Camera, Video, MonitorOff, UserX, Play, Square, Info } from "lucide-react";

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const identityRef = useRef("");

  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [message, setMessage] = useState("กรอก Room Code เพื่อเชื่อมกล้องเข้าห้อง");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<BroadcastRoom | null>(null);
  const [cameraName, setCameraName] = useState("Camera");

  useEffect(() => {
    identityRef.current = participantID("camera");
    const shortID = identityRef.current.split("-").pop()?.substring(0, 4).toUpperCase();
    setCameraName(`Cam-${shortID}`);
  }, []);

  useEffect(() => () => {
    void stopCamera();
  }, []);

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
      setMessage("กำลังขอสิทธิ์กล้องและไมโครโฟน…");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStream.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      await connectToRoom(roomInfo);
      setConnectedRoom(roomInfo);
      setStatus("connected");
      setMessage(`เชื่อมต่อ ${roomInfo.name} แล้ว`);
    } catch (error) {
      await stopCamera();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมกล้องไม่สำเร็จ");
    }
  }

  async function connectToRoom(roomInfo: BroadcastRoom) {
    const credentials = await getConnectionToken(identityRef.current, roomInfo.id, "broadcaster");
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => setConnectionState(state));
    room.on(RoomEvent.Disconnected, () => setConnectionState("Disconnected"));
    room.on(RoomEvent.DataReceived, async (payload) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data.type === "disconnect-camera" || data.type === "disconnect-source") {
          await stopCamera();
          setMessage("Studio นำกล้องออกจากห้องแล้ว");
        }
      } catch (error) {
        console.error("Invalid camera control message", error);
      }
    });

    await room.connect(credentials.url, credentials.token);
    roomRef.current = room;

    room.localParticipant.setTrackSubscriptionPermissions(false, [
      { participantIdentity: roomInfo.studioIdentity, allowAll: true },
    ]);

    const videoTrack = localStream.current?.getVideoTracks()[0];
    const audioTrack = localStream.current?.getAudioTracks()[0];
    if (!videoTrack) throw new Error("ไม่พบ Video Track จากกล้อง");

    await room.localParticipant.publishTrack(new LocalVideoTrack(videoTrack.clone(), undefined, true), {
      name: "camera-video",
      source: Track.Source.Camera,
      simulcast: true,
    });
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack.clone(), {
        name: "camera-audio",
        source: Track.Source.Microphone,
      });
    }
  }

  async function stopCamera() {
    roomRef.current?.disconnect();
    roomRef.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
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
          <p className="eyebrow" style={{ color: "var(--brand-accent)", marginBottom: "8px" }}>CAMERA SOURCE</p>
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
          <Card style={{ maxWidth: "500px", margin: "0 auto", width: "100%" }}>
            <CardBody style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "32px" }}>
              <div style={{ textAlign: "center", marginBottom: "8px" }}>
                <Camera size={32} style={{ margin: "0 auto 12px", color: "var(--brand-accent)" }} />
                <h2 className="h3">เชื่อมต่อกล้องเข้าห้อง</h2>
                <p className="text-sm" style={{ marginTop: "8px" }}>รับ Room Code จากผู้สร้างห้อง (Studio) แล้วกรอกด้านล่างเพื่อส่งสัญญาณภาพ</p>
              </div>
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
                disabled={!roomCode.trim()}
                style={{ width: "100%", marginTop: "8px" }}
              >
                เชื่อมต่อกล้อง
              </Button>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Video size={18} style={{ color: "var(--text-secondary)" }} />
              <span style={{ fontWeight: 600 }}>Camera Feed</span>
            </div>
            <span className="text-sm">ภาพจากกล้องของคุณ</span>
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <div className="program-frame" style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
              <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              {!isWorking && (
                <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at center, #1a1a1a 0, #0a0a0a 100%)" }}>
                  <MonitorOff size={32} style={{ color: "var(--text-tertiary)", marginBottom: "16px" }} />
                  <span style={{ fontSize: "12px", letterSpacing: "0.15em", fontWeight: 600, color: "var(--text-secondary)" }}>NOT ACTIVE</span>
                  <p className="text-sm" style={{ marginTop: "8px" }}>
                    กรอก Room Code แล้วกดเชื่อมต่อกล้อง
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
