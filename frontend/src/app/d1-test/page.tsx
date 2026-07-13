"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { WebRTCAdaptor } from "@antmedia/webrtc_adaptor";
import { ArrowLeft, CircleAlert, Radio, Square, Trash2, Video, Volume2, VolumeX } from "lucide-react";

const defaultWebSocketURL = process.env.NEXT_PUBLIC_ANT_MEDIA_WEBSOCKET_URL
  ?? "wss://rtc2.streamssl.com:5443/WebRTCAppEE/websocket";
const defaultStreamID = process.env.NEXT_PUBLIC_ANT_MEDIA_STREAM_ID ?? "sell-image";

type TestStatus = "idle" | "connecting" | "publishing" | "error";
type ReturnStatus = "idle" | "connecting" | "playing" | "error";
type ConnectionLog = { id: number; time: string; scope: "SYSTEM" | "PUBLISH" | "RETURN" | "AUDIO"; event: string; detail: string };

export default function D1TestPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const returnVideoRef = useRef<HTMLVideoElement>(null);
  const adaptorRef = useRef<WebRTCAdaptor | null>(null);
  const playerAdaptorRef = useRef<WebRTCAdaptor | null>(null);
  const streamIDRef = useRef("");
  const publishStartedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const stopPublishingRef = useRef<(updateState?: boolean) => void>(() => undefined);
  const logIDRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const toneGainRef = useRef<GainNode | null>(null);
  const toneOscillatorRef = useRef<OscillatorNode | null>(null);
  const mixedAudioTrackRef = useRef<MediaStreamTrack | null>(null);

  const [webSocketURL, setWebSocketURL] = useState(defaultWebSocketURL);
  const [streamID, setStreamID] = useState(defaultStreamID);
  const [token, setToken] = useState("");
  const [playToken, setPlayToken] = useState("");
  const [status, setStatus] = useState<TestStatus>("idle");
  const [message, setMessage] = useState("พร้อมทดสอบเชื่อมต่อ D1 จริง");
  const [returnStatus, setReturnStatus] = useState<ReturnStatus>("idle");
  const [returnMessage, setReturnMessage] = useState("Return Monitor จะเริ่มหลัง D1 ยืนยันการ publish");
  const [returnSoundEnabled, setReturnSoundEnabled] = useState(false);
  const [sendingTestSound, setSendingTestSound] = useState(false);
  const [logs, setLogs] = useState<ConnectionLog[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPublishingRef.current(false);
    };
  }, []);

  async function startPublishing() {
    const targetURL = webSocketURL.trim();
    const targetStreamID = streamID.trim();
    if (!targetURL.startsWith("wss://") && !targetURL.startsWith("ws://")) {
      appendLog("SYSTEM", "validation_error", "WebSocket URL ไม่ถูกต้อง");
      setStatus("error");
      setMessage("WebSocket URL ต้องขึ้นต้นด้วย wss:// หรือ ws://");
      return;
    }
    if (!targetStreamID) {
      appendLog("SYSTEM", "validation_error", "ไม่มี Stream Key");
      setStatus("error");
      setMessage("กรุณากรอก Stream Key");
      return;
    }

    stopPublishing(false);
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    void audioContext.resume();
    appendLog("SYSTEM", "test_started", `${targetURL} · stream=${targetStreamID}`);
    appendLog("AUDIO", "context_created", `state=${audioContext.state}`);
    setStatus("connecting");
    setMessage("กำลังขอสิทธิ์กล้อง/ไมค์และเชื่อมต่อ Ant Media…");
    setReturnStatus("idle");
    setReturnMessage("กำลังรอ D1 ยืนยันฝั่งส่ง…");
    streamIDRef.current = targetStreamID;

    try {
      const { WebRTCAdaptor } = await import("@antmedia/webrtc_adaptor");
      if (!mountedRef.current) return;

      const adaptor = new WebRTCAdaptor({
        websocket_url: targetURL,
        localVideoElement: videoRef.current,
        mediaConstraints: {
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        },
        peerconnection_config: {
          iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
        },
        sdp_constraints: { OfferToReceiveAudio: false, OfferToReceiveVideo: false },
        callback: (info: string, detail?: unknown) => {
          if (!mountedRef.current) return;
          appendLog("PUBLISH", info, formatDetail(detail));
          if (info === "initialized") {
            setMessage("WebSocket เชื่อมต่อแล้ว กำลังเริ่ม publish…");
            adaptor.publish(targetStreamID, token.trim() || undefined);
          } else if (info === "publish_started") {
            publishStartedAtRef.current = Date.now();
            setStatus("publishing");
            setMessage(`D1 ยืนยันรับสัญญาณแล้ว · Stream Key: ${targetStreamID}`);
            void setupTestSoundMixer(adaptor, targetStreamID);
            void startReturnPlayback(WebRTCAdaptor, targetURL, targetStreamID);
          } else if (info === "publish_finished") {
            setStatus("idle");
            setMessage("หยุดส่งสัญญาณแล้ว");
          } else if (info === "closed") {
            setStatus("idle");
            setMessage("WebSocket ถูกปิดแล้ว");
          }
        },
        callbackError: (error: string, detail?: unknown) => {
          if (!mountedRef.current) return;
          appendLog("PUBLISH", `ERROR: ${error}`, formatDetail(detail));
          const suffix = errorDetail(detail);
          setStatus("error");
          setMessage(`เชื่อมต่อ D1 ไม่สำเร็จ: ${error}${suffix ? ` · ${suffix}` : ""}`);
        },
      });
      adaptorRef.current = adaptor;
    } catch (error) {
      appendLog("PUBLISH", "sdk_error", error instanceof Error ? error.message : String(error));
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "เริ่ม Ant Media SDK ไม่สำเร็จ");
    }
  }

  async function startReturnPlayback(
    Adaptor: typeof WebRTCAdaptor,
    targetURL: string,
    targetStreamID: string,
  ) {
    setReturnStatus("connecting");
    setReturnMessage("กำลังเปิด connection ที่สองเพื่อดึง stream กลับจาก D1…");

    try {
      const player = new Adaptor({
        websocket_url: targetURL,
        remoteVideoElement: returnVideoRef.current,
        isPlayMode: true,
        mediaConstraints: { video: false, audio: false },
        peerconnection_config: {
          iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
        },
        callback: (info: string, detail?: unknown) => {
          if (!mountedRef.current) return;
          appendLog("RETURN", info, formatDetail(detail));
          if (info === "initialized") {
            setReturnMessage("Player WebSocket เชื่อมต่อแล้ว กำลังขอเล่น stream…");
            player.play(targetStreamID, playToken.trim() || undefined);
          } else if (info === "play_started") {
            setReturnStatus("playing");
            setReturnMessage("D1 ตอบ play_started แล้ว กำลังรอเฟรมภาพแรก…");
          } else if (info === "play_finished") {
            setReturnStatus("idle");
            setReturnMessage("D1 หยุดส่ง Return stream แล้ว");
          }
        },
        callbackError: (error: string, detail?: unknown) => {
          if (!mountedRef.current) return;
          appendLog("RETURN", `ERROR: ${error}`, formatDetail(detail));
          const suffix = errorDetail(detail);
          setReturnStatus("error");
          setReturnMessage(`รับ Return จาก D1 ไม่สำเร็จ: ${error}${suffix ? ` · ${suffix}` : ""}`);
        },
      });
      playerAdaptorRef.current = player;
    } catch (error) {
      appendLog("RETURN", "player_error", error instanceof Error ? error.message : String(error));
      setReturnStatus("error");
      setReturnMessage(error instanceof Error ? error.message : "เริ่ม D1 Return Player ไม่สำเร็จ");
    }
  }

  function handleReturnPlaying() {
    const elapsed = publishStartedAtRef.current ? Date.now() - publishStartedAtRef.current : 0;
    setReturnStatus("playing");
    setReturnMessage(`ได้รับภาพจริงจาก D1 แล้ว${elapsed ? ` · เฟรมแรกหลัง publish ${elapsed} ms` : ""}`);
    appendLog("RETURN", "media_playing", elapsed ? `เฟรมแรกหลัง publish ${elapsed} ms` : "ได้รับ media track แล้ว");
  }

  async function setupTestSoundMixer(adaptor: WebRTCAdaptor, targetStreamID: string) {
    try {
      const localStream = adaptor.mediaManager?.localStream as MediaStream | undefined;
      const microphoneTrack = localStream?.getAudioTracks()[0];
      const sender = adaptor.getSender(targetStreamID, "audio") as RTCRtpSender | undefined;
      if (!microphoneTrack || !sender) {
        appendLog("AUDIO", "mixer_unavailable", "ไม่พบ microphone track หรือ audio sender");
        return;
      }

      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      const microphone = context.createMediaStreamSource(new MediaStream([microphoneTrack]));
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const toneGain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      toneGain.gain.value = 0;
      microphone.connect(destination);
      oscillator.connect(toneGain).connect(destination);
      oscillator.start();

      const mixedTrack = destination.stream.getAudioTracks()[0];
      await sender.replaceTrack(mixedTrack);
      audioContextRef.current = context;
      toneGainRef.current = toneGain;
      toneOscillatorRef.current = oscillator;
      mixedAudioTrackRef.current = mixedTrack;
      appendLog("AUDIO", "mixer_ready", "ไมค์ + test tone ถูกต่อเข้าขา publish แล้ว");
    } catch (error) {
      appendLog("AUDIO", "mixer_error", error instanceof Error ? error.message : String(error));
    }
  }

  async function sendTestSound() {
    const context = audioContextRef.current;
    const gain = toneGainRef.current;
    if (!context || !gain || status !== "publishing") {
      appendLog("AUDIO", "test_tone_rejected", "audio mixer ยังไม่พร้อม");
      return;
    }
    await context.resume();
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.03);
    gain.gain.setValueAtTime(0.16, now + 0.55);
    gain.gain.linearRampToValueAtTime(0, now + 0.65);
    setSendingTestSound(true);
    appendLog("AUDIO", "test_tone_sent", "880 Hz · 650 ms ถูกส่งเข้า D1");
    window.setTimeout(() => {
      if (mountedRef.current) setSendingTestSound(false);
    }, 700);
  }

  async function toggleReturnSound() {
    const video = returnVideoRef.current;
    if (!video) return;
    const enable = video.muted;
    video.muted = !enable;
    setReturnSoundEnabled(enable);
    if (enable) await video.play();
    appendLog("AUDIO", enable ? "return_audio_enabled" : "return_audio_muted", enable ? "เปิดลำโพง D1 Return แล้ว" : "ปิดเสียง D1 Return แล้ว");
  }

  function appendLog(scope: ConnectionLog["scope"], event: string, detail = "") {
    const entry: ConnectionLog = {
      id: ++logIDRef.current,
      time: new Date().toLocaleTimeString("th-TH", { hour12: false }),
      scope,
      event,
      detail,
    };
    setLogs((current) => [...current.slice(-99), entry]);
    console.info(`[D1 ${scope}] ${event}`, detail);
  }

  function stopPublishing(updateState = true) {
    const adaptor = adaptorRef.current;
    const player = playerAdaptorRef.current;
    adaptorRef.current = null;
    playerAdaptorRef.current = null;
    if (player) {
      if (streamIDRef.current) player.stop(streamIDRef.current);
      player.closeWebSocket();
    }
    if (adaptor) {
      if (streamIDRef.current) adaptor.stop(streamIDRef.current);
      adaptor.closeWebSocket();
      adaptor.mediaManager?.closeStream();
    }
    toneOscillatorRef.current?.stop();
    toneOscillatorRef.current = null;
    toneGainRef.current = null;
    mixedAudioTrackRef.current?.stop();
    mixedAudioTrackRef.current = null;
    if (audioContextRef.current) void audioContextRef.current.close();
    audioContextRef.current = null;
    streamIDRef.current = "";
    publishStartedAtRef.current = 0;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (returnVideoRef.current) returnVideoRef.current.srcObject = null;
    if (updateState && mountedRef.current) {
      setStatus("idle");
      setMessage("หยุดส่งสัญญาณแล้ว");
      setReturnStatus("idle");
      setReturnMessage("หยุดรับ Return stream แล้ว");
      setReturnSoundEnabled(false);
      setSendingTestSound(false);
      appendLog("SYSTEM", "test_stopped", "ปิด Publish, Return และ audio mixer แล้ว");
    }
  }

  stopPublishingRef.current = stopPublishing;

  const busy = status === "connecting" || status === "publishing";

  return (
    <main className="d1-test-page">
      <header className="d1-test-header">
        <Link href="/" className="d1-test-back"><ArrowLeft size={16} /> กลับหน้าหลัก</Link>
        <span className={`d1-test-state ${status}`}><i /> {statusLabel(status)}</span>
      </header>

      <section className="d1-test-shell">
        <div className="d1-test-heading">
          <span><Radio size={15} /> ANT MEDIA CONNECTION TEST</span>
          <h1>ทดสอบ D1 จริงแบบแยกจากระบบเดิม</h1>
          <p>หน้านี้ publish กล้องและไมค์ตรงไป Ant Media เท่านั้น ระบบ LiveKit D1 เดิมยังทำงานเหมือนเดิมทุกจุด</p>
        </div>

        <div className="d1-test-grid">
          <section className="d1-test-monitors">
            <div className="d1-test-monitor">
              <div className="d1-test-monitor-label"><span>LOCAL / ส่งออก</span><strong className={status}>{statusLabel(status)}</strong></div>
              <div className="d1-test-preview">
                <video ref={videoRef} autoPlay muted playsInline />
                {!busy && (
                  <div className="d1-test-placeholder">
                    <Video size={32} />
                    <strong>LOCAL PREVIEW</strong>
                    <span>ภาพก่อนส่งไป D1</span>
                  </div>
                )}
                {status === "publishing" && <div className="d1-test-live"><i /> D1 ACCEPTED</div>}
              </div>
            </div>

            <div className="d1-test-monitor return">
              <div className="d1-test-monitor-label"><span>D1 RETURN / รับกลับ</span><strong className={returnStatus}>{returnStatusLabel(returnStatus)}</strong></div>
              <div className="d1-test-preview">
                <video ref={returnVideoRef} autoPlay muted playsInline onPlaying={handleReturnPlaying} />
                {returnStatus !== "playing" && (
                  <div className="d1-test-placeholder">
                    <Radio size={32} />
                    <strong>D1 RETURN MONITOR</strong>
                    <span>{returnStatus === "connecting" ? "กำลังดึงภาพกลับจาก D1…" : "รอ D1 ส่งภาพกลับ"}</span>
                  </div>
                )}
                {returnStatus === "playing" && <div className="d1-test-return-live"><i /> RETURN RECEIVED</div>}
              </div>
              <div className={`d1-return-message ${returnStatus === "error" ? "error" : ""}`}>{returnMessage}</div>
              <button className="d1-return-audio-button" onClick={toggleReturnSound} disabled={returnStatus !== "playing"} title="แนะนำให้ใช้หูฟังเพื่อป้องกันเสียงวนกลับเข้าไมค์">
                {returnSoundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                {returnSoundEnabled ? "ปิดเสียง Return" : "เปิดเสียง Return"}
              </button>
            </div>
          </section>

          <section className="d1-test-controls">
            <label>
              <span>WEBRTC WEBSOCKET URL</span>
              <input value={webSocketURL} onChange={(event) => setWebSocketURL(event.target.value)} disabled={busy} spellCheck={false} />
            </label>
            <label>
              <span>STREAM KEY <small>(ใช้เป็น Ant Media Stream ID)</small></span>
              <input value={streamID} onChange={(event) => setStreamID(event.target.value)} disabled={busy} spellCheck={false} />
            </label>
            <label>
              <span>PUBLISH TOKEN <small>(เว้นว่างได้ถ้า server ไม่บังคับ)</small></span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} autoComplete="off" />
            </label>
            <label>
              <span>PLAY TOKEN <small>(เว้นว่างได้ถ้า server ไม่บังคับ)</small></span>
              <input type="password" value={playToken} onChange={(event) => setPlayToken(event.target.value)} disabled={busy} autoComplete="off" />
            </label>

            <div className={`d1-test-message ${status === "error" ? "error" : ""}`}>
              {status === "error" ? <CircleAlert size={16} /> : <Radio size={16} />}
              <span>{message}</span>
            </div>

            <button className={`d1-test-sound ${sendingTestSound ? "active" : ""}`} onClick={sendTestSound} disabled={status !== "publishing" || !toneGainRef.current}>
              <Volume2 size={16} /> {sendingTestSound ? "กำลังส่งเสียง 880 Hz…" : "ส่ง Test Sound ไป D1"}
            </button>

            {!busy ? (
              <button className="d1-test-primary" onClick={startPublishing}><Radio size={17} /> เริ่มทดสอบส่งไป D1 จริง</button>
            ) : (
              <button className="d1-test-stop" onClick={() => stopPublishing()}><Square size={16} /> หยุดการทดสอบ</button>
            )}
          </section>
        </div>

        <section className="d1-connection-console">
          <header>
            <div><span>CONNECTION CONSOLE</span><small>Publish, Return และ Audio events</small></div>
            <button onClick={() => setLogs([])} disabled={logs.length === 0}><Trash2 size={14} /> ล้าง Log</button>
          </header>
          <div className="d1-console-body">
            {logs.length === 0 ? (
              <p>ยังไม่มี event — กดเริ่มทดสอบเพื่อดูการเชื่อมต่อ</p>
            ) : logs.map((entry) => (
              <div key={entry.id} className={`d1-console-line ${entry.scope.toLowerCase()}`}>
                <time>{entry.time}</time><strong>{entry.scope}</strong><code>{entry.event}</code>{entry.detail && <span>{entry.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function statusLabel(status: TestStatus) {
  if (status === "connecting") return "CONNECTING";
  if (status === "publishing") return "PUBLISHING";
  if (status === "error") return "ERROR";
  return "IDLE";
}

function returnStatusLabel(status: ReturnStatus) {
  if (status === "connecting") return "CONNECTING";
  if (status === "playing") return "RECEIVED";
  if (status === "error") return "ERROR";
  return "WAITING";
}

function errorDetail(detail: unknown) {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const value = detail as { message?: unknown; definition?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.definition === "string") return value.definition;
  }
  return "";
}

function formatDetail(detail: unknown) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  try {
    return JSON.stringify(detail).slice(0, 500);
  } catch {
    return String(detail);
  }
}
