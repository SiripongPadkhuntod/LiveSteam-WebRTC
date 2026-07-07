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
    <main className="shell studio-page">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-dot" /> LocalStream</Link>
        <div className="status-cluster">
          <span className={`status-pill ${status === "connected" ? "live" : ""}`}><i />{status === "connected" ? (muted ? "MUTED" : "CONNECTED") : status === "connecting" ? "CONNECTING" : "OFFLINE"}</span>
          <span className="connection">SFU · {connectionState}</span>
        </div>
      </header>

      <section className="studio-heading">
        <div><p className="eyebrow">AUDIO SOURCE</p><h1>{microphoneName}</h1></div>
        <div className="room-label"><span>ROOM</span>{connectedRoom ? `${connectedRoom.name} · ${connectedRoom.code}` : "NOT CONNECTED"}</div>
      </section>

      {!isWorking && (
        <section className="camera-code-panel">
          <label htmlFor="microphone-room-code">ROOM CODE</label>
          <input id="microphone-room-code" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase())} placeholder="เช่น A7K9P2" maxLength={8} autoCapitalize="characters" autoComplete="off" />
          <p>ไมโครโฟนจะส่งเฉพาะเสียงเข้าห้อง โดย Studio เป็นผู้เลือกว่าจะนำเสียงนี้ออก Program หรือไม่</p>
        </section>
      )}

      <section className={`microphone-stage ${status === "connected" && !muted ? "active" : ""}`}>
        <div className="microphone-icon" aria-hidden="true">●</div>
        <span>{status === "connected" ? (muted ? "MICROPHONE MUTED" : "MICROPHONE CONNECTED") : "MICROPHONE OFFLINE"}</span>
        <p>{connectedRoom ? `Room Code · ${connectedRoom.code}` : "กรอก Code แล้วอนุญาตการใช้ไมโครโฟน"}</p>
      </section>

      <footer className="control-dock">
        <div className={`system-message ${status === "error" ? "error" : ""}`}><i />{message}</div>
        <div className="dock-actions">
          {!isWorking && <button className="button primary live-action" onClick={startMicrophone}>เชื่อมต่อไมโครโฟน</button>}
          {status === "connected" && <button className="button secondary" onClick={toggleMute}>{muted ? "เปิดไมค์" : "ปิดเสียงไมค์"}</button>}
          {isWorking && <button className="button danger" onClick={stopMicrophone}>หยุดการทำงาน</button>}
          <Link className="button ghost" href="/channels">กลับ</Link>
        </div>
      </footer>
    </main>
  );
}
