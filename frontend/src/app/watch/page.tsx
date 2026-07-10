"use client";

import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { getConnectionToken, getProgramScene, participantID } from "@/lib/api";
import { channelByID, channelIDFromSearch, DEFAULT_CHANNEL_ID, programRoomID } from "@/lib/channels";
import { SceneOverlay } from "@/components/studio/scene-editor";
import { emptyProgramScene, type ProgramScene } from "@/lib/scene";
import { Users, Volume2, VolumeX, MonitorOff } from "lucide-react";
export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<Room | null>(null);
  const selectedVideoTrack = useRef<RemoteTrack | null>(null);
  const directVideoTrack = useRef<RemoteTrack | null>(null);
  const composedVideoTrack = useRef<RemoteTrack | null>(null);
  const composedVideoPublication = useRef<RemoteTrackPublication | null>(null);
  const audioElements = useRef<HTMLAudioElement[]>([]);
  const audioEnabledRef = useRef(false);
  const autoWatchStarted = useRef(false);
  const connectingRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "watching" | "error">("idle");
  const [message, setMessage] = useState("กำลังเตรียมเชื่อมต่อ Live Stream…");
  const [viewerCount, setViewerCount] = useState(0);
  const [hasProgramVideo, setHasProgramVideo] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [roomName, setRoomName] = useState(DEFAULT_CHANNEL_ID);
  const [programScene, setProgramScene] = useState<ProgramScene>(() => emptyProgramScene(DEFAULT_CHANNEL_ID));

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  useEffect(() => {
    const nextRoomName = channelIDFromSearch(window.location.search);
    setRoomName(nextRoomName);
    if (!autoWatchStarted.current) {
      autoWatchStarted.current = true;
      void watch(nextRoomName);
    }
    // watch() intentionally reads the latest refs/state; this effect should
    // auto-join only once when the viewer opens the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void getProgramScene(roomName).then(setProgramScene).catch(() => {});
  }, [roomName]);

  async function watch(targetRoomName = roomName) {
    if (connectingRef.current || roomRef.current) return;
    connectingRef.current = true;
    setStatus("connecting");
    setMessage("กำลังเชื่อมต่อ…");
    try {
      const credentials = await getConnectionToken(participantID("viewer"), programRoomID(targetRoomName), "viewer", "d1");
      const room = new Room({ adaptiveStream: false, dynacast: false });
      const refreshViewerCount = () => {
        const remoteViewers = Array.from(room.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith("viewer-")).length;
        const localViewer = room.localParticipant.identity.startsWith("viewer-") ? 1 : 0;
        setViewerCount(remoteViewers + localViewer);
      };

      const subscribeToProgram = (publication: RemoteTrackPublication) => {
        if (
          publication.trackName === "program-video" ||
          publication.trackName === "compositor-preview-video" ||
          publication.trackName === "program-audio"
        ) {
          publication.setSubscribed(true);
        }
      };

      room.on(RoomEvent.TrackPublished, subscribeToProgram);
      room.on(RoomEvent.TrackSubscribed, attachProgramTrack);
      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        track.detach();
        if (directVideoTrack.current === track) directVideoTrack.current = null;
        if (composedVideoTrack.current === track) {
          composedVideoTrack.current = null;
          composedVideoPublication.current = null;
        }
        if (publication.trackName !== "program-audio") selectViewerVideo();
      });
      room.on(RoomEvent.TrackMuted, (publication) => {
        if (publication.trackName === "compositor-preview-video") selectViewerVideo();
      });
      room.on(RoomEvent.TrackUnmuted, (publication) => {
        if (publication.trackName === "compositor-preview-video") selectViewerVideo();
      });
      room.on(RoomEvent.ParticipantConnected, refreshViewerCount);
      room.on(RoomEvent.ParticipantDisconnected, refreshViewerCount);
      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const message = JSON.parse(new TextDecoder().decode(payload)) as { type?: string; scene?: ProgramScene };
          if (message.type === "program-scene" && message.scene) setProgramScene(message.scene);
        } catch {
          // Ignore unrelated or malformed data packets.
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === room) roomRef.current = null;
        audioElements.current.forEach((element) => element.remove());
        audioElements.current = [];
        selectedVideoTrack.current = null;
        directVideoTrack.current = null;
        composedVideoTrack.current = null;
        composedVideoPublication.current = null;
        setHasProgramVideo(false);
        setAudioEnabled(false);
        audioEnabledRef.current = false;
        if (videoRef.current) videoRef.current.srcObject = null;
        setStatus("idle");
        setViewerCount(0);
        setMessage("การเชื่อมต่อสิ้นสุดแล้ว");
      });

      await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
      roomRef.current = room;
      refreshViewerCount();
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach(subscribeToProgram);
      });
      setStatus("watching");
      setMessage("กำลังรับชมแบบ Real-time");
    } catch (error) {
      disconnect();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ");
    } finally {
      connectingRef.current = false;
    }
  }

  function disconnect() {
    connectingRef.current = false;
    roomRef.current?.disconnect();
    roomRef.current = null;
    audioElements.current.forEach((element) => element.remove());
    audioElements.current = [];
    selectedVideoTrack.current = null;
    directVideoTrack.current = null;
    composedVideoTrack.current = null;
    composedVideoPublication.current = null;
    setHasProgramVideo(false);
    setAudioEnabled(false);
    audioEnabledRef.current = false;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function attachProgramTrack(track: RemoteTrack, publication: RemoteTrackPublication) {
    if (track.kind === Track.Kind.Video) {
      if (publication.trackName === "program-video") directVideoTrack.current = track;
      if (publication.trackName === "compositor-preview-video") {
        composedVideoTrack.current = track;
        composedVideoPublication.current = publication;
      }
      selectViewerVideo();
    }
    if (publication.trackName === "program-audio" && track.kind === Track.Kind.Audio) {
      audioElements.current.forEach((element) => element.remove());
      audioElements.current = [];
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true;
      element.muted = !audioEnabledRef.current;
      document.body.appendChild(element);
      audioElements.current.push(element);
      void element.play().catch(() => undefined);
    }
  }

  function selectViewerVideo() {
    const composed = composedVideoTrack.current;
    const composedReady = composed && !composedVideoPublication.current?.isMuted;
    const next = directVideoTrack.current ?? (composedReady ? composed : null);

    if (selectedVideoTrack.current !== next) {
      selectedVideoTrack.current?.detach();
      selectedVideoTrack.current = next;
      if (next && videoRef.current) next.attach(videoRef.current);
    }
    setHasProgramVideo(Boolean(next));
  }

  async function toggleAudio() {
    const next = !audioEnabledRef.current;
    if (next) {
      try {
        await roomRef.current?.startAudio();
        audioElements.current.forEach((element) => { element.muted = false; });
        await Promise.all(audioElements.current.map((element) => element.play()));
      } catch {
        setMessage("เบราว์เซอร์ไม่สามารถเปิดเสียงได้");
        return;
      }
    } else {
      audioElements.current.forEach((element) => { element.muted = true; });
    }
    audioEnabledRef.current = next;
    setAudioEnabled(next);
  }

  const watching = status === "watching";
  const receivingProgram = watching && hasProgramVideo;

  return (
    <main className="viewer-experience">
      <div className="viewer-experience-frame">
        <video ref={videoRef} autoPlay playsInline />
            {receivingProgram && (
              <SceneOverlay
                layers={programScene.layers}
                selectedID={null}
                disabled
                onSelect={() => {}}
                onChange={() => {}}
              />
            )}
            
        {!receivingProgram && <div className="viewer-waiting"><MonitorOff size={42} /><strong>{status === "error" ? "CONNECTION ERROR" : "WAITING FOR LIVE"}</strong><p>{status === "error" ? message : watching ? "รอผู้ควบคุมเริ่มถ่ายทอดสด" : "กำลังเชื่อมต่อ Live Stream…"}</p></div>}
        <header className="viewer-experience-header"><div><span className={receivingProgram ? "live" : ""}><i /> {receivingProgram ? "LIVE" : "WAITING"}</span><strong>{channelByID(roomName).name}</strong></div><small><Users size={13} /> {viewerCount}</small></header>
        <button className={`viewer-audio-toggle ${audioEnabled ? "enabled" : ""}`} onClick={toggleAudio} aria-label={audioEnabled ? "ปิดเสียง" : "เปิดเสียง"}>{audioEnabled ? <Volume2 size={21} /> : <VolumeX size={21} />}<span>{audioEnabled ? "ปิดเสียง" : "เปิดเสียง"}</span></button>
      </div>
    </main>
  );
}
