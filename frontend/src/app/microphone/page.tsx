"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track } from "livekit-client";
import { findRoomByCode, getConnectionToken, participantID, type BroadcastRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, UserX, Square, Info, Radio, CircleAlert, AudioLines, Settings2 } from "lucide-react";

export default function MicrophonePage() {
  const roomRef = useRef<Room | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const identityRef = useRef("");
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [message, setMessage] = useState("กรอก Room Code เพื่อเชื่อมไมโครโฟน");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [roomCode, setRoomCode] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<BroadcastRoom | null>(null);
  const [microphoneName, setMicrophoneName] = useState("Microphone");
  const [muted, setMuted] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceID, setSelectedDeviceID] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    identityRef.current = participantID("microphone");
    const shortID = identityRef.current.split("-").pop()?.substring(0, 4).toUpperCase();
    setMicrophoneName(`Mic-${shortID}`);
  }, []);

  useEffect(() => () => {
    void stopMicrophone();
  }, []);

  useEffect(() => {
    const refreshDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAudioDevices(devices.filter((device) => device.kind === "audioinput"));
      } catch {
        // Device labels remain unavailable until permission is granted.
      }
    };
    void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
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
        audio: { deviceId: selectedDeviceID ? { exact: selectedDeviceID } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStream.current = stream;
      startAudioMeter(stream);
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(devices.filter((device) => device.kind === "audioinput"));

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
    stopAudioMeter();
    setStatus("idle");
    setConnectedRoom(null);
    setMuted(false);
    setConnectionState("Disconnected");
  }

  function startAudioMeter(stream: MediaStream) {
    stopAudioMeter();
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.76;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;
    const samples = new Uint8Array(analyser.fftSize);
    const readLevel = () => {
      analyser.getByteTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        squareSum += normalized * normalized;
      }
      setAudioLevel(Math.min(1, Math.sqrt(squareSum / samples.length) * 5.5));
      meterFrameRef.current = requestAnimationFrame(readLevel);
    };
    readLevel();
  }

  function stopAudioMeter() {
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setAudioLevel(0);
  }

  const isWorking = status === "connecting" || status === "connected";
  const isLiveAudio = status === "connected" && !muted;

  return (
    <main className="audio-operator">
      <header className="audio-operator-header"><Link className="brand" href="/"><div className="brand-dot" />LocalStream</Link>{isWorking && <span className={`camera-operator-connection ${isLiveAudio ? "live" : ""}`}><i /> {muted ? "MUTED" : status === "connected" ? "MIC LIVE" : "CONNECTING"}</span>}</header>
      {!isWorking ? <section className="audio-join-card">
        <div className="audio-join-icon"><AudioLines size={29} /></div><p>AUDIO OPERATOR</p><h1>พร้อมส่งเสียง</h1><span>กรอก Room Code แล้วอนุญาตให้เว็บไซต์ใช้ไมโครโฟน</span>
        {audioDevices.length > 1 && <label className="audio-device-select"><span><Settings2 size={14} /> MICROPHONE</span><select value={selectedDeviceID} onChange={(event) => setSelectedDeviceID(event.target.value)}><option value="">Default microphone</option>{audioDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>}
        <label className="audio-room-input">ROOM CODE<input id="microphone-room-code" value={roomCode} onChange={(event) => setRoomCode(event.target.value.replace(/[^a-zA-Z0-9-]/g, "").toUpperCase())} placeholder="A7K9P2" maxLength={8} autoComplete="off" autoFocus /></label>
        {status === "error" && <div className="camera-join-error"><CircleAlert size={14} />{message}</div>}
        <Button variant="primary" size="lg" onClick={startMicrophone} disabled={!roomCode.trim()}><Mic size={18} /> เปิดไมค์และเชื่อมต่อ</Button><Link href="/channels">กลับไปหน้าห้อง</Link>
      </section> : <>
        <section className={`audio-live-stage ${isLiveAudio ? "active" : ""} ${muted ? "muted" : ""}`}>
          <div className="audio-live-room"><Radio size={13} /><span>LIVE TO STUDIO</span><strong>{connectedRoom?.name ?? "กำลังเชื่อมต่อ"}</strong><small>{connectedRoom?.code}</small></div>
          <div className="audio-live-core">{muted ? <MicOff size={55} /> : <Mic size={55} />}</div><strong>{muted ? "MICROPHONE MUTED" : status === "connected" ? "MICROPHONE LIVE" : "CONNECTING MICROPHONE"}</strong><p>{muted ? "เสียงนี้จะไม่ถูกส่งออกจนกว่าจะเปิดไมค์" : "กำลังส่งสัญญาณเสียงไปยัง Studio"}</p>
          <div className="audio-live-meter" aria-label="Live microphone level">{Array.from({ length: 31 }, (_, index) => <i key={index} style={{ height: `${Math.max(8, 16 + Math.min(84, audioLevel * 100) * (0.45 + ((index * 13) % 50) / 100))}%` }} />)}</div>
        </section>
        <section className="audio-operator-controls"><div><span>{microphoneName}</span><strong>{audioLevel > .08 && !muted ? "กำลังรับสัญญาณเสียง" : muted ? "ปิดเสียงอยู่" : "รอเสียงเข้า"}</strong><small>Opus · 48 kHz · Echo cancellation on</small></div><div className="audio-operator-actions"><button className={`audio-mute-control ${muted ? "muted" : ""}`} onClick={toggleMute}>{muted ? <Mic size={24} /> : <MicOff size={24} />}<span>{muted ? "เปิดไมค์" : "ปิดเสียง"}</span></button><button className="camera-round-control danger" onClick={stopMicrophone}><Square size={22} fill="currentColor" /><span>ปิดไมค์</span></button></div></section>
      </>}
      {status === "connecting" && <div className="camera-connecting"><Info size={16} /> {message}</div>}
      {connectionState === "Disconnected" && status === "error" && <div className="camera-connecting error"><UserX size={16} /> {message}</div>}
    </main>
  );
}
