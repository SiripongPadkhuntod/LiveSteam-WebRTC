package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/redis/go-redis/v9"
)

const maxSceneBody = 8 << 20

type sceneOutput struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	FPS    int `json:"fps"`
}

type sceneImageLayer struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	Src      string  `json:"src"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Opacity  float64 `json:"opacity"`
	ZIndex   int     `json:"zIndex"`
	Visible  bool    `json:"visible"`
	FlipH    bool    `json:"flipH,omitempty"`
	FlipV    bool    `json:"flipV,omitempty"`
	Rotation float64 `json:"rotation,omitempty"`
}

type programScene struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Revision int64             `json:"revision"`
	SourceID string            `json:"sourceId,omitempty"`
	Output   sceneOutput       `json:"output"`
	Layers   []sceneImageLayer `json:"layers"`
}

type sceneRepository interface {
	Get(context.Context, string) (programScene, bool, error)
	Put(context.Context, string, programScene) error
}

type sceneEventPublisher interface {
	PublishScene(context.Context, string, programScene) error
}

type sceneUpdateEvent struct {
	Room  string       `json:"room"`
	Scene programScene `json:"scene"`
}

type redisSceneRepository struct{ client *redis.Client }

func (r redisSceneRepository) Get(ctx context.Context, room string) (programScene, bool, error) {
	value, err := r.client.Get(ctx, "scene:"+room).Bytes()
	if errors.Is(err, redis.Nil) {
		return programScene{}, false, nil
	}
	if err != nil {
		return programScene{}, false, err
	}
	var scene programScene
	if err := json.Unmarshal(value, &scene); err != nil {
		return programScene{}, false, err
	}
	return scene, true, nil
}

func (r redisSceneRepository) Put(ctx context.Context, room string, scene programScene) error {
	value, err := json.Marshal(scene)
	if err != nil {
		return err
	}
	return r.client.Set(ctx, "scene:"+room, value, 0).Err()
}

func (r redisSceneRepository) PublishScene(ctx context.Context, room string, scene programScene) error {
	value, err := json.Marshal(sceneUpdateEvent{Room: room, Scene: scene})
	if err != nil {
		return err
	}
	return r.client.Publish(ctx, "scene.updates", value).Err()
}

type memorySceneRepository struct {
	mu     sync.RWMutex
	scenes map[string]programScene
}

func newMemorySceneRepository() *memorySceneRepository {
	return &memorySceneRepository{scenes: make(map[string]programScene)}
}

func (r *memorySceneRepository) Get(_ context.Context, room string) (programScene, bool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	scene, ok := r.scenes[room]
	return scene, ok, nil
}

func (r *memorySceneRepository) Put(_ context.Context, room string, scene programScene) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.scenes[room] = scene
	return nil
}

type sceneService struct {
	repo   sceneRepository
	logger *slog.Logger
	mu     sync.Mutex
}

func newSceneService(redisURL string, logger *slog.Logger) *sceneService {
	if strings.TrimSpace(redisURL) == "" {
		return &sceneService{repo: newMemorySceneRepository(), logger: logger}
	}
	options := &redis.Options{Addr: strings.TrimPrefix(strings.TrimPrefix(redisURL, "redis://"), "rediss://")}
	return &sceneService{repo: redisSceneRepository{client: redis.NewClient(options)}, logger: logger}
}

func (s *sceneService) handleGet(w http.ResponseWriter, r *http.Request) {
	room := strings.TrimSpace(r.PathValue("room"))
	if !validSceneRoom(room) {
		writeError(w, http.StatusBadRequest, "invalid room")
		return
	}
	scene, found, err := s.repo.Get(r.Context(), room)
	if err != nil {
		s.logger.Error("could not read scene", "room", room, "error", err)
		writeError(w, http.StatusServiceUnavailable, "scene store unavailable")
		return
	}
	if !found {
		scene = defaultProgramScene(room)
	}
	writeJSON(w, http.StatusOK, scene)
}

func (s *sceneService) handlePut(w http.ResponseWriter, r *http.Request) {
	room := strings.TrimSpace(r.PathValue("room"))
	if !validSceneRoom(room) {
		writeError(w, http.StatusBadRequest, "invalid room")
		return
	}
	var incoming programScene
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSceneBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&incoming); err != nil {
		writeError(w, http.StatusBadRequest, "invalid scene JSON")
		return
	}
	if err := validateProgramScene(incoming); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Serialize updates per API instance. Redis remains the shared source of
	// truth; production multi-instance deployments replace this with WATCH or
	// a Lua compare-and-set using the same revision contract.
	s.mu.Lock()
	defer s.mu.Unlock()
	current, found, err := s.repo.Get(r.Context(), room)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "scene store unavailable")
		return
	}
	if found && incoming.Revision <= current.Revision {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "scene revision conflict", "scene": current})
		return
	}
	incoming.ID = room + "-main"
	if incoming.Name == "" {
		incoming.Name = "Main Scene"
	}
	if err := s.repo.Put(r.Context(), room, incoming); err != nil {
		writeError(w, http.StatusServiceUnavailable, "scene store unavailable")
		return
	}
	if publisher, ok := s.repo.(sceneEventPublisher); ok {
		if err := publisher.PublishScene(r.Context(), room, incoming); err != nil {
			s.logger.Warn("scene saved but update event could not be published", "room", room, "revision", incoming.Revision, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, incoming)
}

func validateProgramScene(scene programScene) error {
	if scene.Output.Width != 1920 || scene.Output.Height != 1080 || scene.Output.FPS != 60 {
		return errors.New("output must be 1920x1080 at 60 fps")
	}
	if len(scene.Layers) > 64 {
		return errors.New("scene must not exceed 64 layers")
	}
	for _, layer := range scene.Layers {
		if layer.ID == "" || layer.Type != "image" || layer.Name == "" {
			return errors.New("invalid image layer")
		}
		if !strings.HasPrefix(layer.Src, "data:image/") && !strings.HasPrefix(layer.Src, "/") {
			return errors.New("image source must be an uploaded asset or image data URL")
		}
		if layer.X < 0 || layer.Y < 0 || layer.Width < 1 || layer.Height < 1 || layer.X+layer.Width > 100.01 || layer.Y+layer.Height > 100.01 {
			return fmt.Errorf("layer %s is outside the output bounds", layer.ID)
		}
		if layer.Opacity < 0 || layer.Opacity > 1 {
			return fmt.Errorf("layer %s has invalid opacity", layer.ID)
		}
	}
	return nil
}

func validSceneRoom(room string) bool {
	if room == "" || len(room) > 128 {
		return false
	}
	for _, char := range room {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}

func defaultProgramScene(room string) programScene {
	return programScene{
		ID: room + "-main", Name: "Main Scene", Revision: 1,
		Output: sceneOutput{Width: 1920, Height: 1080, FPS: 60},
		Layers: []sceneImageLayer{},
	}
}
