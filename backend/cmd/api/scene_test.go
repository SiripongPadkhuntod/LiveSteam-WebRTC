package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSceneServiceStoresRevisionedScene(t *testing.T) {
	service := &sceneService{repo: newMemorySceneRepository(), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	scene := defaultProgramScene("room-one")
	scene.Revision = 2
	scene.Layers = []sceneImageLayer{{
		ID: "logo", Type: "image", Name: "logo.png", Src: "data:image/png;base64,AA==",
		X: 70, Y: 5, Width: 25, Height: 25, Opacity: 1, ZIndex: 1, Visible: true,
	}}
	body, _ := json.Marshal(scene)
	request := httptest.NewRequest(http.MethodPut, "/api/scenes/room-one", bytes.NewReader(body))
	request.SetPathValue("room", "room-one")
	response := httptest.NewRecorder()
	service.handlePut(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/api/scenes/room-one", nil)
	getRequest.SetPathValue("room", "room-one")
	getResponse := httptest.NewRecorder()
	service.handleGet(getResponse, getRequest)
	var stored programScene
	if err := json.NewDecoder(getResponse.Body).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 2 || len(stored.Layers) != 1 || stored.Layers[0].ID != "logo" {
		t.Fatalf("unexpected stored scene: %+v", stored)
	}
}

func TestSceneServiceRejectsStaleRevision(t *testing.T) {
	repo := newMemorySceneRepository()
	_ = repo.Put(t.Context(), "room-one", defaultProgramScene("room-one"))
	service := &sceneService{repo: repo, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	scene := defaultProgramScene("room-one")
	body, _ := json.Marshal(scene)
	request := httptest.NewRequest(http.MethodPut, "/api/scenes/room-one", bytes.NewReader(body))
	request.SetPathValue("room", "room-one")
	response := httptest.NewRecorder()
	service.handlePut(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", response.Code, response.Body.String())
	}
}
