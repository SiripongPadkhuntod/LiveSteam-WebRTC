package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxAssetSize = 5 << 20

type assetService struct {
	dir    string
	logger *slog.Logger
}

type assetResponse struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

func newAssetService(dir string, logger *slog.Logger) (*assetService, error) {
	if strings.TrimSpace(dir) == "" {
		dir = "./data/assets"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create asset directory: %w", err)
	}
	return &assetService{dir: dir, logger: logger}, nil
}

func (s *assetService) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetSize+(1<<20))
	if err := r.ParseMultipartForm(maxAssetSize + (1 << 20)); err != nil {
		writeError(w, http.StatusBadRequest, "invalid upload or file exceeds 5 MB")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "image file is required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxAssetSize+1))
	if err != nil || len(data) == 0 || len(data) > maxAssetSize {
		writeError(w, http.StatusBadRequest, "image must not exceed 5 MB")
		return
	}
	contentType := http.DetectContentType(data)
	extension, ok := imageExtension(contentType)
	if !ok {
		writeError(w, http.StatusUnsupportedMediaType, "only PNG, JPEG, WebP and GIF are supported")
		return
	}
	digest := sha256.Sum256(data)
	name := hex.EncodeToString(digest[:16]) + extension
	path := filepath.Join(s.dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		s.logger.Error("could not store asset", "name", header.Filename, "error", err)
		writeError(w, http.StatusInternalServerError, "could not store asset")
		return
	}
	writeJSON(w, http.StatusCreated, assetResponse{
		ID: name, URL: "/api/assets/" + name, ContentType: contentType, Size: int64(len(data)),
	})
}

func (s *assetService) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validAssetID(id) {
		writeError(w, http.StatusBadRequest, "invalid asset id")
		return
	}
	file, err := os.Open(filepath.Join(s.dir, id))
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read asset")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read asset")
		return
	}
	w.Header().Set("Content-Type", mime.TypeByExtension(filepath.Ext(id)))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, id, info.ModTime(), file)
}

func imageExtension(contentType string) (string, bool) {
	switch contentType {
	case "image/png":
		return ".png", true
	case "image/jpeg":
		return ".jpg", true
	case "image/webp":
		return ".webp", true
	case "image/gif":
		return ".gif", true
	default:
		return "", false
	}
}

func validAssetID(id string) bool {
	if id == "" || filepath.Base(id) != id || len(id) > 80 {
		return false
	}
	extension := filepath.Ext(id)
	if extension != ".png" && extension != ".jpg" && extension != ".webp" && extension != ".gif" {
		return false
	}
	base := strings.TrimSuffix(id, extension)
	if len(base) != 32 {
		return false
	}
	_, err := hex.DecodeString(base)
	return err == nil
}
