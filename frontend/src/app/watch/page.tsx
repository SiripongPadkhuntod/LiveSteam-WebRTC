"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { getConnectionToken, participantID } from "@/lib/api";
import { channelByID, channelIDFromSearch, DEFAULT_CHANNEL_ID, programRoomID } from "@/lib/channels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { Users, Play, Square, Volume2, MonitorOff, UserX, Maximize, Minimize, Info } from "lucide-react";
export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerFrameRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const audioElements = useRef<HTMLAudioElement[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "watching" | "error">("idle");
  const [message, setMessage] = useState("กดรับชมเพื่อเชื่อมต่อ Live Stream");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [hasProgramVideo, setHasProgramVideo] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [roomName, setRoomName] = useState(DEFAULT_CHANNEL_ID);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFallbackFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("keydown", handleEscape);
      disconnect();
    };
  }, []);

  useEffect(() => {
    setRoomName(channelIDFromSearch(window.location.search));
  }, []);

  async function watch() {
    setStatus("connecting");
    setMessage("กำลังเชื่อมต่อ…");
    try {
      const credentials = await getConnectionToken(participantID("viewer"), programRoomID(roomName), "viewer");
      const room = new Room({ adaptiveStream: true });
      const refreshViewerCount = () => {
        const remoteViewers = Array.from(room.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith("viewer-")).length;
        const localViewer = room.localParticipant.identity.startsWith("viewer-") ? 1 : 0;
        setViewerCount(remoteViewers + localViewer);
      };

      const subscribeToProgram = (publication: RemoteTrackPublication) => {
        if (publication.trackName === "program-video" || publication.trackName === "program-audio") {
          publication.setSubscribed(true);
        }
      };

      room.on(RoomEvent.TrackPublished, subscribeToProgram);
      room.on(RoomEvent.TrackSubscribed, attachProgramTrack);
      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        track.detach();
        if (publication.trackName === "program-video") setHasProgramVideo(false);
      });
      room.on(RoomEvent.ParticipantConnected, refreshViewerCount);
      room.on(RoomEvent.ParticipantDisconnected, refreshViewerCount);
      room.on(RoomEvent.Disconnected, () => {
        setStatus("idle");
        setViewerCount(0);
        setMessage("การเชื่อมต่อสิ้นสุดแล้ว");
      });

      await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
      roomRef.current = room;
      void room.startAudio().catch(() => setAudioBlocked(true));
      refreshViewerCount();
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach(subscribeToProgram);
      });
      setStatus("watching");
      setMessage("กำลังรับชมแบบ Real-time");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ");
    }
  }

  function disconnect() {
    roomRef.current?.disconnect();
    roomRef.current = null;
    audioElements.current.forEach((element) => element.remove());
    audioElements.current = [];
    setHasProgramVideo(false);
    setAudioBlocked(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function attachProgramTrack(track: RemoteTrack, publication: RemoteTrackPublication) {
    if (publication.trackName === "program-video" && track.kind === Track.Kind.Video && videoRef.current) {
      track.attach(videoRef.current);
      setHasProgramVideo(true);
    }
    if (publication.trackName === "program-audio" && track.kind === Track.Kind.Audio) {
      audioElements.current.forEach((element) => element.remove());
      audioElements.current = [];
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true;
      document.body.appendChild(element);
      audioElements.current.push(element);
      void element.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    }
  }

  async function enableAudio() {
    await roomRef.current?.startAudio();
    await Promise.all(audioElements.current.map((element) => element.play()));
    setAudioBlocked(false);
  }

  function stopWatching() {
    disconnect();
    setStatus("idle");
    setViewerCount(0);
    setMessage("หยุดรับชมแล้ว");
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false);
      return;
    }

    if (viewerFrameRef.current?.requestFullscreen) {
      try {
        await viewerFrameRef.current.requestFullscreen();
        return;
      } catch {
        setIsFallbackFullscreen(true);
        return;
      }
    }

    const iosVideo = videoRef.current as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (iosVideo?.webkitEnterFullscreen) {
      iosVideo.webkitEnterFullscreen();
      return;
    }
    setIsFallbackFullscreen(true);
  }

  const watching = status === "watching";
  const receivingProgram = watching && hasProgramVideo;

  return (
    <main className="watch-page" style={{ paddingBottom: 120 }}>
      <header className="topbar">
        <Link className="brand" href="/">
          <div className="brand-dot" />
          LocalStream
        </Link>
        <div className="status-cluster" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <Badge variant="default" className="viewer-pill" style={{ display: "flex", gap: "6px" }}>
            <Users size={12} /> {viewerCount} ผู้ชม
          </Badge>
          <Badge variant={receivingProgram ? "live" : "default"} showDot>
            {receivingProgram ? "LIVE" : watching ? "CONNECTED · WAITING" : "OFFLINE"}
          </Badge>
        </div>
      </header>

      <section className="watch-content shell" style={{ display: "grid", gridTemplateColumns: "1fr", gap: "32px", padding: "40px 0", maxWidth: "1200px", margin: "0 auto" }}>
        <div className="watch-copy" style={{ textAlign: "center", maxWidth: "600px", margin: "0 auto" }}>
          <p className="eyebrow" style={{ color: "var(--brand-accent)", marginBottom: "8px" }}>LIVE CHANNEL</p>
          <h1 className="h1">{channelByID(roomName).name}</h1>
          <p className="text-body" style={{ marginTop: "16px" }}>ภาพ Program Output จากผู้ควบคุม คุณจะได้รับภาพและเสียงที่ถูกเลือกให้ออกอากาศโดยอัตโนมัติ</p>
          
          <div style={{ marginTop: "32px", display: "flex", justifyContent: "center", gap: "12px" }}>
            {!watching ? (
              <Button variant="primary" size="lg" disabled={status === "connecting"} onClick={watch} isLoading={status === "connecting"} style={{ background: "var(--danger)", color: "white" }}>
                <Play size={18} /> รับชม Live
              </Button>
            ) : (
              <div className="viewer-actions" style={{ display: "flex", gap: "12px" }}>
                {audioBlocked && (
                  <Button variant="primary" onClick={enableAudio}>
                    <Volume2 size={16} /> เปิดเสียง
                  </Button>
                )}
                <Button variant="danger" onClick={stopWatching}>
                  <Square size={16} /> หยุดรับชม
                </Button>
              </div>
            )}
          </div>
          
          {status === "error" && (
            <div style={{ color: "var(--danger)", marginTop: "16px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
              <UserX size={16} /> {message}
            </div>
          )}
        </div>

        <Card style={{ overflow: "hidden", border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-lg)" }}>
          <div className={`viewer-frame ${isFallbackFullscreen ? "fallback-fullscreen" : ""}`} ref={viewerFrameRef} style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
            <video ref={videoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            
            {!receivingProgram && (
              <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at center, #1a1a1a 0, #0a0a0a 100%)" }}>
                <MonitorOff size={48} style={{ color: "var(--text-tertiary)", marginBottom: "24px" }} />
                <span style={{ fontSize: "14px", letterSpacing: "0.15em", fontWeight: 600, color: "var(--text-secondary)" }}>WAITING FOR PROGRAM</span>
                <p className="text-sm" style={{ marginTop: "12px" }}>
                  {watching ? "เชื่อมต่อแล้ว · รอผู้ควบคุมเริ่มถ่ายทอดสด" : `Channel · ${roomName}`}
                </p>
              </div>
            )}
            
            {receivingProgram && (
              <Badge variant="live" showDot style={{ position: "absolute", top: "24px", left: "24px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", padding: "6px 12px", fontSize: "13px" }}>
                LIVE
              </Badge>
            )}
            
            {receivingProgram && (
              <Button 
                variant="secondary"
                size="sm"
                onClick={toggleFullscreen} 
                style={{ position: "absolute", bottom: "24px", right: "24px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", border: "1px solid var(--border-subtle)", color: "white" }}
              >
                {isFullscreen || isFallbackFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                {isFullscreen || isFallbackFullscreen ? "ออกจากเต็มจอ" : "เต็มจอ"}
              </Button>
            )}
          </div>
        </Card>
      </section>
    </main>
  );
}
