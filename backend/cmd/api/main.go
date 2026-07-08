package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
)

type config struct {
	Addr               string
	RedisURL           string
	AssetDir           string
	APIKey             string
	APISecret          string
	LiveKitURL         string
	LiveKitInternalURL string
	D1APIKey           string
	D1APISecret        string
	D1LiveKitURL       string
	D1InternalURL      string
	AllowedOrigins     []string
	AllowPrivate       bool
}

type tokenRequest struct {
	Identity string `json:"identity"`
	Room     string `json:"room"`
	Role     string `json:"role"`
	Target   string `json:"target,omitempty"`
}

type tokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
}

type roomRecord struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Code           string    `json:"code"`
	StudioIdentity string    `json:"studioIdentity"`
	CreatedAt      time.Time `json:"createdAt"`
}

type roomStore struct {
	mu     sync.RWMutex
	byCode map[string]roomRecord
}

type createRoomRequest struct {
	Name string `json:"name"`
}

func main() {
	cfg := loadConfig()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	rooms := newRoomStore()
	bridges := newBridgeManager(cfg, logger)
	scenes := newSceneService(cfg.RedisURL, logger)
	assets, err := newAssetService(cfg.AssetDir, logger)
	if err != nil {
		logger.Error("asset service failed to start", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("POST /api/token", tokenHandler(cfg))
	mux.HandleFunc("POST /api/bridge", bridges.handleEnsure)
	mux.HandleFunc("GET /api/scenes/{room}", scenes.handleGet)
	mux.HandleFunc("PUT /api/scenes/{room}", scenes.handlePut)
	mux.HandleFunc("POST /api/assets", assets.handleUpload)
	mux.HandleFunc("GET /api/assets/{id}", assets.handleGet)
	mux.HandleFunc("GET /api/rooms", rooms.handleGet)
	mux.HandleFunc("POST /api/rooms", rooms.handleCreate)

	handler := withCORS(cfg.AllowedOrigins, cfg.AllowPrivate, withLogging(logger, mux))
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	logger.Info("control API listening", "address", cfg.Addr, "origins", cfg.AllowedOrigins)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func newRoomStore() *roomStore {
	return &roomStore{byCode: make(map[string]roomRecord)}
}

func (s *roomStore) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRoomRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 120 {
		writeError(w, http.StatusBadRequest, "room name is required and must not exceed 120 characters")
		return
	}

	code, err := s.uniqueCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create room code")
		return
	}
	id := "room-" + strings.ToLower(code)
	record := roomRecord{
		ID:             id,
		Name:           req.Name,
		Code:           code,
		StudioIdentity: "studio-" + id,
		CreatedAt:      time.Now().UTC(),
	}

	s.mu.Lock()
	s.byCode[code] = record
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, record)
}

func (s *roomStore) handleGet(w http.ResponseWriter, r *http.Request) {
	code := normalizeRoomCode(r.URL.Query().Get("code"))
	if code != "" {
		s.mu.RLock()
		record, ok := s.byCode[code]
		s.mu.RUnlock()
		if !ok {
			writeError(w, http.StatusNotFound, "room code not found")
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}

	s.mu.RLock()
	rooms := make([]roomRecord, 0, len(s.byCode))
	for _, room := range s.byCode {
		rooms = append(rooms, room)
	}
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string][]roomRecord{"rooms": rooms})
}

func (s *roomStore) uniqueCode() (string, error) {
	for range 10 {
		code, err := generateRoomCode(6)
		if err != nil {
			return "", err
		}
		s.mu.RLock()
		_, exists := s.byCode[code]
		s.mu.RUnlock()
		if !exists {
			return code, nil
		}
	}
	return "", errors.New("could not allocate unique room code")
}

func generateRoomCode(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	for i := range bytes {
		bytes[i] = alphabet[int(bytes[i])%len(alphabet)]
	}
	return string(bytes), nil
}

func normalizeRoomCode(value string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), "-", ""))
}

func loadConfig() config {
	return config{
		Addr:               env("HTTP_ADDR", ":8080"),
		RedisURL:           os.Getenv("REDIS_URL"),
		AssetDir:           env("ASSET_DIR", "/data/assets"),
		APIKey:             env("LIVEKIT_API_KEY", "devkey"),
		APISecret:          env("LIVEKIT_API_SECRET", "devsecret_devsecret_devsecret_12345"),
		LiveKitURL:         os.Getenv("LIVEKIT_URL"),
		LiveKitInternalURL: os.Getenv("LIVEKIT_INTERNAL_URL"),
		D1APIKey:           env("D1_LIVEKIT_API_KEY", "d1key"),
		D1APISecret:        env("D1_LIVEKIT_API_SECRET", "d1secret_d1secret_d1secret_12345"),
		D1LiveKitURL:       os.Getenv("D1_LIVEKIT_URL"),
		D1InternalURL:      os.Getenv("D1_LIVEKIT_INTERNAL_URL"),
		AllowedOrigins:     splitCSV(env("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:3001")),
		AllowPrivate:       envBool("ALLOW_PRIVATE_ORIGINS", true),
	}
}

func tokenHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req tokenRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		req.Identity = strings.TrimSpace(req.Identity)
		req.Room = strings.TrimSpace(req.Room)
		if req.Identity == "" || req.Room == "" {
			writeError(w, http.StatusBadRequest, "identity and room are required")
			return
		}
		if len(req.Identity) > 128 || len(req.Room) > 128 {
			writeError(w, http.StatusBadRequest, "identity or room is too long")
			return
		}

		grant := &auth.VideoGrant{RoomJoin: true, Room: req.Room}
		switch req.Role {
		case "broadcaster":
			grant.CanPublish = boolPtr(true)
			grant.CanSubscribe = boolPtr(true)
		case "viewer", "monitor":
			grant.CanPublish = boolPtr(false)
			grant.CanSubscribe = boolPtr(true)
		default:
			writeError(w, http.StatusBadRequest, "role must be broadcaster, monitor, or viewer")
			return
		}
		grant.CanPublishData = boolPtr(req.Role == "broadcaster" || req.Role == "monitor")

		apiKey := cfg.APIKey
		apiSecret := cfg.APISecret
		configuredURL := cfg.LiveKitURL
		publicPort := "7880"
		switch req.Target {
		case "", "source":
		case "d1":
			apiKey = cfg.D1APIKey
			apiSecret = cfg.D1APISecret
			configuredURL = cfg.D1LiveKitURL
			publicPort = "7980"
		default:
			writeError(w, http.StatusBadRequest, "target must be source or d1")
			return
		}

		token := auth.NewAccessToken(apiKey, apiSecret).
			SetIdentity(req.Identity).
			SetValidFor(2 * time.Hour).
			AddGrant(grant)
		jwt, err := token.ToJWT()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not create token")
			return
		}

		writeJSON(w, http.StatusOK, tokenResponse{
			Token: jwt,
			URL:   liveKitURLAtPort(configuredURL, r, publicPort),
		})
	}
}

func boolPtr(value bool) *bool { return &value }

func withCORS(allowedOrigins []string, allowPrivate bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if originAllowed(origin, allowedOrigins, allowPrivate) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originAllowed(origin string, allowedOrigins []string, allowPrivate bool) bool {
	for _, allowed := range allowedOrigins {
		if origin == allowed {
			return true
		}
	}
	if !allowPrivate || origin == "" {
		return false
	}

	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	if port := parsed.Port(); port != "3000" && port != "3001" {
		return false
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback())
}

func liveKitURL(configured string, r *http.Request) string {
	return liveKitURLAtPort(configured, r, "7880")
}

func liveKitURLAtPort(configured string, r *http.Request, port string) string {
	if configured != "" {
		return configured
	}

	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(r.Host); err == nil {
		host = parsedHost
	}
	scheme := "ws"
	if r.TLS != nil {
		scheme = "wss"
	}
	return scheme + "://" + net.JoinHostPort(host, port)
}

func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
