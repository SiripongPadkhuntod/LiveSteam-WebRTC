"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { getConnectionToken } from "@/lib/api";
import { channelByID, channelIDFromSearch, DEFAULT_CHANNEL_ID, programRoomID } from "@/lib/channels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Toast } from "@/components/ui/toast";
import { LayoutDashboard, RadioTower, Users, Video, Mic, Play, Square, Volume2, VolumeX, MonitorOff, UserX, CheckCircle2, X } from "lucide-react";

type CameraSource = {
  id: string;
  label: string;
  participant: RemoteParticipant;
  videoTrack?: Track;
  audioTrack?: Track;
};

type AudioSource = {
  id: string;
  label: string;
  kind: "camera" | "microphone";
  track: Track;
};

type AudioMixSetting = {
  enabled: boolean;
  volume: number;
};

export default function StudioPage() {
  const outputVideo = useRef<HTMLVideoElement>(null);
  const publisherRoom = useRef<Room | null>(null);
  const outputPublisherRoom = useRef<Room | null>(null);
  const monitorRoom = useRef<Room | null>(null);
  const programVideoTrack = useRef<LocalVideoTrack | null>(null);
  const programAudioTrack = useRef<LocalAudioTrack | null>(null);
  const programSwitchQueue = useRef<Promise<void>>(Promise.resolve());
  const previewAudioElement = useRef<HTMLAudioElement | null>(null);
  const programAudioEnabledRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioMixerNodesRef = useRef(new Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode }>());
  const audioSourcesRef = useRef<AudioSource[]>([]);
  const audioMixSettingsRef = useRef<Record<string, AudioMixSetting>>({});

  const [cameras, setCameras] = useState<CameraSource[]>([]);
  const [audioSources, setAudioSources] = useState<AudioSource[]>([]);
  const [audioMixSettings, setAudioMixSettings] = useState<Record<string, AudioMixSetting>>({});
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [monitoredAudioSourceId, setMonitoredAudioSourceId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"video" | "audio">("video");
  const [programAudioEnabled, setProgramAudioEnabled] = useState(true);
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "live" | "error">("idle");
  const [message, setMessage] = useState("พร้อมเริ่มรายการ");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [viewerCount, setViewerCount] = useState(0);
  const [roomName, setRoomName] = useState(DEFAULT_CHANNEL_ID);
  const [roomCode, setRoomCode] = useState("");

  const activeCameraIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    setRoomName(channelIDFromSearch(window.location.search));
    setRoomCode(new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? "");
  }, []);

  useEffect(() => {
    activeCameraIdRef.current = activeCameraId;
  }, [activeCameraId]);

  useEffect(() => {
    programAudioEnabledRef.current = programAudioEnabled;
  }, [programAudioEnabled]);

  useEffect(() => {
    previewAudioElement.current?.remove();
    previewAudioElement.current = null;
    if (!monitoredAudioSourceId) return;
    const audioTrack = audioSources.find((source) => source.id === monitoredAudioSourceId)?.track;
    if (!audioTrack) return;
    const element = audioTrack.attach() as HTMLAudioElement;
    element.autoplay = true;
    document.body.appendChild(element);
    previewAudioElement.current = element;
    return () => {
      element.remove();
      if (previewAudioElement.current === element) previewAudioElement.current = null;
    };
  }, [audioSources, monitoredAudioSourceId]);

  useEffect(() => () => {
    monitorRoom.current?.disconnect();
    outputPublisherRoom.current?.disconnect();
    publisherRoom.current?.disconnect();
    programVideoTrack.current?.stop();
    programAudioTrack.current?.stop();
    previewAudioElement.current?.remove();
    audioMixerNodesRef.current.forEach(({ source, gain }) => {
      source.disconnect();
      gain.disconnect();
    });
    void audioContextRef.current?.close();
  }, []);

  const buildCameraSources = (room: Room) => {
      return Array.from(room.remoteParticipants.values())
           .filter((p) => p.identity.startsWith("camera-"))
           .map(p => {
               const videoPub = p.getTrackPublication(Track.Source.Camera) || Array.from(p.videoTrackPublications.values())[0];
               const audioPub = p.getTrackPublication(Track.Source.Microphone) || Array.from(p.audioTrackPublications.values())[0];
               return {
                   id: p.identity,
                   label: p.name || p.identity,
                   participant: p,
                   videoTrack: videoPub?.videoTrack,
                   audioTrack: audioPub?.audioTrack,
               }
           });
  };

  const buildAudioSources = (room: Room): AudioSource[] => {
    return Array.from(room.remoteParticipants.values())
      .filter((participant) => participant.identity.startsWith("camera-") || participant.identity.startsWith("microphone-"))
      .flatMap((participant) => {
        const publication = participant.getTrackPublication(Track.Source.Microphone)
          || Array.from(participant.audioTrackPublications.values())[0];
        if (!publication?.audioTrack) return [];
        return [{
          id: participant.identity,
          label: participant.name || participant.identity,
          kind: participant.identity.startsWith("microphone-") ? "microphone" as const : "camera" as const,
          track: publication.audioTrack,
        }];
      });
  };

  async function connectStudio() {
    setStatus("connecting");
    setMessage("กำลังเชื่อมต่อ LiveKit…");
    try {
      const studioIdentity = `studio-${roomName}`;
      
      // Connect to the Channel room
      const broadcaster = await getConnectionToken(studioIdentity, roomName, "broadcaster");
      const pubRoom = new Room({ adaptiveStream: true, dynacast: true });
      pubRoom.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => setConnectionState(state));
      
      const updateCameras = () => {
         const cams = buildCameraSources(pubRoom);
         const audio = buildAudioSources(pubRoom);
         setCameras([...cams]);
         setAudioSources(audio);
         audioSourcesRef.current = audio;
         setAudioMixSettings((current) => {
           const next: Record<string, AudioMixSetting> = {};
           audio.forEach((source) => {
             next[source.id] = current[source.id] ?? { enabled: false, volume: 100 };
           });
           audioMixSettingsRef.current = next;
           if (programVideoTrack.current) void syncAudioMixer(audio, next, true);
           return next;
         });
         
         if (cams.length > 0) {
            if (!activeCameraIdRef.current || !cams.find(c => c.id === activeCameraIdRef.current)) {
                const firstReadyCamera = cams.find(c => c.videoTrack);
                if (firstReadyCamera) setActiveCameraId(firstReadyCamera.id);
            }
         } else {
            setActiveCameraId(null);
         }
      };

      pubRoom.on(RoomEvent.ParticipantConnected, () => {
          updateCameras();
      });
      pubRoom.on(RoomEvent.ParticipantDisconnected, () => {
          updateCameras();
      });
      pubRoom.on(RoomEvent.TrackSubscribed, updateCameras);
      pubRoom.on(RoomEvent.TrackUnsubscribed, updateCameras);

      await pubRoom.connect(broadcaster.url, broadcaster.token, { autoSubscribe: true });
      updateCameras();
      publisherRoom.current = pubRoom;

      // One dedicated Publisher Session carries both program-video and
      // program-audio into an isolated Program Room for viewers.
      const outputRoomName = programRoomID(roomName);
      const outputCredentials = await getConnectionToken(`program-${roomName}`, outputRoomName, "broadcaster");
      const outRoom = new Room({ adaptiveStream: true, dynacast: true });
      const refreshViewerCount = () => {
        const viewers = Array.from(outRoom.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith("viewer-")).length;
        setViewerCount(viewers);
      };
      outRoom.on(RoomEvent.ParticipantConnected, refreshViewerCount);
      outRoom.on(RoomEvent.ParticipantDisconnected, refreshViewerCount);
      await outRoom.connect(outputCredentials.url, outputCredentials.token, { autoSubscribe: false });
      refreshViewerCount();
      outputPublisherRoom.current = outRoom;

      // A separate monitor connection receives exactly the same Program track
      // as viewers from the isolated Program Room.
      const monitorCredentials = await getConnectionToken(studioIdentity + "-monitor", outputRoomName, "monitor");
      const monRoom = new Room({ adaptiveStream: true });
      const subscribeToProgram = (publication: RemoteTrackPublication) => {
        if (publication.trackName === "program-video" || publication.trackName === "program-audio") {
          publication.setSubscribed(true);
        }
      };
      monRoom.on(RoomEvent.TrackPublished, subscribeToProgram);
      monRoom.on(RoomEvent.TrackSubscribed, attachProgramMonitorTrack);
      monRoom.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
      await monRoom.connect(monitorCredentials.url, monitorCredentials.token, { autoSubscribe: false });
      monRoom.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach(subscribeToProgram);
      });
      monitorRoom.current = monRoom;

      setStatus("ready");
      setMessage("Studio พร้อมแล้ว · ตรวจภาพและเสียงก่อนเริ่มถ่ายทอดสด");
    } catch (error) {
      await disconnectAll();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ");
    }
  }

  function switchCamera(id: string, room: Room | null = outputPublisherRoom.current, sources: CameraSource[] = cameras) {
    const operation = programSwitchQueue.current.then(async () => {
      try {
        await applyProgramSwitch(id, room, sources);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "เปลี่ยน Program ไม่สำเร็จ");
      }
    });
    programSwitchQueue.current = operation;
    return operation;
  }

  function selectCamera(id: string) {
    if (status === "live") {
      void switchCamera(id);
      return;
    }
    setActiveCameraId(id);
    setMessage(`เลือก ${id} เป็นกล้องเริ่มต้นแล้ว · ยังไม่ได้ถ่ายทอดสด`);
  }

  async function applyProgramSwitch(id: string, room: Room | null, sources: CameraSource[]) {
    if (!room) return;
    const camera = sources.find(source => source.id === id);
    if (!camera?.videoTrack) throw new Error(`กล้อง ${id} ยังไม่มี Video Track`);

    const nextVideo = camera.videoTrack.mediaStreamTrack.clone();
    if (!programVideoTrack.current) {
      const localVideo = new LocalVideoTrack(nextVideo, undefined, true);
      await room.localParticipant.publishTrack(localVideo, {
        name: "program-video",
        source: Track.Source.Camera,
        simulcast: true,
      });
      programVideoTrack.current = localVideo;
    } else {
      const previousVideo = programVideoTrack.current.mediaStreamTrack;
      await programVideoTrack.current.replaceTrack(nextVideo, true);
      previousVideo.stop();
    }

    setActiveCameraId(id);
    setMessage(`เปลี่ยน Program เป็น ${id} แล้ว`);
  }

  async function disconnectSource(sourceId: string) {
    if (!publisherRoom.current) return;
    if (activeCameraId === sourceId) {
      // Pick another camera to be active first if possible
      const otherCam = cameras.find(c => c.id !== sourceId);
      if (otherCam) {
        if (status === "live") await switchCamera(otherCam.id);
        else setActiveCameraId(otherCam.id);
      } else {
        setActiveCameraId(null);
      }
    }
    setMessage(`นำ Source ${sourceId} ออกจากห้องแล้ว`);
    const data = new TextEncoder().encode(JSON.stringify({ type: "disconnect-source" }));
    await publisherRoom.current.localParticipant.publishData(data, { reliable: true, destinationIdentities: [sourceId] });
  }

  async function startBroadcast() {
    if (!activeCameraId || !outputPublisherRoom.current) {
      setMessage("กรุณารอหรือเลือกกล้องก่อนเริ่มถ่ายทอดสด");
      return;
    }
    setBroadcastBusy(true);
    setMessage("กำลังเปิด Program Output…");
    try {
      if (programAudioEnabledRef.current && audioSourcesRef.current.some((source) => audioMixSettingsRef.current[source.id]?.enabled)) {
        prepareAudioMixerContext();
      }
      await applyProgramSwitch(activeCameraId, outputPublisherRoom.current, cameras);
      await syncAudioMixer(audioSourcesRef.current, audioMixSettingsRef.current, true);
      setStatus("live");
      setMessage(`กำลังถ่ายทอดสดจาก ${activeCameraId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "เริ่มถ่ายทอดสดไม่สำเร็จ");
    } finally {
      setBroadcastBusy(false);
    }
  }

  async function stopBroadcast() {
    const room = outputPublisherRoom.current;
    if (!room) return;
    setBroadcastBusy(true);
    try {
      if (programVideoTrack.current) {
        await room.localParticipant.unpublishTrack(programVideoTrack.current);
        programVideoTrack.current.stop();
        programVideoTrack.current = null;
      }
      if (programAudioTrack.current) {
        await room.localParticipant.unpublishTrack(programAudioTrack.current);
        programAudioTrack.current.stop();
        programAudioTrack.current = null;
      }
      await destroyAudioMixer();
      if (outputVideo.current) outputVideo.current.srcObject = null;
      setStatus("ready");
      setMessage("หยุดถ่ายทอดสดแล้ว · Studio และกล้องยังเชื่อมต่ออยู่");
    } finally {
      setBroadcastBusy(false);
    }
  }

  async function toggleProgramAudio() {
    const enabled = !programAudioEnabled;
    setProgramAudioEnabled(enabled);
    programAudioEnabledRef.current = enabled;
    if (status !== "live") {
      setMessage(enabled ? "Program Audio พร้อมส่งเมื่อเริ่มถ่ายทอดสด" : "Program Audio จะถูกปิดเมื่อเริ่มถ่ายทอดสด");
      return;
    }
    if (!enabled) {
      await programAudioTrack.current?.mute();
      setMessage("ปิด Program Audio แล้ว");
    } else {
      await syncAudioMixer(audioSourcesRef.current, audioMixSettingsRef.current, true);
      setMessage("เปิด Program Audio แล้ว");
    }
  }

  function updateAudioMix(sourceId: string, patch: Partial<AudioMixSetting>) {
    const current = audioMixSettingsRef.current[sourceId] ?? { enabled: false, volume: 100 };
    const next = {
      ...audioMixSettingsRef.current,
      [sourceId]: { ...current, ...patch },
    };
    audioMixSettingsRef.current = next;
    setAudioMixSettings(next);
    if (programVideoTrack.current) void syncAudioMixer(audioSourcesRef.current, next, true);
  }

  async function syncAudioMixer(sources: AudioSource[], settings: Record<string, AudioMixSetting>, shouldPublish: boolean) {
    const selected = sources.filter((source) => settings[source.id]?.enabled);
    if (!programAudioEnabledRef.current || selected.length === 0) {
      await programAudioTrack.current?.mute();
      return;
    }

    prepareAudioMixerContext();
    const context = audioContextRef.current!;
    const destination = audioDestinationRef.current!;

    audioMixerNodesRef.current.forEach(({ source, gain }) => {
      source.disconnect();
      gain.disconnect();
    });
    audioMixerNodesRef.current.clear();

    selected.forEach((audioSource) => {
      const mediaStream = new MediaStream([audioSource.track.mediaStreamTrack]);
      const sourceNode = context.createMediaStreamSource(mediaStream);
      const gainNode = context.createGain();
      gainNode.gain.value = (settings[audioSource.id]?.volume ?? 100) / 100;
      sourceNode.connect(gainNode).connect(destination);
      audioMixerNodesRef.current.set(audioSource.id, { source: sourceNode, gain: gainNode });
    });

    if (shouldPublish && !programAudioTrack.current && outputPublisherRoom.current) {
      const mixedTrack = destination.stream.getAudioTracks()[0];
      const localAudio = new LocalAudioTrack(mixedTrack, undefined, true);
      await outputPublisherRoom.current.localParticipant.publishTrack(localAudio, {
        name: "program-audio",
        source: Track.Source.Microphone,
      });
      programAudioTrack.current = localAudio;
    } else {
      await programAudioTrack.current?.unmute();
    }
  }

  function prepareAudioMixerContext() {
    if (!audioContextRef.current || !audioDestinationRef.current) {
      const context = new AudioContext();
      audioContextRef.current = context;
      audioDestinationRef.current = context.createMediaStreamDestination();
    }
    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }
  }

  async function destroyAudioMixer() {
    audioMixerNodesRef.current.forEach(({ source, gain }) => {
      source.disconnect();
      gain.disconnect();
    });
    audioMixerNodesRef.current.clear();
    await audioContextRef.current?.close();
    audioContextRef.current = null;
    audioDestinationRef.current = null;
  }

  async function disconnectAll() {
    monitorRoom.current?.disconnect();
    outputPublisherRoom.current?.disconnect();
    publisherRoom.current?.disconnect();
    programVideoTrack.current?.stop();
    programAudioTrack.current?.stop();
    previewAudioElement.current?.remove();
    void destroyAudioMixer();
    monitorRoom.current = null;
    outputPublisherRoom.current = null;
    publisherRoom.current = null;
    programVideoTrack.current = null;
    programAudioTrack.current = null;
    previewAudioElement.current = null;
    programSwitchQueue.current = Promise.resolve();
    setViewerCount(0);
    if (outputVideo.current) outputVideo.current.srcObject = null;
    setCameras([]);
    setAudioSources([]);
    audioSourcesRef.current = [];
    setAudioMixSettings({});
    audioMixSettingsRef.current = {};
    setActiveCameraId(null);
    setMonitoredAudioSourceId(null);
  }

  async function leaveStudio() {
    await disconnectAll();
    setStatus("idle");
    setConnectionState("Disconnected");
    setMessage("หยุดการควบคุมรายการแล้ว");
  }

  const isLive = status === "live";
  const isConnected = status === "ready" || status === "live";
  const isBusy = status === "connecting";

  function attachProgramMonitorTrack(track: RemoteTrack, publication: RemoteTrackPublication) {
    if (publication.trackName === "program-video" && outputVideo.current) {
      track.attach(outputVideo.current);
    }
  }

  return (
    <main className="shell studio-page" style={{ paddingBottom: 120 }}>
      <header className="topbar">
        <Link className="brand" href="/">
          <div className="brand-dot" />
          LocalStream
        </Link>
        <div className="status-cluster" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <Badge variant="default" className="viewer-pill" style={{ display: "flex", gap: "6px" }}>
            <Users size={12} /> {viewerCount} ผู้ชม
          </Badge>
          <Badge variant={isLive ? "live" : "default"} showDot>
            {isLive ? "ON AIR" : isConnected ? "STUDIO READY" : "OFF AIR"}
          </Badge>
          <span className="connection text-sm">SFU · {connectionState}</span>
        </div>
      </header>

      <section className="studio-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "32px 0" }}>
        <div>
          <p className="eyebrow" style={{ color: "var(--brand-accent)", marginBottom: "8px" }}>BROADCAST CONTROL</p>
          <h1 className="h1">Studio</h1>
        </div>
        <div className="room-label text-sm" style={{ textAlign: "right" }}>
          <span style={{ display: "block", color: "var(--text-tertiary)", fontSize: "11px", letterSpacing: "0.1em", marginBottom: "4px" }}>
            ROOM {roomCode ? `· CODE ${roomCode}` : ""}
          </span>
          {channelByID(roomName).name} · {roomName}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: "24px", alignItems: "start" }}>
        {/* Left Column - Program Output */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <Card>
            <CardHeader style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <MonitorOff size={18} style={{ color: "var(--text-secondary)" }} />
                <span style={{ fontWeight: 600 }}>Program Output</span>
              </div>
              <span className="text-sm">ภาพที่ผู้ชมกำลังเห็น</span>
            </CardHeader>
            <CardBody style={{ padding: 0 }}>
              <div className="program-frame" style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
                <video ref={outputVideo} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                {!isLive && (
                  <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at center, #1a1a1a 0, #0a0a0a 100%)" }}>
                    <MonitorOff size={32} style={{ color: "var(--text-tertiary)", marginBottom: "16px" }} />
                    <span style={{ fontSize: "12px", letterSpacing: "0.15em", fontWeight: 600, color: "var(--text-secondary)" }}>PROGRAM OFF AIR</span>
                    <p className="text-sm" style={{ marginTop: "8px" }}>
                      {isConnected ? "เลือกกล้องและตรวจเสียง แล้วกดเริ่มถ่ายทอดสด" : "เข้าควบคุม Studio เพื่อดูสัญญาณกล้อง"}
                    </p>
                  </div>
                )}
                {isLive && activeCameraId && (
                  <Badge variant="live" showDot style={{ position: "absolute", top: "16px", left: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
                    LIVE · {activeCameraId.split('-').pop()}
                  </Badge>
                )}
              </div>
            </CardBody>
          </Card>

          {isConnected && (
            <Card>
              <CardBody style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 24px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span className="text-sm" style={{ letterSpacing: "0.1em", fontWeight: 600 }}>PRE-BROADCAST CHECK</span>
                  <strong style={{ fontSize: "15px" }}>{activeCameraId ? `กล้องเริ่มต้น: ${activeCameraId.split('-').pop()}` : "รอกล้องเชื่อมต่อ"}</strong>
                  <span className="text-sm" style={{ color: "var(--text-tertiary)", marginTop: "4px" }}>Output Session: {programRoomID(roomName)}</span>
                </div>
                <Button 
                  variant={programAudioEnabled ? "primary" : "secondary"} 
                  onClick={toggleProgramAudio}
                  style={{ gap: "8px" }}
                >
                  {programAudioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                  Program Audio: {programAudioEnabled ? "ON" : "OFF"}
                </Button>
              </CardBody>
            </Card>
          )}
        </div>

        {/* Right Column - Sources */}
        {isConnected && (
          <Card style={{ height: "100%", minHeight: "500px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
              <button 
                className={`studio-tabs-btn ${activeTab === "video" ? "active" : ""}`} 
                onClick={() => setActiveTab("video")}
                style={{ flex: 1, padding: "16px", background: activeTab === "video" ? "var(--bg-elevated)" : "transparent", border: "none", color: activeTab === "video" ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: 600, borderBottom: activeTab === "video" ? "2px solid var(--brand-accent)" : "2px solid transparent", cursor: "pointer", transition: "all 0.2s" }}
              >
                <Video size={14} style={{ display: "inline", marginRight: "6px", verticalAlign: "-2px" }} />
                Cameras <Badge variant="default" style={{ marginLeft: "4px", padding: "2px 6px", fontSize: "10px" }}>{cameras.length}</Badge>
              </button>
              <button 
                className={`studio-tabs-btn ${activeTab === "audio" ? "active" : ""}`} 
                onClick={() => setActiveTab("audio")}
                style={{ flex: 1, padding: "16px", background: activeTab === "audio" ? "var(--bg-elevated)" : "transparent", border: "none", color: activeTab === "audio" ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: 600, borderBottom: activeTab === "audio" ? "2px solid var(--brand-accent)" : "2px solid transparent", cursor: "pointer", transition: "all 0.2s" }}
              >
                <Mic size={14} style={{ display: "inline", marginRight: "6px", verticalAlign: "-2px" }} />
                Audio <Badge variant="default" style={{ marginLeft: "4px", padding: "2px 6px", fontSize: "10px" }}>{audioSources.length}</Badge>
              </button>
            </div>

            <div style={{ padding: "20px", flex: 1, overflowY: "auto" }}>
              {activeTab === "video" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {cameras.length === 0 ? (
                    <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-md)", color: "var(--text-tertiary)" }}>
                      <Video size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
                      <p className="text-sm">ยังไม่มีกล้องในห้อง<br />เปิด <b>/camera</b> แล้วกรอก Code <b>{roomCode}</b></p>
                    </div>
                  ) : (
                    cameras.map((camera) => (
                      <CameraPreviewCard 
                        key={camera.id} 
                        camera={camera} 
                        isActive={activeCameraId === camera.id} 
                        isLive={isLive} 
                        onTake={() => selectCamera(camera.id)}
                        onKick={() => disconnectSource(camera.id)}
                      />
                    ))
                  )}
                </div>
              )}

              {activeTab === "audio" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {audioSources.length === 0 ? (
                    <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-md)", color: "var(--text-tertiary)" }}>
                      <Mic size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
                      <p className="text-sm">ยังไม่มีแหล่งเสียง<br />เชื่อมกล้องหรือเปิด <b>/microphone</b></p>
                    </div>
                  ) : (
                    audioSources.map((source) => (
                      <AudioSourceRow
                        key={source.id}
                        source={source}
                        setting={audioMixSettings[source.id] ?? { enabled: false, volume: 100 }}
                        isMonitoring={monitoredAudioSourceId === source.id}
                        onToggleEnabled={() => updateAudioMix(source.id, { enabled: !(audioMixSettings[source.id]?.enabled ?? false) })}
                        onVolume={(volume) => updateAudioMix(source.id, { volume })}
                        onMonitor={() => setMonitoredAudioSourceId((current) => current === source.id ? null : source.id)}
                        onRemove={() => disconnectSource(source.id)}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>

      <footer className="control-dock" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 24px", background: "rgba(10,10,10,0.85)", backdropFilter: "blur(12px)", borderTop: "1px solid var(--border-strong)", zIndex: 100 }}>
        <div style={{ color: status === "error" ? "var(--danger)" : "var(--text-secondary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          {status === "error" && <UserX size={16} />}
          {message}
        </div>
        <div className="dock-actions" style={{ display: "flex", gap: "12px" }}>
          {!isConnected && (
            <Button variant="primary" disabled={isBusy} onClick={connectStudio} isLoading={isBusy}>
              <Play size={16} /> เข้าควบคุม Studio
            </Button>
          )}
          {status === "ready" && (
            <Button variant="primary" disabled={broadcastBusy || !activeCameraId} onClick={startBroadcast} isLoading={broadcastBusy} style={{ background: "var(--danger)", color: "white" }}>
              <RadioTower size={16} /> เริ่มถ่ายทอดสด
            </Button>
          )}
          {isLive && (
            <Button variant="danger" disabled={broadcastBusy} onClick={stopBroadcast} isLoading={broadcastBusy}>
              <Square size={16} /> หยุดถ่ายทอดสด
            </Button>
          )}
          {isConnected && (
            <Button variant="ghost" onClick={leaveStudio}>ออกจาก Studio</Button>
          )}
          <Link href={`/watch?channel=${roomName}`} target="_blank">
            <Button variant="secondary">เปิดหน้าผู้ชม ↗</Button>
          </Link>
          <Link href="/channels">
            <Button variant="ghost">Channel ทั้งหมด</Button>
          </Link>
        </div>
      </footer>
    </main>
  );
}

function CameraPreviewCard({ camera, isActive, isLive, onTake, onKick }: { camera: CameraSource, isActive: boolean, isLive: boolean, onTake: () => void, onKick?: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        if (camera.videoTrack && videoRef.current) {
            camera.videoTrack.attach(videoRef.current);
        }
    }, [camera.videoTrack]);

    return (
      <Card style={{ overflow: "hidden", borderColor: isActive ? "var(--brand-accent)" : "var(--border-subtle)", boxShadow: isActive ? "0 0 0 1px var(--brand-accent)" : "none", transition: "all 0.2s ease" }}>
        <div style={{ position: "relative", aspectRatio: "16/9", background: "#000" }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          {!camera.videoTrack && <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", color: "var(--text-tertiary)", fontSize: "12px", fontWeight: 600 }}>NO SIGNAL</div>}
          {isActive && (
            <Badge variant={isLive ? "live" : "success"} showDot style={{ position: "absolute", top: "8px", right: "8px" }}>
              {isLive ? "PROGRAM" : "SELECTED"}
            </Badge>
          )}
        </div>
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px", background: "var(--bg-surface)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>{camera.label}</span>
              <span className="text-sm" style={{ fontSize: "11px" }}>{camera.id.split('-').pop()}</span>
            </div>
            {onKick && (
              <button onClick={onKick} style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "4px" }}>
                <X size={14} />
              </button>
            )}
          </div>
          <Button 
            variant={isActive ? (isLive ? "danger" : "primary") : "secondary"} 
            size="sm" 
            disabled={isActive} 
            onClick={onTake}
            style={{ width: "100%" }}
          >
            {isActive ? (isLive ? "กำลังออกอากาศ" : "กล้องเริ่มต้น") : `เลือก ${camera.label}`}
          </Button>
        </div>
      </Card>
    );
}

function AudioSourceRow({ source, setting, isMonitoring, onToggleEnabled, onVolume, onMonitor, onRemove }: {
  source: AudioSource;
  setting: AudioMixSetting;
  isMonitoring: boolean;
  onToggleEnabled: () => void;
  onVolume: (volume: number) => void;
  onMonitor: () => void;
  onRemove: () => void;
}) {
  return (
    <Card style={{ padding: "16px", borderColor: setting.enabled ? "var(--success)" : "var(--border-subtle)", background: setting.enabled ? "var(--success-bg)" : "var(--bg-surface)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <button onClick={onToggleEnabled} style={{ display: "flex", alignItems: "center", gap: "12px", background: "transparent", border: "none", color: "var(--text-primary)", cursor: "pointer", padding: 0, textAlign: "left" }}>
          <div style={{ width: "20px", height: "20px", borderRadius: "4px", border: `1px solid ${setting.enabled ? "var(--success)" : "var(--text-tertiary)"}`, background: setting.enabled ? "var(--success)" : "transparent", display: "grid", placeContent: "center", transition: "all 0.2s" }}>
            {setting.enabled && <CheckCircle2 size={14} color="#000" />}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: "14px", fontWeight: 600 }}>{source.label}</span>
            <span style={{ fontSize: "10px", color: "var(--text-tertiary)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
              {source.kind} · {source.id.split('-').pop()}
            </span>
          </div>
        </button>
        <button onClick={onRemove} style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "4px" }}>
          <X size={14} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-secondary)", fontWeight: 600 }}>
          <span>VOLUME</span>
          <span>{setting.volume}%</span>
        </div>
        <input 
          type="range" 
          min="0" 
          max="150" 
          value={setting.volume} 
          onChange={(event) => onVolume(Number(event.target.value))} 
          style={{ width: "100%", accentColor: setting.enabled ? "var(--success)" : "var(--brand-accent)", cursor: "pointer" }}
        />
      </div>

      <Button variant={isMonitoring ? "primary" : "secondary"} size="sm" onClick={onMonitor} style={{ width: "100%" }}>
        {isMonitoring ? "หยุดฟัง" : "ฟังเสียง"}
      </Button>
    </Card>
  );
}
