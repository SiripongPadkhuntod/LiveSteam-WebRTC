package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	programVideoTrackName = "program-video"
	programAudioTrackName = "program-audio"
	mixedAudioTrackName   = "program-mix-audio"
	programStreamName     = "program"
)

type bridgeManager struct {
	cfg      config
	logger   *slog.Logger
	mu       sync.Mutex
	sessions map[string]*programBridge
}

type bridgeRequest struct {
	Room string `json:"room"`
}

type bridgeControl struct {
	Type     string `json:"type"`
	SourceID string `json:"sourceId"`
}

type rtpContinuity struct {
	initialized bool
	sourceID    string
	baseInput   uint32
	baseOutput  uint32
	lastOutput  uint32
	sequence    uint16
}

type sourceVideo struct {
	track       *webrtc.TrackRemote
	participant *lksdk.RemoteParticipant
}

// programRTPTrack keeps the outbound RTP packets untouched while exposing
// downstream RTCP feedback. TrackLocalStaticRTP alone consumes no PLI/FIR
// callback, so a viewer joining between keyframes could otherwise stay black.
type programRTPTrack struct {
	*webrtc.TrackLocalStaticRTP
	onKeyframeRequest func()
}

func (t *programRTPTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	codec, err := t.TrackLocalStaticRTP.Bind(ctx)
	if err == nil {
		go t.readRTCP(ctx.RTCPReader())
	}
	return codec, err
}

func (t *programRTPTrack) readRTCP(reader interceptor.RTCPReader) {
	buffer := make([]byte, 1500)
	for {
		n, _, err := reader.Read(buffer, nil)
		if err != nil {
			return
		}
		packets, err := rtcp.Unmarshal(buffer[:n])
		if err != nil {
			continue
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				if t.onKeyframeRequest != nil {
					t.onKeyframeRequest()
				}
			}
		}
	}
}

type programBridge struct {
	roomName string
	logger   *slog.Logger

	sourceRoom *lksdk.Room
	d1Room     *lksdk.Room

	mu              sync.Mutex
	activeSource    string
	started         bool
	waitKeyframe    bool
	videoSources    map[string]sourceVideo
	videoTrack      *programRTPTrack
	audioTrack      *webrtc.TrackLocalStaticRTP
	videoPub        *lksdk.LocalTrackPublication
	audioPub        *lksdk.LocalTrackPublication
	videoContinuity rtpContinuity
	audioContinuity rtpContinuity
}

func newBridgeManager(cfg config, logger *slog.Logger) *bridgeManager {
	return &bridgeManager{cfg: cfg, logger: logger, sessions: make(map[string]*programBridge)}
}

func (m *bridgeManager) handleEnsure(w http.ResponseWriter, r *http.Request) {
	var req bridgeRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Room = strings.TrimSpace(req.Room)
	if req.Room == "" || len(req.Room) > 128 {
		writeError(w, http.StatusBadRequest, "room is required")
		return
	}

	bridge, created, err := m.ensure(req.Room)
	if err != nil {
		m.logger.Error("could not start program bridge", "room", req.Room, "error", err)
		writeError(w, http.StatusBadGateway, "could not start program bridge")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"room":        bridge.roomName,
		"identity":    "program-" + bridge.roomName,
		"d1Room":      programRoomID(bridge.roomName),
		"created":     created,
		"passthrough": true,
	})
}

func (m *bridgeManager) ensure(roomName string) (*programBridge, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if bridge := m.sessions[roomName]; bridge != nil {
		return bridge, false, nil
	}

	bridge := &programBridge{
		roomName:     roomName,
		logger:       m.logger.With("room", roomName),
		videoSources: make(map[string]sourceVideo),
		waitKeyframe: true,
	}
	if err := bridge.connect(m.cfg); err != nil {
		bridge.close()
		return nil, false, err
	}
	m.sessions[roomName] = bridge
	return bridge, true, nil
}

func (b *programBridge) connect(cfg config) error {
	d1URL := cfg.D1InternalURL
	if d1URL == "" {
		d1URL = cfg.D1LiveKitURL
	}
	sourceURL := cfg.LiveKitInternalURL
	if sourceURL == "" {
		sourceURL = cfg.LiveKitURL
	}
	if d1URL == "" || sourceURL == "" {
		return errors.New("bridge internal LiveKit URLs are required")
	}

	d1Room, err := lksdk.ConnectToRoom(d1URL, lksdk.ConnectInfo{
		APIKey:              cfg.D1APIKey,
		APISecret:           cfg.D1APISecret,
		RoomName:            programRoomID(b.roomName),
		ParticipantIdentity: "program-" + b.roomName,
		ParticipantName:     "Program RTP Bridge",
	}, lksdk.NewRoomCallback())
	if err != nil {
		return fmt.Errorf("connect D1: %w", err)
	}
	b.d1Room = d1Room

	callback := lksdk.NewRoomCallback()
	callback.OnTrackSubscribed = b.onTrackSubscribed
	callback.OnDataPacket = b.onDataPacket
	sourceRoom, err := lksdk.ConnectToRoom(sourceURL, lksdk.ConnectInfo{
		APIKey:              cfg.APIKey,
		APISecret:           cfg.APISecret,
		RoomName:            b.roomName,
		ParticipantIdentity: "bridge-" + b.roomName,
		ParticipantName:     "Program RTP Bridge",
	}, callback)
	if err != nil {
		return fmt.Errorf("connect source SFU: %w", err)
	}
	b.sourceRoom = sourceRoom
	b.logger.Info("program RTP bridge connected", "sourceURL", sourceURL, "d1URL", d1URL)
	return nil
}

func (b *programBridge) close() {
	if b.sourceRoom != nil {
		b.sourceRoom.Disconnect()
	}
	if b.d1Room != nil {
		b.d1Room.Disconnect()
	}
}

func (b *programBridge) onDataPacket(data lksdk.DataPacket, params lksdk.DataReceiveParams) {
	packet, ok := data.(*lksdk.UserDataPacket)
	if !ok || !strings.HasPrefix(params.SenderIdentity, "studio-") {
		return
	}
	var control bridgeControl
	if json.Unmarshal(packet.Payload, &control) != nil {
		return
	}
	switch control.Type {
	case "program-start", "program-switch":
		b.setActiveSource(control.SourceID, true)
	case "program-stop":
		b.setStarted(false)
	}
}

func (b *programBridge) setActiveSource(sourceID string, start bool) {
	b.mu.Lock()
	b.activeSource = sourceID
	b.started = start
	b.waitKeyframe = true
	source := b.videoSources[sourceID]
	videoPub := b.videoPub
	audioPub := b.audioPub
	b.mu.Unlock()

	if videoPub != nil {
		videoPub.SetMuted(!start)
	}
	if audioPub != nil {
		audioPub.SetMuted(!start)
	}
	if source.track != nil {
		source.participant.WritePLI(source.track.SSRC())
	}
	go b.retryKeyframe(sourceID)
	b.logger.Info("program source selected", "source", sourceID, "started", start)
}

func (b *programBridge) retryKeyframe(sourceID string) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-ticker.C:
			b.mu.Lock()
			waiting := b.started && b.activeSource == sourceID && b.waitKeyframe
			source := b.videoSources[sourceID]
			b.mu.Unlock()
			if !waiting {
				return
			}
			if source.track != nil {
				source.participant.WritePLI(source.track.SSRC())
			}
		case <-deadline.C:
			b.logger.Warn("timed out waiting for source keyframe", "source", sourceID)
			return
		}
	}
}

func (b *programBridge) requestActiveKeyframe() {
	b.mu.Lock()
	sourceID := b.activeSource
	source := b.videoSources[sourceID]
	b.mu.Unlock()
	if source.track != nil {
		source.participant.WritePLI(source.track.SSRC())
		b.logger.Debug("forwarded downstream keyframe request", "source", sourceID)
	}
}

func (b *programBridge) setStarted(start bool) {
	b.mu.Lock()
	b.started = start
	videoPub := b.videoPub
	audioPub := b.audioPub
	b.mu.Unlock()
	if videoPub != nil {
		videoPub.SetMuted(!start)
	}
	if audioPub != nil {
		audioPub.SetMuted(!start)
	}
}

func (b *programBridge) onTrackSubscribed(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
	switch {
	case track.Kind() == webrtc.RTPCodecTypeVideo && publication.Name() == "camera-video":
		if err := publication.SetVideoQuality(livekit.VideoQuality_HIGH); err != nil {
			b.logger.Warn("could not request highest simulcast layer", "source", participant.Identity(), "error", err)
		}
		b.mu.Lock()
		b.videoSources[participant.Identity()] = sourceVideo{track: track, participant: participant}
		if b.activeSource == "" {
			b.activeSource = participant.Identity()
		}
		b.mu.Unlock()
		if err := b.ensureVideoOutput(track, publication); err != nil {
			b.logger.Error("could not publish passthrough video", "error", err)
			return
		}
		go b.forwardVideo(participant.Identity(), track)
	case track.Kind() == webrtc.RTPCodecTypeAudio && publication.Name() == mixedAudioTrackName:
		if err := b.ensureAudioOutput(track); err != nil {
			b.logger.Error("could not publish passthrough audio", "error", err)
			return
		}
		go b.forwardAudio(participant.Identity(), track)
	}
}

func (b *programBridge) ensureVideoOutput(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.videoTrack != nil {
		return nil
	}
	staticTrack, err := webrtc.NewTrackLocalStaticRTP(track.Codec().RTPCodecCapability, programVideoTrackName, programStreamName)
	if err != nil {
		return err
	}
	localTrack := &programRTPTrack{
		TrackLocalStaticRTP: staticTrack,
		onKeyframeRequest:   b.requestActiveKeyframe,
	}
	info := publication.TrackInfo()
	pub, err := b.d1Room.LocalParticipant.PublishTrack(localTrack, &lksdk.TrackPublicationOptions{
		Name:        programVideoTrackName,
		Source:      livekit.TrackSource_CAMERA,
		Stream:      programStreamName,
		VideoWidth:  int(info.GetWidth()),
		VideoHeight: int(info.GetHeight()),
	})
	if err != nil {
		return err
	}
	pub.SetMuted(!b.started)
	b.videoTrack = localTrack
	b.videoPub = pub
	return nil
}

func (b *programBridge) ensureAudioOutput(track *webrtc.TrackRemote) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.audioTrack != nil {
		return nil
	}
	localTrack, err := webrtc.NewTrackLocalStaticRTP(track.Codec().RTPCodecCapability, programAudioTrackName, programStreamName)
	if err != nil {
		return err
	}
	pub, err := b.d1Room.LocalParticipant.PublishTrack(localTrack, &lksdk.TrackPublicationOptions{
		Name:   programAudioTrackName,
		Source: livekit.TrackSource_MICROPHONE,
		Stream: programStreamName,
	})
	if err != nil {
		return err
	}
	pub.SetMuted(!b.started)
	b.audioTrack = localTrack
	b.audioPub = pub
	return nil
}

func (b *programBridge) forwardVideo(sourceID string, track *webrtc.TrackRemote) {
	pending := make([]*rtp.Packet, 0, 128)
	var pendingTimestamp uint32
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				b.logger.Warn("video RTP reader stopped", "source", sourceID, "error", err)
			}
			return
		}

		b.mu.Lock()
		active := b.started && b.activeSource == sourceID
		waiting := b.waitKeyframe
		b.mu.Unlock()
		if !active {
			pending = pending[:0]
			continue
		}

		if waiting {
			if len(pending) == 0 || pendingTimestamp != packet.Timestamp {
				pending = pending[:0]
				pendingTimestamp = packet.Timestamp
			}
			pending = append(pending, packet.Clone())
			if !h264PacketContainsIDR(packet.Payload) {
				continue
			}
			b.mu.Lock()
			if b.activeSource == sourceID {
				b.waitKeyframe = false
			}
			b.mu.Unlock()
			for _, buffered := range pending {
				b.writeVideoPacket(sourceID, buffered)
			}
			pending = pending[:0]
			continue
		}
		b.writeVideoPacket(sourceID, packet)
	}
}

func (b *programBridge) forwardAudio(sourceID string, track *webrtc.TrackRemote) {
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		b.mu.Lock()
		if !b.started || b.audioTrack == nil {
			b.mu.Unlock()
			continue
		}
		out := rewriteRTP(packet, sourceID, &b.audioContinuity, 960)
		audioTrack := b.audioTrack
		b.mu.Unlock()
		_ = audioTrack.WriteRTP(out)
	}
}

func (b *programBridge) writeVideoPacket(sourceID string, packet *rtp.Packet) {
	b.mu.Lock()
	if !b.started || b.activeSource != sourceID || b.videoTrack == nil {
		b.mu.Unlock()
		return
	}
	out := rewriteRTP(packet, sourceID, &b.videoContinuity, 3000)
	videoTrack := b.videoTrack
	b.mu.Unlock()
	_ = videoTrack.WriteRTP(out)
}

func rewriteRTP(packet *rtp.Packet, sourceID string, state *rtpContinuity, defaultStep uint32) *rtp.Packet {
	out := packet.Clone()
	if !state.initialized || state.sourceID != sourceID {
		state.sourceID = sourceID
		state.baseInput = packet.Timestamp
		if state.initialized {
			state.baseOutput = state.lastOutput + defaultStep
		} else {
			state.baseOutput = packet.Timestamp
			state.sequence = packet.SequenceNumber
			state.initialized = true
		}
	}
	state.sequence++
	out.SequenceNumber = state.sequence
	out.Timestamp = state.baseOutput + (packet.Timestamp - state.baseInput)
	state.lastOutput = out.Timestamp
	out.Extension = false
	out.Extensions = nil
	out.ExtensionProfile = 0
	return out
}

func h264PacketContainsIDR(payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	switch payload[0] & 0x1f {
	case 5:
		return true
	case 24: // STAP-A
		for offset := 1; offset+2 <= len(payload); {
			size := int(payload[offset])<<8 | int(payload[offset+1])
			offset += 2
			if size <= 0 || offset+size > len(payload) {
				return false
			}
			if payload[offset]&0x1f == 5 {
				return true
			}
			offset += size
		}
	case 28: // FU-A
		return len(payload) > 1 && payload[1]&0x80 != 0 && payload[1]&0x1f == 5
	}
	return false
}

func programRoomID(sourceRoom string) string {
	return sourceRoom + "-program"
}
