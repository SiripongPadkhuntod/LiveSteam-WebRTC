"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track } from "livekit-client";
import { findRoomByCode, getConnectionToken, participantID, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Mic, MicOff, UserX, Square, Info } from "lucide-react";

export default function MicrophonePage() {
  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const identityRef = useRef("");
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [message, setMessage] = useState("กรอก Room Code เพื่อเชื่อมไมโครโฟน");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<BroadcastRoom | null>(null);
  const [microphoneName, setMicrophoneName] = useState("Microphone");
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    identityRef.current = participantID("microphone");
    const shortID = identityRef.current.split("-").pop()?.substring(0, 4).toUpperCase();
    setMicrophoneName(`Mic-${shortID}`);
  }, []);

  useEffect(() => () => {
    void stopMicrophone();
  }, []);

  async function startMicrophone() {
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStream.current = stream;

      const credentials = await getConnectionToken(identityRef.current, roomInfo.id, "broadcaster");
      const room = new Room({ adaptiveStream: true, dynacast: true });
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => setConnectionState(state));
      room.on(RoomEvent.Disconnected, () => setConnectionState("Disconnected"));
      room.on(RoomEvent.DataReceived, async (payload) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === "disconnect-source") {
            await stopMicrophone();
            setMessage("Studio นำไมโครโฟนออกจากห้องแล้ว");
          }
        } catch (error) {
          console.error("Invalid microphone control message", error);
        }
      });
      await room.connect(credentials.url, credentials.token);
      roomRef.current = room;
      room.localParticipant.setTrackSubscriptionPermissions(false, [
        { participantIdentity: roomInfo.studioIdentity, allowAll: true },
      ]);

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("ไม่พบ Audio Track จากไมโครโฟน");
      await room.localParticipant.publishTrack(audioTrack.clone(), {
        name: "microphone-audio",
        source: Track.Source.Microphone,
      });
      setRoomCode(roomInfo.code);
      setConnectedRoom(roomInfo);
      setMuted(false);
      setStatus("connected");
      setMessage(`เชื่อมต่อไมโครโฟนกับ ${roomInfo.name} แล้ว`);
    } catch (error) {
      await stopMicrophone();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมต่อไมโครโฟนไม่สำเร็จ");
    }
  }

  async function toggleMute() {
    const publication = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!publication?.track) return;
    if (muted) await publication.unmute();
    else await publication.mute();
    setMuted(!muted);
  }

  async function stopMicrophone() {
    roomRef.current?.disconnect();
    roomRef.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    setStatus("idle");
    setConnectedRoom(null);
    setMuted(false);
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
          <Badge variant={status === "connected" ? (muted ? "default" : "live") : "default"} showDot>
            {status === "connected" ? (muted ? "MUTED" : "CONNECTED") : status === "connecting" ? "CONNECTING" : "OFFLINE"}
          </Badge>
          <span className="connection text-sm">SFU · {connectionState}</span>
        </div>
      </header>

      <section className="studio-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "32px 0" }}>
        <div>
          <p className="eyebrow" style={{ color: "var(--brand-accent)", marginBottom: "8px" }}>AUDIO SOURCE</p>
          <h1 className="h1">{microphoneName}</h1>
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
                <Mic size={32} style={{ margin: "0 auto 12px", color: "var(--brand-accent)" }} />
                <h2 className="h3">เชื่อมต่อไมโครโฟน</h2>
                <p className="text-sm" style={{ marginTop: "8px" }}>รับ Room Code จากผู้สร้างห้อง (Studio) แล้วกรอกด้านล่างเพื่อส่งสัญญาณเสียง</p>
              </div>
              <Input
                label="ROOM CODE"
                id="microphone-room-code"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase())}
                placeholder="เช่น A7K9P2"
                maxLength={8}
                style={{ textAlign: "center", fontSize: "24px", letterSpacing: "0.2em", height: "60px", fontWeight: 700 }}
              />
              <Button
                variant="primary"
                size="lg"
                onClick={startMicrophone}
                disabled={!roomCode.trim()}
                style={{ width: "100%", marginTop: "8px" }}
              >
                เชื่อมต่อไมโครโฟน
              </Button>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {muted ? <MicOff size={18} style={{ color: "var(--danger)" }} /> : <Mic size={18} style={{ color: "var(--text-secondary)" }} />}
              <span style={{ fontWeight: 600 }}>Microphone Status</span>
            </div>
            <span className="text-sm">ไมโครโฟนของคุณ</span>
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <div className={`microphone-stage ${status === "connected" && !muted ? "active" : ""}`} style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transition: "all 0.3s ease" }}>

              <div style={{ width: "120px", height: "120px", borderRadius: "50%", background: status === "connected" && !muted ? "rgba(255, 62, 0, 0.15)" : "rgba(255, 255, 255, 0.05)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "24px", transition: "all 0.3s ease", boxShadow: status === "connected" && !muted ? "0 0 0 20px rgba(255, 62, 0, 0.05), 0 0 0 40px rgba(255, 62, 0, 0.02)" : "none" }}>
                {muted ? <MicOff size={48} style={{ color: "var(--danger)" }} /> : <Mic size={48} style={{ color: status === "connected" ? "var(--brand-accent)" : "var(--text-tertiary)" }} />}
              </div>

              <span style={{ fontSize: "14px", letterSpacing: "0.15em", fontWeight: 600, color: status === "connected" && !muted ? "var(--brand-accent)" : "var(--text-secondary)" }}>
                {status === "connected" ? (muted ? "MICROPHONE MUTED" : "MICROPHONE CONNECTED") : "MICROPHONE OFFLINE"}
              </span>
              <p className="text-sm" style={{ marginTop: "12px", color: "var(--text-tertiary)" }}>
                {connectedRoom ? `Room Code · ${connectedRoom.code}` : "กรอก Code แล้วอนุญาตการใช้ไมโครโฟน"}
              </p>
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
          {status === "connected" && (
            <Button variant={muted ? "primary" : "secondary"} onClick={toggleMute}>
              {muted ? <Mic size={16} /> : <MicOff size={16} />}
              {muted ? "เปิดไมค์" : "ปิดเสียงไมค์"}
            </Button>
          )}
          {isWorking && (
            <Button variant="danger" onClick={stopMicrophone}>
              <Square size={16} /> หยุดการทำงาน
            </Button>
          )}
        </div>
      </footer>
    </main>
  );
}
