"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LocalVideoTrack, Room, RoomEvent, Track, VideoPresets } from "livekit-client";
import { findRoomByCode, getConnectionToken, participantID, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Camera, UserX, Square, Info, SwitchCamera, Radio, CircleAlert } from "lucide-react";

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

  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [message, setMessage] = useState("กรอก Room Code เพื่อเชื่อมต่อเข้าห้อง");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<BroadcastRoom | null>(null);
  const [cameraName, setCameraName] = useState("Source");

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
    return await navigator.mediaDevices.getUserMedia({
      video: cameraVideoConstraints(cameraFacingMode),
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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
    // A production source feeds the compositor with one stable mezzanine
    // stream. Simulcast layer switches can change H.264 SPS/PPS mid-session,
    // which is unsuitable for the continuous decoder/compositor input.
    const sourceEncoding = {
      ...VideoPresets.h1080.encoding,
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      priority: "high" as const,
    };
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      publishDefaults: {
        simulcast: false,
        videoSimulcastLayers: [],
        videoCodec: "h264",
        backupCodec: false,
        videoEncoding: sourceEncoding,
        degradationPreference: "maintain-resolution",
      },
    });

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
      cameraVideoConstraints(cameraFacingMode),
      false,
    );

    await room.localParticipant.publishTrack(localVideoTrack, {
      name: "camera-video",
      source: Track.Source.Camera,
      simulcast: false,
      videoCodec: "h264",
      backupCodec: false,
      degradationPreference: "maintain-resolution",
      videoSimulcastLayers: [],
      videoEncoding: sourceEncoding,
    });
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack.clone(), {
        name: "camera-audio",
        source: Track.Source.Microphone,
      });
    }
  }

  async function switchMobileCamera() {
    if (switchingCamera) return;
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

    setStatus("idle");
    setConnectedRoom(null);
  }

  const isWorking = status === "connecting" || status === "connected";

  return (
    <main className="camera-operator">
      <video className="camera-operator-video" ref={videoRef} autoPlay playsInline muted style={{ transform: cameraFacingMode === "user" ? "scaleX(-1)" : "scaleX(1)" }} />
      <div className="camera-operator-shade" />
      <header className="camera-operator-header">
        <Link className="brand" href="/"><div className="brand-dot" />LocalStream</Link>
        {isWorking && <span className={`camera-operator-connection ${status === "connected" ? "live" : ""}`}><i /> {status === "connected" ? "CONNECTED" : "CONNECTING"}</span>}
      </header>

      {!isWorking ? <section className="camera-join-card">
        <div className="camera-join-icon"><Camera size={28} /></div>
        <p>CAMERA OPERATOR</p><h1>พร้อมถ่ายภาพ</h1>
        <span>กรอก Room Code แล้วอนุญาตให้เว็บไซต์ใช้กล้อง</span>
        <label>ROOM CODE<input id="room-code" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase())} placeholder="A7K9P2" maxLength={8} autoComplete="off" autoFocus /></label>
        {status === "error" && <div className="camera-join-error"><CircleAlert size={14} />{message}</div>}
        <Button variant="primary" size="lg" onClick={startCamera} disabled={!roomCode.trim()}><Camera size={18} /> เปิดกล้องและเชื่อมต่อ</Button>
        <Link href="/channels">กลับไปหน้าห้อง</Link>
      </section> : <>
        <div className="camera-live-room"><Radio size={13} /><span>LIVE TO STUDIO</span><strong>{connectedRoom?.name ?? "กำลังเชื่อมต่อ"}</strong><small>{connectedRoom?.code}</small></div>
        <section className="camera-operator-controls">
          <div className="camera-operator-info"><span>{cameraName}</span><strong>{cameraFacingMode === "environment" ? "กล้องหลัง" : "กล้องหน้า"}</strong><small>1920 × 1080 · 30 FPS</small></div>
          <div className="camera-operator-actions">
            <button className="camera-round-control" onClick={switchMobileCamera} disabled={switchingCamera} aria-label="สลับกล้อง"><SwitchCamera size={25} /><span>สลับกล้อง</span></button>
            <button className="camera-round-control danger" onClick={stopCamera} aria-label="ปิดกล้อง"><Square size={22} fill="currentColor" /><span>ปิดกล้อง</span></button>
          </div>
        </section>
      </>}
      {status === "connecting" && <div className="camera-connecting"><Info size={16} /> {message}</div>}
      {status === "error" && isWorking && <div className="camera-connecting error"><UserX size={16} /> {message}</div>}
    </main>
  );
}
