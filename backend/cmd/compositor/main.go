package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/redis/go-redis/v9"
)

type sceneImageLayer struct {
	ID      string  `json:"id"`
	Type    string  `json:"type"`
	Name    string  `json:"name"`
	Src     string  `json:"src"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
	Opacity float64 `json:"opacity"`
	ZIndex  int     `json:"zIndex"`
	Visible bool    `json:"visible"`
}

type programScene struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Revision int64             `json:"revision"`
	SourceID string            `json:"sourceId,omitempty"`
	Layers   []sceneImageLayer `json:"layers"`
}

type sceneUpdateEvent struct {
	Room  string       `json:"room"`
	Scene programScene `json:"scene"`
}

type programControl struct {
	Type     string `json:"type"`
	SourceID string `json:"sourceId"`
}

type roomRuntime struct {
	Room          string `json:"room"`
	SceneID       string `json:"sceneId"`
	Revision      int64  `json:"revision"`
	VisibleLayers int    `json:"visibleLayers"`
	AssetsReady   bool   `json:"assetsReady"`
	Status        string `json:"status"`
	SourceSFU     bool   `json:"sourceSfuConnected"`
	D1            bool   `json:"d1Connected"`
	VideoSources  int    `json:"videoSources"`
	OutputReady   bool   `json:"composedOutputReady"`
	UpdatedAt     string `json:"updatedAt"`
}

type mediaSession struct {
	sourceRoom    *lksdk.Room
	d1Room        *lksdk.Room
	mu            sync.Mutex
	reconcileMu   sync.Mutex
	sources       map[string]struct{}
	tracks        map[string]*webrtc.TrackRemote
	participants  map[string]*lksdk.RemoteParticipant
	scene         programScene
	pipeline      *ffmpegPipeline
	outputTrack   *webrtc.TrackLocalStaticRTP
	outputPub     *lksdk.LocalTrackPublication
	parameterSets map[string][][]byte
	started       bool
}

type worker struct {
	redis                              *redis.Client
	assetDir                           string
	logger                             *slog.Logger
	ready                              atomic.Bool
	mu                                 sync.RWMutex
	rooms                              map[string]roomRuntime
	scenes                             map[string]programScene
	media                              map[string]*mediaSession
	sourceURL, sourceKey, sourceSecret string
	d1URL, d1Key, d1Secret             string
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	redisAddress := strings.TrimPrefix(env("REDIS_URL", "redis:6379"), "redis://")
	w := &worker{
		redis: redis.NewClient(&redis.Options{Addr: redisAddress}), assetDir: env("ASSET_DIR", "/data/assets"),
		logger: logger, rooms: make(map[string]roomRuntime), scenes: make(map[string]programScene), media: make(map[string]*mediaSession),
		sourceURL: env("LIVEKIT_INTERNAL_URL", "ws://livekit:7880"),
		sourceKey: env("LIVEKIT_API_KEY", "devkey"), sourceSecret: env("LIVEKIT_API_SECRET", "devsecret_devsecret_devsecret_12345"),
		d1URL: env("D1_LIVEKIT_INTERNAL_URL", "ws://d1:7980"),
		d1Key: env("D1_LIVEKIT_API_KEY", "d1key"), d1Secret: env("D1_LIVEKIT_API_SECRET", "d1secret_d1secret_d1secret_12345"),
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := w.redis.Ping(ctx).Err(); err != nil {
		logger.Error("redis unavailable", "error", err)
		os.Exit(1)
	}
	if err := w.loadExistingScenes(ctx); err != nil {
		logger.Error("could not load existing scenes", "error", err)
		os.Exit(1)
	}
	w.ready.Store(true)
	go w.consumeSceneUpdates(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", w.handleHealth)
	mux.HandleFunc("GET /ready", w.handleReady)
	mux.HandleFunc("GET /metrics", w.handleMetrics)
	server := &http.Server{Addr: env("HTTP_ADDR", ":8090"), Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	go func() {
		logger.Info("compositor worker control runtime listening", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("worker HTTP server stopped", "error", err)
			cancel()
		}
	}()
	<-ctx.Done()
	w.ready.Store(false)
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
}

func (w *worker) loadExistingScenes(ctx context.Context) error {
	var cursor uint64
	for {
		keys, next, err := w.redis.Scan(ctx, cursor, "scene:*", 100).Result()
		if err != nil {
			return err
		}
		for _, key := range keys {
			value, err := w.redis.Get(ctx, key).Bytes()
			if err != nil {
				continue
			}
			var scene programScene
			if json.Unmarshal(value, &scene) == nil {
				w.applyScene(strings.TrimPrefix(key, "scene:"), scene)
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}

func (w *worker) consumeSceneUpdates(ctx context.Context) {
	pubsub := w.redis.Subscribe(ctx, "scene.updates")
	defer pubsub.Close()
	for message := range pubsub.Channel() {
		var event sceneUpdateEvent
		if err := json.Unmarshal([]byte(message.Payload), &event); err != nil || event.Room == "" {
			w.logger.Warn("ignored invalid scene update", "error", err)
			continue
		}
		w.applyScene(event.Room, event.Scene)
	}
}

func (w *worker) applyScene(room string, scene programScene) {
	w.mu.Lock()
	if w.scenes == nil {
		w.scenes = make(map[string]programScene)
	}
	if w.media == nil {
		w.media = make(map[string]*mediaSession)
	}
	if current, ok := w.rooms[room]; ok && current.Revision >= scene.Revision {
		w.mu.Unlock()
		return
	}
	visible := 0
	assetsReady := true
	for _, layer := range scene.Layers {
		if !layer.Visible {
			continue
		}
		visible++
		if strings.HasPrefix(layer.Src, "/api/assets/") {
			id := filepath.Base(layer.Src)
			if _, err := os.Stat(filepath.Join(w.assetDir, id)); err != nil {
				assetsReady = false
				w.logger.Warn("scene asset is not ready", "room", room, "asset", id, "error", err)
			}
		}
	}
	status := "scene-ready"
	if !assetsReady {
		status = "waiting-assets"
	}
	runtime := w.rooms[room]
	runtime.Room = room
	runtime.SceneID = scene.ID
	runtime.Revision = scene.Revision
	runtime.VisibleLayers = visible
	runtime.AssetsReady = assetsReady
	if !runtime.SourceSFU || !runtime.D1 {
		runtime.Status = status
	}
	runtime.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	w.rooms[room] = runtime
	w.scenes[room] = scene
	session := w.media[room]
	w.mu.Unlock()
	w.logger.Info("scene revision applied", "room", room, "revision", scene.Revision, "layers", visible, "assetsReady", assetsReady)
	if session != nil {
		session.mu.Lock()
		session.scene = scene
		session.mu.Unlock()
		go w.reconcilePipeline(room, session)
	}
	if w.sourceURL != "" && w.d1URL != "" {
		go w.ensureMediaSession(room)
	}
}

func (w *worker) ensureMediaSession(room string) {
	w.mu.Lock()
	if _, exists := w.media[room]; exists {
		w.mu.Unlock()
		return
	}
	session := &mediaSession{
		sources: make(map[string]struct{}), tracks: make(map[string]*webrtc.TrackRemote),
		participants: make(map[string]*lksdk.RemoteParticipant), parameterSets: make(map[string][][]byte), scene: w.scenes[room],
	}
	w.media[room] = session
	runtime := w.rooms[room]
	runtime.Status = "connecting-media"
	w.rooms[room] = runtime
	w.mu.Unlock()

	callback := lksdk.NewRoomCallback()
	callback.OnDataPacket = func(data lksdk.DataPacket, params lksdk.DataReceiveParams) {
		packet, ok := data.(*lksdk.UserDataPacket)
		if !ok || !strings.HasPrefix(string(params.SenderIdentity), "studio-") {
			return
		}
		var control programControl
		if json.Unmarshal(packet.Payload, &control) != nil {
			return
		}
		session.mu.Lock()
		switch control.Type {
		case "program-start", "program-switch":
			session.started = true
			if control.SourceID != "" {
				session.scene.SourceID = control.SourceID
			}
			if session.outputPub != nil {
				session.outputPub.SetMuted(false)
			}
		case "program-stop":
			session.started = false
			if session.outputPub != nil {
				session.outputPub.SetMuted(true)
			}
		}
		session.mu.Unlock()
		if control.Type == "program-start" || control.Type == "program-switch" {
			go w.reconcilePipeline(room, session)
		}
	}
	callback.OnTrackSubscribed = func(track *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
		if track.Kind() != webrtc.RTPCodecTypeVideo || publication.Name() != "camera-video" {
			go drainTrack(track)
			return
		}
		_ = publication.SetVideoQuality(livekit.VideoQuality_HIGH)
		publication.SetVideoDimensions(1920, 1080)
		sourceID := string(participant.Identity())
		session.mu.Lock()
		session.sources[sourceID] = struct{}{}
		session.tracks[sourceID] = track
		session.participants[sourceID] = participant
		count := len(session.sources)
		shouldReconcile := session.pipeline == nil && session.scene.SourceID == sourceID
		session.mu.Unlock()
		w.updateMediaRuntime(room, true, session.d1Room != nil, count, "media-ready")
		w.logger.Info("compositor subscribed source video", "room", room, "source", participant.Identity(), "codec", track.Codec().MimeType)
		go w.forwardSourceVideo(room, session, sourceID, track)
		if shouldReconcile {
			go w.reconcilePipeline(room, session)
		}
	}
	callback.OnTrackUnsubscribed = func(_ *webrtc.TrackRemote, publication *lksdk.RemoteTrackPublication, participant *lksdk.RemoteParticipant) {
		if publication.Name() != "camera-video" {
			return
		}
		session.mu.Lock()
		delete(session.sources, string(participant.Identity()))
		delete(session.tracks, string(participant.Identity()))
		delete(session.participants, string(participant.Identity()))
		count := len(session.sources)
		session.mu.Unlock()
		w.updateMediaRuntime(room, session.sourceRoom != nil, session.d1Room != nil, count, "media-ready")
	}

	sourceRoom, err := lksdk.ConnectToRoom(w.sourceURL, lksdk.ConnectInfo{
		APIKey: w.sourceKey, APISecret: w.sourceSecret, RoomName: room,
		ParticipantIdentity: "compositor-" + room, ParticipantName: "GPU Compositor Worker",
	}, callback)
	if err != nil {
		w.mediaFailed(room, session, "source SFU connection failed", err)
		return
	}
	session.sourceRoom = sourceRoom
	w.updateMediaRuntime(room, true, false, 0, "connecting-d1")

	d1Room, err := lksdk.ConnectToRoom(w.d1URL, lksdk.ConnectInfo{
		APIKey: w.d1Key, APISecret: w.d1Secret, RoomName: room + "-program",
		ParticipantIdentity: "compositor-" + room, ParticipantName: "GPU Compositor Worker",
	}, lksdk.NewRoomCallback())
	if err != nil {
		sourceRoom.Disconnect()
		w.mediaFailed(room, session, "D1 connection failed", err)
		return
	}
	session.d1Room = d1Room
	session.mu.Lock()
	count := len(session.sources)
	session.mu.Unlock()
	w.updateMediaRuntime(room, true, true, count, "media-ready")
	w.logger.Info("compositor media session connected", "room", room, "sourceURL", w.sourceURL, "d1URL", w.d1URL)
	go w.reconcilePipeline(room, session)
}

func (w *worker) forwardSourceVideo(room string, session *mediaSession, sourceID string, track *webrtc.TrackRemote) {
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		session.mu.Lock()
		selected := session.scene.SourceID == sourceID
		pipeline := session.pipeline
		session.mu.Unlock()
		if selected && pipeline != nil {
			if err := pipeline.WriteRTP(packet); err != nil {
				w.logger.Warn("compositor input stopped", "room", room, "source", sourceID, "error", err)
				return
			}
		}
	}
}

func (w *worker) reconcilePipeline(room string, session *mediaSession) {
	session.reconcileMu.Lock()
	defer session.reconcileMu.Unlock()
	session.mu.Lock()
	if session.d1Room == nil || session.scene.SourceID == "" || session.tracks[session.scene.SourceID] == nil {
		session.mu.Unlock()
		return
	}
	scene := session.scene
	d1Room := session.d1Room
	oldPipeline := session.pipeline
	outputTrack := session.outputTrack
	outputPub := session.outputPub
	started := session.started
	inputCodec := session.tracks[scene.SourceID].Codec()
	session.pipeline = nil
	session.mu.Unlock()
	if oldPipeline != nil {
		oldPipeline.Stop()
	}
	pipeline, err := startFFmpegPipeline(d1Room, scene, w.assetDir, inputCodec, outputTrack, outputPub, w.logger.With("room", room), func() {
		w.mu.Lock()
		runtime := w.rooms[room]
		runtime.OutputReady = true
		runtime.Status = "composed-preview-ready"
		runtime.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		w.rooms[room] = runtime
		w.mu.Unlock()
	})
	if err != nil {
		w.logger.Error("could not start FFmpeg compositor", "room", room, "error", err)
		w.mu.Lock()
		runtime := w.rooms[room]
		runtime.Status = "compose-error"
		w.rooms[room] = runtime
		w.mu.Unlock()
		return
	}
	pipeline.pub.SetMuted(!started)
	session.mu.Lock()
	session.pipeline = pipeline
	session.outputTrack = pipeline.track
	session.outputPub = pipeline.pub
	selectedTrack := session.tracks[scene.SourceID]
	selectedParticipant := session.participants[scene.SourceID]
	session.mu.Unlock()
	if selectedTrack != nil && selectedParticipant != nil {
		selectedParticipant.WritePLI(selectedTrack.SSRC())
	}
	w.logger.Info("FFmpeg compositor started", "room", room, "source", scene.SourceID, "revision", scene.Revision)
}

func extractH264ParameterSets(annexB []byte) [][]byte {
	var result [][]byte
	for offset := 0; offset+4 < len(annexB); {
		start := -1
		for index := offset; index+3 < len(annexB); index++ {
			if annexB[index] == 0 && annexB[index+1] == 0 && ((annexB[index+2] == 1) || (index+3 < len(annexB) && annexB[index+2] == 0 && annexB[index+3] == 1)) {
				start = index
				break
			}
		}
		if start < 0 {
			break
		}
		header := start + 3
		if annexB[start+2] == 0 {
			header++
		}
		next := len(annexB)
		for index := header + 1; index+3 < len(annexB); index++ {
			if annexB[index] == 0 && annexB[index+1] == 0 && (annexB[index+2] == 1 || (annexB[index+2] == 0 && annexB[index+3] == 1)) {
				next = index
				break
			}
		}
		if header < len(annexB) {
			nalType := annexB[header] & 0x1f
			if nalType == 7 || nalType == 8 {
				result = append(result, append([]byte(nil), annexB[start:next]...))
			}
		}
		offset = next
	}
	return result
}

func containsH264NALType(annexB []byte, wanted byte) bool {
	for offset := 0; offset+4 < len(annexB); {
		start, header, next := nextAnnexBNALU(annexB, offset)
		if start < 0 {
			return false
		}
		if header < len(annexB) && annexB[header]&0x1f == wanted {
			return true
		}
		offset = next
	}
	return false
}

func nextAnnexBNALU(annexB []byte, offset int) (start, header, next int) {
	start = -1
	for index := offset; index+3 < len(annexB); index++ {
		if annexB[index] == 0 && annexB[index+1] == 0 && (annexB[index+2] == 1 || (annexB[index+2] == 0 && annexB[index+3] == 1)) {
			start = index
			break
		}
	}
	if start < 0 {
		return -1, -1, len(annexB)
	}
	header = start + 3
	if annexB[start+2] == 0 {
		header++
	}
	next = len(annexB)
	for index := header + 1; index+3 < len(annexB); index++ {
		if annexB[index] == 0 && annexB[index+1] == 0 && (annexB[index+2] == 1 || (annexB[index+2] == 0 && annexB[index+3] == 1)) {
			next = index
			break
		}
	}
	return start, header, next
}

func mergeH264ParameterSets(current, incoming [][]byte) [][]byte {
	byType := make(map[byte][]byte)
	for _, set := range append(current, incoming...) {
		header := 3
		if len(set) > 3 && set[2] == 0 {
			header = 4
		}
		if header < len(set) {
			byType[set[header]&0x1f] = append([]byte(nil), set...)
		}
	}
	result := make([][]byte, 0, 2)
	for _, nalType := range []byte{7, 8} {
		if value := byType[nalType]; value != nil {
			result = append(result, value)
		}
	}
	return result
}

func drainTrack(track *webrtc.TrackRemote) {
	for {
		if _, _, err := track.ReadRTP(); err != nil {
			return
		}
	}
}

func (w *worker) updateMediaRuntime(room string, source, d1 bool, videoSources int, status string) {
	w.mu.Lock()
	runtime := w.rooms[room]
	runtime.SourceSFU = source
	runtime.D1 = d1
	runtime.VideoSources = videoSources
	runtime.Status = status
	runtime.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	w.rooms[room] = runtime
	w.mu.Unlock()
}

func (w *worker) mediaFailed(room string, session *mediaSession, message string, err error) {
	w.mu.Lock()
	delete(w.media, room)
	runtime := w.rooms[room]
	runtime.Status = "media-error"
	runtime.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	w.rooms[room] = runtime
	w.mu.Unlock()
	w.logger.Error(message, "room", room, "error", err)
}

func (w *worker) handleHealth(rw http.ResponseWriter, _ *http.Request) {
	w.mu.RLock()
	rooms := make([]roomRuntime, 0, len(w.rooms))
	for _, room := range w.rooms {
		rooms = append(rooms, room)
	}
	w.mu.RUnlock()
	writeJSON(rw, http.StatusOK, map[string]any{"status": "ok", "mode": "control-runtime", "rooms": rooms})
}

func (w *worker) handleReady(rw http.ResponseWriter, _ *http.Request) {
	if !w.ready.Load() {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"status": "not-ready"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]string{"status": "ready"})
}

func (w *worker) handleMetrics(rw http.ResponseWriter, _ *http.Request) {
	w.mu.RLock()
	roomCount := len(w.rooms)
	readyAssets := 0
	for _, room := range w.rooms {
		if room.AssetsReady {
			readyAssets++
		}
	}
	w.mu.RUnlock()
	rw.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(rw, "compositor_rooms %d\ncompositor_rooms_assets_ready %d\n", roomCount, readyAssets)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
