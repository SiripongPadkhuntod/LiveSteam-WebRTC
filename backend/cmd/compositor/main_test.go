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

func TestExtractAndMergeH264ParameterSets(t *testing.T) {
	spsOld := []byte{0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f}
	spsNew := []byte{0, 0, 1, 0x67, 0x42, 0x00, 0x20}
	pps := []byte{0, 0, 0, 1, 0x68, 0xce, 0x06}
	frame := []byte{0, 0, 1, 0x65, 0x01, 0x02}

	sets := extractH264ParameterSets(append(append(append([]byte{}, spsOld...), pps...), frame...))
	if len(sets) != 2 {
		t.Fatalf("expected SPS and PPS, got %d sets", len(sets))
	}
	merged := mergeH264ParameterSets(sets, extractH264ParameterSets(spsNew))
	if len(merged) != 2 || string(merged[0]) != string(spsNew) || string(merged[1]) != string(pps) {
		t.Fatalf("parameter sets were not replaced by NAL type: %#v", merged)
	}
	if !containsH264NALType(frame, 5) || containsH264NALType(frame, 7) {
		t.Fatal("keyframe NAL type detection failed")
	}
}
