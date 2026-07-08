package main

import (
	"io"
	"log/slog"
	"testing"
)

func TestWorkerAppliesOnlyNewerSceneRevision(t *testing.T) {
	w := &worker{assetDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), rooms: make(map[string]roomRuntime)}
	w.applyScene("room-one", programScene{ID: "main", Revision: 3})
	w.applyScene("room-one", programScene{ID: "stale", Revision: 2})
	if got := w.rooms["room-one"]; got.Revision != 3 || got.SceneID != "main" {
		t.Fatalf("stale revision replaced current scene: %+v", got)
	}
}

func TestWorkerWaitsForMissingAsset(t *testing.T) {
	w := &worker{assetDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), rooms: make(map[string]roomRuntime)}
	w.applyScene("room-one", programScene{ID: "main", Revision: 2, Layers: []sceneImageLayer{{Src: "/api/assets/0123456789abcdef0123456789abcdef.png", Visible: true}}})
	if got := w.rooms["room-one"]; got.AssetsReady || got.Status != "waiting-assets" {
		t.Fatalf("expected worker to wait for asset: %+v", got)
	}
}
