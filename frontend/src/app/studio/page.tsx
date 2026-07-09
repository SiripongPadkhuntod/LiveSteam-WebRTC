"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { ensureProgramBridge, getConnectionToken, getProgramScene } from "@/lib/api";
import { channelByID, channelIDFromSearch, DEFAULT_CHANNEL_ID, programRoomID } from "@/lib/channels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SceneCollectionPanel, SceneLayerPanel, SceneOverlay, type StudioSceneItem } from "@/components/studio/scene-editor";
import { emptyProgramScene, type ProgramScene, type SceneImageLayer } from "@/lib/scene";
import { RadioTower, Users, Video, Mic, Play, Square, Volume2, VolumeX, MonitorOff, UserX, CheckCircle2, X } from "lucide-react";

type CameraSource = {
  id: string;
  label: string;
  participant: RemoteParticipant;
  videoTrack?: Track;
  videoPublication?: RemoteTrackPublication;
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

type StudioScene = StudioSceneItem & { scene: ProgramScene; cameraSourceIDs: string[] };

export default function StudioPage() {
  const outputVideo = useRef<HTMLVideoElement>(null);
  const publisherRoom = useRef<Room | null>(null);
  const outputPublisherRoom = useRef<Room | null>(null);
  const programMonitorVideoTrack = useRef<RemoteTrack | null>(null);
  const directProgramVideoTrack = useRef<RemoteTrack | null>(null);
  const composedProgramVideoTrack = useRef<RemoteTrack | null>(null);
  const composedProgramPublication = useRef<RemoteTrackPublication | null>(null);
  const programAudioTrack = useRef<LocalAudioTrack | null>(null);
  const previewAudioElement = useRef<HTMLAudioElement | null>(null);
  const programAudioEnabledRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioMixerNodesRef = useRef(new Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode }>());
  const audioSourcesRef = useRef<AudioSource[]>([]);
  const audioMixSettingsRef = useRef<Record<string, AudioMixSetting>>({});
  const sceneDirtyRef = useRef(false);

  const [cameras, setCameras] = useState<CameraSource[]>([]);
  const [audioSources, setAudioSources] = useState<AudioSource[]>([]);
  const [audioMixSettings, setAudioMixSettings] = useState<Record<string, AudioMixSetting>>({});
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const [previewCameraId, setPreviewCameraId] = useState<string | null>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const [monitoredAudioSourceId, setMonitoredAudioSourceId] = useState<string | null>(null);

  const [programAudioEnabled, setProgramAudioEnabled] = useState(true);
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "live" | "error">("idle");
  const [message, setMessage] = useState("พร้อมเริ่มรายการ");
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [viewerCount, setViewerCount] = useState(0);
  const [roomName, setRoomName] = useState(DEFAULT_CHANNEL_ID);
  const [roomCode, setRoomCode] = useState("");
  const [scene, setScene] = useState(() => emptyProgramScene(DEFAULT_CHANNEL_ID));
  const [programScene, setProgramScene] = useState<ProgramScene>(() => emptyProgramScene(DEFAULT_CHANNEL_ID));
  const [studioScenes, setStudioScenes] = useState<StudioScene[]>(() => [{ key: "scene-1", name: "Scene 1", scene: emptyProgramScene(DEFAULT_CHANNEL_ID), cameraSourceIDs: [] }]);
  const [sceneCameraSourceIDs, setSceneCameraSourceIDs] = useState<string[]>([]);
  const [selectedSceneKey, setSelectedSceneKey] = useState("scene-1");
  const [programSceneKey, setProgramSceneKey] = useState<string | null>(null);
  const [previewSceneDirty, setPreviewSceneDirty] = useState(false);
  const [loadedSceneRoom, setLoadedSceneRoom] = useState<string | null>(null);
  const [selectedSceneLayerID, setSelectedSceneLayerID] = useState<string | null>(null);

  const activeCameraIdRef = useRef<string | null>(null);
  const previewCameraIdRef = useRef<string | null>(null);
  const sceneSourceIdRef = useRef<string | undefined>(scene.sourceId);
  const programSceneRef = useRef(programScene);
  const statusRef = useRef(status);
  const connectingRef = useRef(false);
  
  useEffect(() => {
    setRoomName(channelIDFromSearch(window.location.search));
    setRoomCode(new URLSearchParams(window.location.search).get("code")?.toUpperCase() ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadedSceneRoom(null);
    setSelectedSceneLayerID(null);
    void getProgramScene(roomName).then((serverScene) => {
      if (cancelled) return;
      const legacyValue = window.localStorage.getItem(`localstream-scene:${roomName}`);
      if (legacyValue && serverScene.layers.length === 0) {
        try {
          const legacyScene = JSON.parse(legacyValue) as typeof serverScene;
          if (legacyScene.layers?.length) {
            legacyScene.revision = Math.max(serverScene.revision + 1, legacyScene.revision);
            initializeStudioScenes(legacyScene);
            sceneDirtyRef.current = true;
            setLoadedSceneRoom(roomName);
            return;
          }
        } catch { /* ignore invalid legacy scene */ }
      }
      sceneDirtyRef.current = false;
      initializeStudioScenes(serverScene);
      setLoadedSceneRoom(roomName);
    }).catch((error) => {
      if (cancelled) return;
      setScene(emptyProgramScene(roomName));
      setProgramScene(emptyProgramScene(roomName));
      setMessage(error instanceof Error ? error.message : "โหลด Scene ไม่สำเร็จ");
    });
    return () => { cancelled = true; };
  }, [roomName]);

  useEffect(() => {
    if (loadedSceneRoom !== roomName) return;
    window.localStorage.setItem(`localstream-studio-scenes:${roomName}`, JSON.stringify(studioScenes));
  }, [loadedSceneRoom, roomName, studioScenes]);

  useEffect(() => {
    activeCameraIdRef.current = activeCameraId;
  }, [activeCameraId]);

  useEffect(() => {
    previewCameraIdRef.current = previewCameraId;
  }, [previewCameraId]);

  useEffect(() => {
    programSceneRef.current = programScene;
  }, [programScene]);

  useEffect(() => {
    sceneSourceIdRef.current = scene.sourceId;
  }, [scene.sourceId]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Before going live, Program Output is a local confidence preview of the
  // selected source. While live, the same element shows D1's return feed.
  useEffect(() => {
    const element = outputVideo.current;
    if (!element) return;

    cameras.forEach((camera) => camera.videoTrack?.detach(element));
    programMonitorVideoTrack.current?.detach(element);

    if (status === "live") {
      programMonitorVideoTrack.current?.attach(element);
      return;
    }
    if (status === "ready" && activeCameraId) {
      cameras.find((camera) => camera.id === activeCameraId)?.videoTrack?.attach(element);
    }
  }, [activeCameraId, cameras, status]);

  useEffect(() => {
    const element = previewVideo.current;
    if (!element) return;

    cameras.forEach((camera) => camera.videoTrack?.detach(element));

    if (previewCameraId) {
      cameras.find((camera) => camera.id === previewCameraId)?.videoTrack?.attach(element);
    }
  }, [previewCameraId, cameras]);

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
    element.volume = Math.min(1, Math.max(0, (audioMixSettingsRef.current[monitoredAudioSourceId]?.volume ?? 100) / 100));
    document.body.appendChild(element);
    previewAudioElement.current = element;
    return () => {
      element.remove();
      if (previewAudioElement.current === element) previewAudioElement.current = null;
    };
  }, [audioSources, monitoredAudioSourceId]);

  useEffect(() => {
    if (previewAudioElement.current && monitoredAudioSourceId) {
      previewAudioElement.current.volume = Math.min(1, Math.max(0, (audioMixSettings[monitoredAudioSourceId]?.volume ?? 100) / 100));
    }
  }, [audioMixSettings, monitoredAudioSourceId]);

  useEffect(() => () => {
    outputPublisherRoom.current?.disconnect();
    publisherRoom.current?.disconnect();
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
                   videoPublication: videoPub,
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
    if (connectingRef.current) return;
    connectingRef.current = true;
    setStatus("connecting");
    setMessage("กำลังเชื่อมต่อ LiveKit…");
    try {
      await disconnectAll();
      const studioIdentity = `studio-${roomName}`;
      
      // Connect to the Channel room
      const broadcaster = await getConnectionToken(studioIdentity, roomName, "broadcaster");
      const pubRoom = new Room({ adaptiveStream: false, dynacast: false });
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
           if (programAudioTrack.current) void syncAudioMixer(audio, next, true);
           return next;
         });
         
         const configuredCamera = cams.find((camera) => camera.id === sceneSourceIdRef.current && camera.videoTrack);
         const activeCamera = cams.find((camera) => camera.id === activeCameraIdRef.current && camera.videoTrack);
         setPreviewCameraId(configuredCamera?.id ?? null);
         if (!activeCamera) setActiveCameraId(configuredCamera?.id ?? null);
         setInputVideoQuality(cams, activeCamera?.id ?? configuredCamera?.id ?? null, configuredCamera?.id ?? null);
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

      await ensureProgramBridge(roomName);

      // The Go RTP bridge is the only Publisher Session on D1. Studio joins
      // as a monitor/controller and never re-encodes Program video.
      const outputRoomName = programRoomID(roomName);
      const outputCredentials = await getConnectionToken(`studio-${roomName}-d1-monitor`, outputRoomName, "monitor", "d1");
      const outRoom = new Room({
        adaptiveStream: false,
        dynacast: false,
      });
      const refreshViewerCount = () => {
        const viewers = Array.from(outRoom.remoteParticipants.values())
          .filter((participant) => participant.identity.startsWith("viewer-")).length;
        setViewerCount(viewers);
      };
      outRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        refreshViewerCount();
        if (participant.identity.startsWith("viewer-")) {
          void publishProgramSceneSnapshot(programSceneRef.current, outRoom, [participant.identity]);
        }
      });
      outRoom.on(RoomEvent.ParticipantDisconnected, refreshViewerCount);
      const subscribeToProgram = (publication: RemoteTrackPublication) => {
        if (publication.trackName === "program-video" || publication.trackName === "program-audio" || publication.trackName === "compositor-preview-video") {
          publication.setSubscribed(true);
        }
      };
      outRoom.on(RoomEvent.TrackPublished, subscribeToProgram);
      outRoom.on(RoomEvent.TrackSubscribed, attachProgramMonitorTrack);
      outRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        if (programMonitorVideoTrack.current === track) programMonitorVideoTrack.current = null;
        if (directProgramVideoTrack.current === track) directProgramVideoTrack.current = null;
        if (composedProgramVideoTrack.current === track) composedProgramVideoTrack.current = null;
      });
      outRoom.on(RoomEvent.TrackUnmuted, (publication) => {
        if (publication.trackName === "compositor-preview-video") selectD1MonitorTrack();
      });
      outRoom.on(RoomEvent.TrackMuted, (publication) => {
        if (publication.trackName === "compositor-preview-video") selectD1MonitorTrack();
      });
      await outRoom.connect(outputCredentials.url, outputCredentials.token, { autoSubscribe: false });
      outRoom.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach(subscribeToProgram);
      });
      refreshViewerCount();
      outputPublisherRoom.current = outRoom;

      setStatus("ready");
      setMessage("Studio พร้อมแล้ว · ตรวจภาพและเสียงก่อนเริ่มถ่ายทอดสด");
    } catch (error) {
      await disconnectAll();
      setStatus("error");
      const detail = error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ";
      setMessage(detail.includes("Abort handler called") ? "การเชื่อมต่อ LiveKit ถูกยกเลิกกลางทาง · กรุณาลองกดเข้าควบคุม Studio ใหม่" : detail);
    } finally {
      connectingRef.current = false;
    }
  }

  async function switchCamera(id: string, sources: CameraSource[] = cameras) {
    const camera = sources.find((source) => source.id === id);
    if (!camera?.videoTrack) throw new Error(`กล้อง ${id} ยังไม่มี Video Track`);
    camera.videoPublication?.setVideoQuality(VideoQuality.HIGH);
    await sendBridgeControl("program-switch", id);
    setActiveCameraId(id);
    setInputVideoQuality(sources, id, previewCameraId);
    setMessage(`เปลี่ยน Program เป็น ${id} แล้ว · RTP passthrough`);
  }

  function selectCameraSource(id: string | null) {
    if (id && !cameras.some((camera) => camera.id === id && camera.videoTrack)) {
      setMessage("เพิ่มกล้องไม่ได้ เพราะกล้องไม่ได้เชื่อมต่ออยู่ใน Cameras");
      return;
    }
    sceneDirtyRef.current = true;
    setPreviewSceneDirty(true);
    setSelectedSceneLayerID(null);
    const nextScene = {
      ...scene,
      sourceId: id ?? undefined,
      revision: scene.revision + 1,
    };
    commitSelectedStudioScene(nextScene);
    setPreviewCameraId(id);
    setInputVideoQuality(cameras, activeCameraId, id);
    setMessage(id ? `เลือกกล้อง ${id.split('-').pop()} เป็น Preview แล้ว` : "ยังไม่ได้เลือกกล้องสำหรับ Preview");
  }

  function addCameraSource(id: string) {
    if (!cameras.some((camera) => camera.id === id && camera.videoTrack)) {
      setMessage("เพิ่มกล้องไม่ได้ เพราะกล้องไม่ได้เชื่อมต่ออยู่ใน Cameras");
      return;
    }
    sceneDirtyRef.current = true;
    setPreviewSceneDirty(true);
    setSelectedSceneLayerID(null);
    const nextCameraIDs = sceneCameraSourceIDs.includes(id) ? sceneCameraSourceIDs : [...sceneCameraSourceIDs, id];
    const nextScene = { ...scene, sourceId: id, revision: scene.revision + 1 };
    commitSelectedStudioScene(nextScene, nextCameraIDs);
    setPreviewCameraId(id);
    setInputVideoQuality(cameras, activeCameraId, id);
    setMessage(`เพิ่มกล้อง ${id.split('-').pop()} เข้า Sources และเลือกเป็น Preview แล้ว`);
  }

  function removeCameraSource(id: string) {
    sceneDirtyRef.current = true;
    setPreviewSceneDirty(true);
    const nextCameraIDs = sceneCameraSourceIDs.filter((cameraID) => cameraID !== id);
    const isSelectedSource = scene.sourceId === id;
    const nextScene = {
      ...scene,
      sourceId: isSelectedSource ? undefined : scene.sourceId,
      revision: scene.revision + 1,
    };
    commitSelectedStudioScene(nextScene, nextCameraIDs);
    if (isSelectedSource) {
      setPreviewCameraId(null);
      setInputVideoQuality(cameras, activeCameraId, null);
      setMessage("นำกล้องออกจาก Sources แล้ว · ยังไม่ได้เลือกกล้องสำหรับ Preview");
    }
  }

  async function performCut() {
    if (!previewCameraId) return;
    const oldActive = activeCameraId;
    if (previewCameraId !== activeCameraId) {
      if (status === "live") {
        await switchCamera(previewCameraId);
      } else {
        setActiveCameraId(previewCameraId);
        setInputVideoQuality(cameras, previewCameraId, oldActive);
      }
    }
    const nextProgramScene = { ...scene, sourceId: previewCameraId, layers: scene.layers.map((layer) => ({ ...layer })) };
    setProgramScene(nextProgramScene);
    setProgramSceneKey(selectedSceneKey);
    await publishProgramSceneSnapshot(nextProgramScene);
    setPreviewSceneDirty(false);
  }

  function setInputVideoQuality(sources: CameraSource[], programCameraID: string | null, previewCamID: string | null = null) {
    sources.forEach((source) => {
      const isHigh = source.id === programCameraID || source.id === previewCamID;
      source.videoPublication?.setVideoQuality(
        isHigh ? VideoQuality.HIGH : VideoQuality.LOW,
      );
    });
  }


  async function sendBridgeControl(type: "program-start" | "program-switch" | "program-stop", sourceId?: string) {
    if (!publisherRoom.current) throw new Error("Source SFU ยังไม่เชื่อมต่อ");
    const data = new TextEncoder().encode(JSON.stringify({ type, sourceId }));
    await publisherRoom.current.localParticipant.publishData(data, {
      reliable: true,
      destinationIdentities: [`bridge-${roomName}`, `compositor-${roomName}`],
    });
  }

  async function disconnectSource(sourceId: string) {
    if (!publisherRoom.current) return;
    if (activeCameraId === sourceId) {
      setActiveCameraId(null);
    }
    if (previewCameraId === sourceId) setPreviewCameraId(null);
    setMessage(`นำ Source ${sourceId} ออกจากห้องแล้ว`);
    const data = new TextEncoder().encode(JSON.stringify({ type: "disconnect-source" }));
    await publisherRoom.current.localParticipant.publishData(data, { reliable: true, destinationIdentities: [sourceId] });
  }

  async function startBroadcast() {
    if (!activeCameraId || !outputPublisherRoom.current || !publisherRoom.current) {
      setMessage("กรุณารอหรือเลือกกล้องก่อนเริ่มถ่ายทอดสด");
      return;
    }
    setBroadcastBusy(true);
    setMessage("กำลังเปิด Program Output…");
    try {
      if (programAudioEnabledRef.current && audioSourcesRef.current.some((source) => audioMixSettingsRef.current[source.id]?.enabled)) {
        prepareAudioMixerContext();
      }
      await syncAudioMixer(audioSourcesRef.current, audioMixSettingsRef.current, true);
      const nextProgramScene = { ...scene, sourceId: activeCameraId, layers: scene.layers.map((layer) => ({ ...layer })) };
      setProgramScene(nextProgramScene);
      setProgramSceneKey(selectedSceneKey);
      setPreviewSceneDirty(false);
      await sendBridgeControl("program-start", activeCameraId);
      await publishProgramSceneSnapshot(nextProgramScene);
      statusRef.current = "live";
      setStatus("live");
      setMessage(`กำลังถ่ายทอดสดจาก ${activeCameraId} · H.264 RTP passthrough`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "เริ่มถ่ายทอดสดไม่สำเร็จ");
    } finally {
      setBroadcastBusy(false);
    }
  }

  async function stopBroadcast() {
    const room = publisherRoom.current;
    if (!room) return;
    setBroadcastBusy(true);
    try {
      await sendBridgeControl("program-stop");
      if (programAudioTrack.current) {
        await room.localParticipant.unpublishTrack(programAudioTrack.current);
        programAudioTrack.current.stop();
        programAudioTrack.current = null;
      }
      await destroyAudioMixer();
      if (outputVideo.current) outputVideo.current.srcObject = null;
      statusRef.current = "ready";
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
    if (programAudioTrack.current) void syncAudioMixer(audioSourcesRef.current, next, true);
  }

  async function syncAudioMixer(sources: AudioSource[], settings: Record<string, AudioMixSetting>, shouldPublish: boolean) {
    const selected = sources.filter((source) => settings[source.id]?.enabled);
    const hasProgramAudio = programAudioEnabledRef.current && selected.length > 0;

    prepareAudioMixerContext();
    const context = audioContextRef.current!;
    const destination = audioDestinationRef.current!;

    audioMixerNodesRef.current.forEach(({ source, gain }) => {
      source.disconnect();
      gain.disconnect();
    });
    audioMixerNodesRef.current.clear();

    if (hasProgramAudio) {
      selected.forEach((audioSource) => {
        const mediaStream = new MediaStream([audioSource.track.mediaStreamTrack]);
        const sourceNode = context.createMediaStreamSource(mediaStream);
        const gainNode = context.createGain();
        gainNode.gain.value = (settings[audioSource.id]?.volume ?? 100) / 100;
        sourceNode.connect(gainNode).connect(destination);
        audioMixerNodesRef.current.set(audioSource.id, { source: sourceNode, gain: gainNode });
      });
    }

    if (shouldPublish && !programAudioTrack.current && publisherRoom.current) {
      const mixedTrack = destination.stream.getAudioTracks()[0];
      const localAudio = new LocalAudioTrack(mixedTrack, undefined, true);
      await publisherRoom.current.localParticipant.publishTrack(localAudio, {
        name: "program-mix-audio",
        stream: "program",
        source: Track.Source.Microphone,
      });
      programAudioTrack.current = localAudio;
    }

    if (hasProgramAudio) {
      await programAudioTrack.current?.unmute();
    } else {
      await programAudioTrack.current?.mute();
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
    outputPublisherRoom.current?.disconnect();
    publisherRoom.current?.disconnect();
    programAudioTrack.current?.stop();
    previewAudioElement.current?.remove();
    void destroyAudioMixer();
    outputPublisherRoom.current = null;
    publisherRoom.current = null;
    programMonitorVideoTrack.current = null;
    directProgramVideoTrack.current = null;
    composedProgramVideoTrack.current = null;
    composedProgramPublication.current = null;
    programAudioTrack.current = null;
    previewAudioElement.current = null;
    setViewerCount(0);
    if (outputVideo.current) outputVideo.current.srcObject = null;
    setCameras([]);
    setAudioSources([]);
    audioSourcesRef.current = [];
    setAudioMixSettings({});
    audioMixSettingsRef.current = {};
    setActiveCameraId(null);
    setPreviewCameraId(null);
    setMonitoredAudioSourceId(null);
  }

  async function leaveStudio() {
    connectingRef.current = false;
    await disconnectAll();
    setStatus("idle");
    setConnectionState("Disconnected");
    setMessage("หยุดการควบคุมรายการแล้ว");
  }

  const isLive = status === "live";
  const isConnected = status === "ready" || status === "live";
  const isBusy = status === "connecting";

  function attachProgramMonitorTrack(track: RemoteTrack, publication: RemoteTrackPublication) {
    if (publication.trackName === "program-video") directProgramVideoTrack.current = track;
    if (publication.trackName === "compositor-preview-video") {
      composedProgramVideoTrack.current = track;
      composedProgramPublication.current = publication;
    }
    selectD1MonitorTrack();
  }

  function selectD1MonitorTrack() {
    const composed = composedProgramVideoTrack.current;
    const composedReady = composed && !composedProgramPublication.current?.isMuted;
    // Keep the live path operational while the local reference compositor is
    // experimental. The bridge's program-video is already carried by D1 and
    // preserves the source WebRTC stream without the extra decode/encode hop.
    const selected = directProgramVideoTrack.current ?? (composedReady ? composed : null);
    if (programMonitorVideoTrack.current && programMonitorVideoTrack.current !== selected) {
      programMonitorVideoTrack.current.detach();
    }
    programMonitorVideoTrack.current = selected ?? null;
    if (statusRef.current === "live" && selected && outputVideo.current) selected.attach(outputVideo.current);
  }


  function cloneProgramScene(value: ProgramScene): ProgramScene {
    return {
      ...value,
      output: { ...value.output },
      layers: value.layers.map((layer) => ({ ...layer })),
    };
  }

  function commitSelectedStudioScene(nextScene: ProgramScene, nextCameraSourceIDs: string[] = sceneCameraSourceIDs) {
    const sceneSnapshot = cloneProgramScene(nextScene);
    const cameraSnapshot = [...nextCameraSourceIDs];
    setScene(sceneSnapshot);
    setSceneCameraSourceIDs(cameraSnapshot);
    setStudioScenes((current) => current.map((item) => (
      item.key === selectedSceneKey
        ? { ...item, name: sceneSnapshot.name || item.name, scene: cloneProgramScene(sceneSnapshot), cameraSourceIDs: [...cameraSnapshot] }
        : item
    )));
  }

  function updateSceneLayers(layers: SceneImageLayer[]) {
    sceneDirtyRef.current = true;
    setPreviewSceneDirty(true);
    commitSelectedStudioScene({ ...scene, revision: scene.revision + 1, layers: layers.map((layer) => ({ ...layer })) });
  }

  function initializeStudioScenes(baseScene: ProgramScene) {
    let items: StudioScene[] = [];
    try {
      const stored = window.localStorage.getItem(`localstream-studio-scenes:${roomName}`);
      const parsed = stored ? JSON.parse(stored) as StudioScene[] : [];
      if (Array.isArray(parsed)) {
        items = parsed
          .filter((item) => item?.key && item?.name && item?.scene?.output)
          .map((item) => ({
            ...item,
            scene: cloneProgramScene(item.scene),
            cameraSourceIDs: Array.isArray(item.cameraSourceIDs)
              ? [...item.cameraSourceIDs]
              : item.scene.sourceId ? [item.scene.sourceId] : [],
          }));
      }
    } catch { /* ignore invalid local scene collection */ }
    if (items.length === 0) items = [{ key: "scene-1", name: baseScene.name || "Scene 1", scene: cloneProgramScene(baseScene), cameraSourceIDs: baseScene.sourceId ? [baseScene.sourceId] : [] }];
    setStudioScenes(items);
    setSelectedSceneKey(items[0].key);
    setProgramSceneKey(items[0].key);
    setScene(cloneProgramScene(items[0].scene));
    setSceneCameraSourceIDs([...items[0].cameraSourceIDs]);
    setProgramScene(cloneProgramScene(items[0].scene));
    setPreviewSceneDirty(false);
  }

  function selectStudioScene(key: string) {
    const item = studioScenes.find((candidate) => candidate.key === key);
    if (!item) return;
    setSelectedSceneKey(key);
    setScene(cloneProgramScene(item.scene));
    setSceneCameraSourceIDs([...item.cameraSourceIDs]);
    setSelectedSceneLayerID(null);
    setPreviewSceneDirty(false);
    sceneDirtyRef.current = false;
    const connectedSource = cameras.some((camera) => camera.id === item.scene.sourceId && camera.videoTrack)
      ? item.scene.sourceId ?? null
      : null;
    setPreviewCameraId(connectedSource);
    setInputVideoQuality(cameras, activeCameraId, connectedSource);
  }

  function addStudioScene() {
    const sequence = studioScenes.length + 1;
    const key = `scene-${Date.now().toString(36)}`;
    const nextScene = { ...emptyProgramScene(roomName), name: `Scene ${sequence}`, revision: scene.revision + 1 };
    setStudioScenes((current) => [...current, { key, name: nextScene.name, scene: cloneProgramScene(nextScene), cameraSourceIDs: [] }]);
    setSelectedSceneKey(key);
    setScene(cloneProgramScene(nextScene));
    setSceneCameraSourceIDs([]);
    setPreviewCameraId(null);
    setInputVideoQuality(cameras, activeCameraId, null);
    setSelectedSceneLayerID(null);
    setPreviewSceneDirty(true);
  }

  function duplicateStudioScene(key: string) {
    const source = studioScenes.find((item) => item.key === key);
    if (!source) return;
    const duplicateKey = `scene-${Date.now().toString(36)}`;
    const duplicateScene = {
      ...source.scene,
      name: `${source.name} Copy`,
      revision: Math.max(scene.revision, source.scene.revision) + 1,
      layers: source.scene.layers.map((layer) => ({ ...layer })),
    };
    setStudioScenes((current) => [...current, { key: duplicateKey, name: duplicateScene.name, scene: cloneProgramScene(duplicateScene), cameraSourceIDs: [...source.cameraSourceIDs] }]);
    setSelectedSceneKey(duplicateKey);
    setScene(cloneProgramScene(duplicateScene));
    setSceneCameraSourceIDs([...source.cameraSourceIDs]);
    const connectedSource = cameras.some((camera) => camera.id === duplicateScene.sourceId && camera.videoTrack)
      ? duplicateScene.sourceId ?? null
      : null;
    setPreviewCameraId(connectedSource);
    setInputVideoQuality(cameras, activeCameraId, connectedSource);
    setPreviewSceneDirty(true);
  }

  function deleteStudioScene(key: string) {
    if (studioScenes.length <= 1) return;
    const remaining = studioScenes.filter((item) => item.key !== key);
    setStudioScenes(remaining);
    if (selectedSceneKey === key) {
      setSelectedSceneKey(remaining[0].key);
      setScene(cloneProgramScene(remaining[0].scene));
      setSceneCameraSourceIDs([...remaining[0].cameraSourceIDs]);
      const connectedSource = cameras.some((camera) => camera.id === remaining[0].scene.sourceId && camera.videoTrack)
        ? remaining[0].scene.sourceId ?? null
        : null;
      setPreviewCameraId(connectedSource);
      setInputVideoQuality(cameras, activeCameraId, connectedSource);
      setSelectedSceneLayerID(null);
    }
  }

  async function publishProgramSceneSnapshot(
    nextScene: ProgramScene,
    room: Room | null = outputPublisherRoom.current,
    destinationIdentities?: string[],
  ) {
    if (!room || room.state !== ConnectionState.Connected) return;
    const payload = new TextEncoder().encode(JSON.stringify({ type: "program-scene", scene: nextScene }));
    await room.localParticipant.publishData(payload, {
      reliable: true,
      destinationIdentities,
    });
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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "12px" }}>
          <div className="room-label text-sm" style={{ textAlign: "right" }}>
            <span style={{ display: "block", color: "var(--text-tertiary)", fontSize: "11px", letterSpacing: "0.1em", marginBottom: "4px" }}>
              ROOM {roomCode ? `· CODE ${roomCode}` : ""}
            </span>
            {channelByID(roomName).name} · {roomName}
          </div>
          {roomCode && (
            <div style={{ display: "flex", gap: "8px" }}>
              <Button variant="secondary" size="sm" onClick={() => { navigator.clipboard.writeText(roomCode); alert("คัดลอก Room Code เรียบร้อยแล้ว: " + roomCode); }} title="Copy Room Code">
                <span style={{ fontSize: "12px" }}>Copy Code</span>
              </Button>
              <Link href={`/camera?room=${roomName}&code=${roomCode}`} target="_blank">
                <Button variant="secondary" size="sm">
                  <Video size={14} style={{ marginRight: "6px" }} /> <span style={{ fontSize: "12px" }}>ต่อกล้อง</span>
                </Button>
              </Link>
              <Link href={`/microphone?room=${roomName}&code=${roomCode}`} target="_blank">
                <Button variant="secondary" size="sm">
                  <Mic size={14} style={{ marginRight: "6px" }} /> <span style={{ fontSize: "12px" }}>ต่อไมค์</span>
                </Button>
              </Link>
            </div>
          )}
        </div>
      </section>

      <div style={{ display: "flex", flexDirection: "column", gap: "32px", alignItems: "stretch" }}>
        {/* Top Section - Monitors */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: "16px", alignItems: "center" }}>
            {/* Preview Card */}
            <Card style={{ alignSelf: "stretch" }}>
              <CardHeader style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <MonitorOff size={16} style={{ color: "var(--text-secondary)" }} />
                  <span style={{ fontWeight: 600 }}>Preview</span>
                </div>
              </CardHeader>
              <CardBody style={{ padding: 0 }}>
                <div className="program-frame" style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
                  <video ref={previewVideo} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                  <SceneOverlay
                    layers={scene.layers}
                    selectedID={selectedSceneLayerID}
                    disabled={!isConnected}
                    onSelect={setSelectedSceneLayerID}
                    onChange={updateSceneLayers}
                  />
                  {previewCameraId && (
                    <Badge variant="success" showDot style={{ position: "absolute", top: "16px", left: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
                      PREVIEW · {previewCameraId.split('-').pop()}
                    </Badge>
                  )}
                  {!isConnected && (
                    <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--text-secondary)" }}>OFFLINE</span>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>

            {/* Transition Controls */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", padding: "0 8px" }}>
              <Button 
                variant="primary" 
                size="sm" 
                disabled={!isConnected || !previewCameraId || (previewCameraId === activeCameraId && !previewSceneDirty && selectedSceneKey === programSceneKey)}
                onClick={performCut}
                style={{ minWidth: "60px", height: "40px" }}
              >
                Cut
              </Button>
            </div>

            {/* Program Card */}
            <Card style={{ alignSelf: "stretch" }}>
              <CardHeader style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <RadioTower size={16} style={{ color: isLive ? "var(--danger)" : "var(--text-secondary)" }} />
                    <span style={{ fontWeight: 600 }}>Program</span>
                  </div>
                  {isLive && <Badge variant="live" showDot>LIVE</Badge>}
                </div>
              </CardHeader>
              <CardBody style={{ padding: 0 }}>
                <div className="program-frame" style={{ width: "100%", aspectRatio: "16/9", position: "relative", backgroundColor: "#000" }}>
                  <video ref={outputVideo} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                  <SceneOverlay
                    layers={programScene.layers}
                    selectedID={null}
                    disabled
                    onSelect={() => {}}
                    onChange={() => {}}
                  />
                  {isLive && activeCameraId && (
                    <Badge variant="live" showDot style={{ position: "absolute", top: "16px", left: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
                      LIVE · {activeCameraId.split('-').pop()}
                    </Badge>
                  )}
                  {isLive && (
                    <Badge variant="default" style={{ position: "absolute", top: "16px", right: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", fontSize: "10px", letterSpacing: "0.05em", color: "var(--text-secondary)" }}>
                      D1 RETURN
                    </Badge>
                  )}
                  {!isLive && activeCameraId && (
                    <Badge variant="success" showDot style={{ position: "absolute", top: "16px", left: "16px", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}>
                      PROGRAM · {activeCameraId.split('-').pop()}
                    </Badge>
                  )}
                  {!isLive && !activeCameraId && (
                    <div className="video-placeholder" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at center, #1a1a1a 0, #0a0a0a 100%)" }}>
                      <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--text-secondary)" }}>PROGRAM OFF AIR</span>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>

          {isConnected && (
            <Card>
              <CardBody style={{ padding: "20px 24px", height: "100%" }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, .7fr) minmax(360px, 1.3fr)", gap: "24px", alignItems: "start" }}>
                  <SceneCollectionPanel
                    scenes={studioScenes.map(({ key, name }) => ({ key, name }))}
                    selectedKey={selectedSceneKey}
                    programKey={programSceneKey}
                    onSelect={selectStudioScene}
                    onAdd={addStudioScene}
                    onDuplicate={duplicateStudioScene}
                    onDelete={deleteStudioScene}
                  />
                  <SceneLayerPanel
                    layers={scene.layers}
                    cameraSources={cameras.filter((camera) => camera.videoTrack).map((camera) => ({ id: camera.id, name: camera.label }))}
                    cameraSourceIDs={sceneCameraSourceIDs}
                    selectedCameraID={scene.sourceId}
                    selectedID={selectedSceneLayerID}
                    disabled={false}
                    onCameraAdd={addCameraSource}
                    onCameraRemove={removeCameraSource}
                    onCameraSelect={selectCameraSource}
                    onSelect={setSelectedSceneLayerID}
                    onChange={updateSceneLayers}
                  />
                </div>
              </CardBody>
            </Card>
          )}
        </div>

        {/* Bottom Section - Sources */}
        {isConnected && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", alignItems: "start" }}>
            <Card style={{ display: "flex", flexDirection: "column", maxHeight: "600px" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px" }}>
                <Video size={18} style={{ color: "var(--text-secondary)" }} />
                Cameras <Badge variant="default" style={{ marginLeft: "4px", padding: "2px 6px", fontSize: "12px" }}>{cameras.length}</Badge>
              </div>
              <div style={{ padding: "20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px", overflowY: "auto" }}>
                {cameras.length === 0 ? (
                  <div style={{ gridColumn: "1 / -1", padding: "40px 20px", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-md)", color: "var(--text-tertiary)" }}>
                    <Video size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
                    <p className="text-sm">ยังไม่มีกล้องในห้อง<br />เปิด <b>/camera</b> แล้วกรอก Code <b>{roomCode}</b></p>
                  </div>
                ) : (
                  cameras.map((camera) => (
                    <CameraPreviewCard 
                      key={camera.id} 
                      camera={camera} 
                    />
                  ))
                )}
              </div>
            </Card>

            <Card style={{ display: "flex", flexDirection: "column", maxHeight: "600px" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-subtle)", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px" }}>
                <Mic size={18} style={{ color: "var(--text-secondary)" }} />
                Audio <Badge variant="default" style={{ marginLeft: "4px", padding: "2px 6px", fontSize: "12px" }}>{audioSources.length}</Badge>
              </div>
              <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px", overflowY: "auto" }}>
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
            </Card>
          </div>
        )}
      </div>

      <footer className="control-dock" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 24px", background: "rgba(10,10,10,0.85)", backdropFilter: "blur(12px)", borderTop: "1px solid var(--border-strong)", zIndex: 100 }}>
        {isConnected ? (
          <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontSize: "11px", letterSpacing: "0.1em", fontWeight: 600, color: "var(--text-secondary)" }}>PRE-BROADCAST CHECK</span>
              <strong style={{ fontSize: "13px", margin: "2px 0" }}>{activeCameraId ? `กล้องเริ่มต้น: ${activeCameraId.split('-').pop()}` : "รอกล้องเชื่อมต่อ"}</strong>
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>Session: {programRoomID(roomName)}</span>
            </div>
            <Button 
              variant={programAudioEnabled ? "primary" : "secondary"} 
              size="sm"
              onClick={toggleProgramAudio}
              style={{ gap: "6px" }}
            >
              {programAudioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              Audio: {programAudioEnabled ? "ON" : "OFF"}
            </Button>
          </div>
        ) : (
          <div style={{ color: status === "error" ? "var(--danger)" : "var(--text-secondary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
            {status === "error" && <UserX size={16} />}
            {message}
          </div>
        )}
        <div className="dock-actions" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
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

function CameraPreviewCard({ camera }: { camera: CameraSource }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        if (camera.videoTrack && videoRef.current) {
            camera.videoTrack.attach(videoRef.current);
        }
    }, [camera.videoTrack]);

    return (
      <Card style={{ overflow: "hidden", borderColor: "var(--border-subtle)" }}>
        <div style={{ position: "relative", aspectRatio: "16/9", background: "#000" }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          {!camera.videoTrack && <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", color: "var(--text-tertiary)", fontSize: "12px", fontWeight: 600 }}>NO SIGNAL</div>}
          <Badge variant={camera.videoTrack ? "success" : "default"} showDot style={{ position: "absolute", top: "8px", right: "8px" }}>
            {camera.videoTrack ? "CONNECTED" : "NO SIGNAL"}
          </Badge>
        </div>
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px", background: "var(--bg-surface)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>{camera.label}</span>
              <span className="text-sm" style={{ fontSize: "11px", color: "var(--text-secondary)" }}>MONITOR ONLY · {camera.id.split('-').pop()}</span>
            </div>
          </div>
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
        <div style={{ marginTop: "4px" }}>
          <AudioVisualizer track={source.track} enabled={setting.enabled} />
        </div>
      </div>

      <Button variant={isMonitoring ? "primary" : "secondary"} size="sm" onClick={onMonitor} style={{ width: "100%" }}>
        {isMonitoring ? "หยุดฟัง" : "ฟังเสียง"}
      </Button>
    </Card>
  );
}

function AudioVisualizer({ track, enabled }: { track: Track, enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    if (!track || !track.mediaStreamTrack) return;
    if (track.mediaStreamTrack.kind !== 'audio') {
      console.warn("AudioVisualizer: track is not an audio track", track.mediaStreamTrack.kind);
      return;
    }

    // Force WebRTC to decode the stream by attaching it to a muted audio element.
    // Without this, some browsers (like Chrome) may deliver silence to the Web Audio API.
    const dummyElement = track.attach() as HTMLAudioElement;
    dummyElement.muted = true;
    dummyElement.volume = 0;
    dummyElement.style.display = 'none';
    document.body.appendChild(dummyElement);
    dummyElement.play().catch(() => {});
    
    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let animationId: number;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioCtx = new AudioContextClass();
      
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      
      const stream = new MediaStream([track.mediaStreamTrack]);
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      const draw = () => {
        animationId = requestAnimationFrame(draw);
        
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        analyser.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const numBlocks = 30;
        const blockWidth = (canvas.width - (numBlocks - 1) * 2) / numBlocks;
        
        const activeBlocks = Math.floor((average / 255) * numBlocks * 1.8);
        
        for (let i = 0; i < numBlocks; i++) {
          const x = i * (blockWidth + 2);
          
          if (i < activeBlocks) {
            if (i > numBlocks * 0.8) {
              ctx.fillStyle = '#ef4444'; // danger
            } else if (i > numBlocks * 0.6) {
              ctx.fillStyle = '#f59e0b'; // warning
            } else {
              ctx.fillStyle = enabled ? '#10b981' : '#a3a3a3'; // success or gray
            }
          } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
          }
          
          ctx.fillRect(x, 0, blockWidth, canvas.height);
        }
      };
      
      draw();
    } catch (e) {
      console.warn("AudioVisualizer initialization failed:", e);
    }
    
    return () => {
      cancelAnimationFrame(animationId);
      if (source) {
        try { source.disconnect(); } catch (e) {}
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        try { audioCtx.close().catch(() => {}); } catch (e) {}
      }
      try {
        track.detach(dummyElement);
        dummyElement.remove();
      } catch (e) {}
    };
  }, [track, enabled]);

  return (
    <div style={{ background: "rgba(0,0,0,0.2)", padding: "6px", borderRadius: "4px" }}>
      <canvas 
        ref={canvasRef} 
        width={300} 
        height={8} 
        style={{ width: "100%", height: "8px", display: "block" }} 
      />
    </div>
  );
}
