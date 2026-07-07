package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTokenHandler(t *testing.T) {
	cfg := config{APIKey: "devkey", APISecret: "devsecret_devsecret_devsecret_12345"}
	body, _ := json.Marshal(tokenRequest{Identity: "viewer-1", Room: "demo", Role: "viewer"})
	req := httptest.NewRequest(http.MethodPost, "/api/token", bytes.NewReader(body))
	res := httptest.NewRecorder()

	tokenHandler(cfg).ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}
	var payload tokenResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Token == "" {
		t.Fatal("expected a token")
	}
}

func TestTokenHandlerRejectsPublisherRoleFromViewer(t *testing.T) {
	cfg := config{APIKey: "devkey", APISecret: "devsecret_devsecret_devsecret_12345"}
	body := []byte(`{"identity":"viewer-1","room":"demo","role":"admin"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/token", bytes.NewReader(body))
	res := httptest.NewRecorder()

	tokenHandler(cfg).ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", res.Code)
	}
}

func TestTokenHandlerCreatesD1Token(t *testing.T) {
	cfg := config{
		APIKey:      "devkey",
		APISecret:   "devsecret_devsecret_devsecret_12345",
		D1APIKey:    "d1key",
		D1APISecret: "d1secret_d1secret_d1secret_12345",
	}
	body, _ := json.Marshal(tokenRequest{Identity: "program-1", Room: "demo-program", Role: "broadcaster", Target: "d1"})
	req := httptest.NewRequest(http.MethodPost, "http://192.168.1.10:8080/api/token", bytes.NewReader(body))
	res := httptest.NewRecorder()

	tokenHandler(cfg).ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}
	var payload tokenResponse
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Token == "" || payload.URL != "ws://192.168.1.10:7980" {
		t.Fatalf("unexpected D1 token response: %+v", payload)
	}
}

func TestOriginAllowedForPrivateLAN(t *testing.T) {
	if !originAllowed("http://192.168.1.25:3001", nil, true) {
		t.Fatal("expected private LAN origin to be allowed in local mode")
	}
	if originAllowed("https://example.com:3001", nil, true) {
		t.Fatal("expected public origin to be rejected")
	}
}

func TestLiveKitURLUsesRequestHost(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://192.168.1.10:8080/api/token", nil)
	if got := liveKitURL("", req); got != "ws://192.168.1.10:7880" {
		t.Fatalf("unexpected LiveKit URL: %s", got)
	}
}

func TestRoomStoreCreatesAndResolvesCode(t *testing.T) {
	store := newRoomStore()
	createRequest := httptest.NewRequest(http.MethodPost, "/api/rooms", bytes.NewBufferString(`{"name":"Auction Room"}`))
	createResponse := httptest.NewRecorder()
	store.handleCreate(createResponse, createRequest)

	if createResponse.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", createResponse.Code, createResponse.Body.String())
	}
	var created roomRecord
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if len(created.Code) != 6 || created.ID == "" || created.StudioIdentity == "" {
		t.Fatalf("unexpected room response: %+v", created)
	}

	resolveRequest := httptest.NewRequest(http.MethodGet, "/api/rooms?code="+created.Code, nil)
	resolveResponse := httptest.NewRecorder()
	store.handleGet(resolveResponse, resolveRequest)
	if resolveResponse.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resolveResponse.Code, resolveResponse.Body.String())
	}
	var resolved roomRecord
	if err := json.NewDecoder(resolveResponse.Body).Decode(&resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.ID != created.ID {
		t.Fatalf("resolved wrong room: got %s want %s", resolved.ID, created.ID)
	}
}

func TestRoomStoreRejectsUnknownCode(t *testing.T) {
	store := newRoomStore()
	request := httptest.NewRequest(http.MethodGet, "/api/rooms?code=ABC123", nil)
	response := httptest.NewRecorder()
	store.handleGet(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", response.Code)
	}
}
