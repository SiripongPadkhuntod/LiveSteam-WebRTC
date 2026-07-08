package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAssetServiceUploadsAndServesImage(t *testing.T) {
	service, err := newAssetService(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "logo.png")
	_, _ = part.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0})
	_ = writer.Close()

	uploadRequest := httptest.NewRequest(http.MethodPost, "/api/assets", &body)
	uploadRequest.Header.Set("Content-Type", writer.FormDataContentType())
	uploadResponse := httptest.NewRecorder()
	service.handleUpload(uploadResponse, uploadRequest)
	if uploadResponse.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", uploadResponse.Code, uploadResponse.Body.String())
	}
	var asset assetResponse
	if err := json.NewDecoder(uploadResponse.Body).Decode(&asset); err != nil {
		t.Fatal(err)
	}

	getRequest := httptest.NewRequest(http.MethodGet, asset.URL, nil)
	getRequest.SetPathValue("id", asset.ID)
	getResponse := httptest.NewRecorder()
	service.handleGet(getResponse, getRequest)
	if getResponse.Code != http.StatusOK || getResponse.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("unexpected asset response: %d %s", getResponse.Code, getResponse.Header().Get("Content-Type"))
	}
}

func TestAssetServiceRejectsNonImage(t *testing.T) {
	service, _ := newAssetService(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "payload.txt")
	_, _ = part.Write([]byte("not an image"))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/assets", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	service.handleUpload(response, request)
	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", response.Code)
	}
}
