package main

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type sfuStatsResponse struct {
	TotalStreams     int         `json:"total_streams"`
	TotalViewerCount int         `json:"total_viewercount"`
	Servers          []sfuServer `json:"servers"`
}

type sfuServer struct {
	Server      string      `json:"server"`
	Connect     bool        `json:"connect"`
	Capacity    int         `json:"capacity"`
	StreamCount int         `json:"stream"`
	ViewerCount int         `json:"viewercount"`
	Streams     []sfuStream `json:"streams"`
}

type sfuStream struct {
	StreamID     string `json:"streamId"`
	ViewerCount  int    `json:"ViewerCount"`
	VideoHeight  int    `json:"videoHeight"`
	VideoWidth   int    `json:"videoWidth"`
	VideoBitrate int    `json:"videoBitrate"`
	AudioBitrate int    `json:"audioBitrate"`
	VideoCodec   string `json:"videoCodec"`
}

type internalServerConfig struct {
	ExternalURL string
	InternalURL string
	APIKey      string
	APISecret   string
	Capacity    int
}

func sfuStatsHandler(cfg config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serversConfig := []internalServerConfig{
			{
				ExternalURL: cfg.LiveKitURL,
				InternalURL: cfg.LiveKitInternalURL,
				APIKey:      cfg.APIKey,
				APISecret:   cfg.APISecret,
				Capacity:    200, // You can configure this if needed
			},
			{
				ExternalURL: cfg.D1LiveKitURL,
				InternalURL: cfg.D1InternalURL,
				APIKey:      cfg.D1APIKey,
				APISecret:   cfg.D1APISecret,
				Capacity:    200,
			},
		}

		var wg sync.WaitGroup
		var mu sync.Mutex

		response := sfuStatsResponse{
			Servers: make([]sfuServer, 0, len(serversConfig)),
		}

		for _, srv := range serversConfig {
			wg.Add(1)
			go func(sc internalServerConfig) {
				defer wg.Done()

				displayName := sc.ExternalURL
				if displayName == "" {
					displayName = sc.InternalURL
				}
				if displayName == "" {
					displayName = "unknown-server"
				}

				serverStat := sfuServer{
					Server:   displayName,
					Connect:  false,
					Capacity: sc.Capacity,
					Streams:  []sfuStream{},
				}

				apiURL := sc.InternalURL
				if apiURL == "" {
					apiURL = sc.ExternalURL
				}

				if apiURL != "" {
					roomClient := lksdk.NewRoomServiceClient(apiURL, sc.APIKey, sc.APISecret)

					ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
					defer cancel()

					roomsRes, err := roomClient.ListRooms(ctx, &livekit.ListRoomsRequest{})
					if err == nil {
						serverStat.Connect = true
						for _, room := range roomsRes.Rooms {
							viewers := int(room.NumParticipants - room.NumPublishers)
							if viewers < 0 {
								viewers = 0
							}

							stream := sfuStream{
								StreamID:     room.Name,
								ViewerCount:  viewers,
								VideoCodec:   "H264",
								AudioBitrate: 96000,
							}

							// Try to get video details
							parts, err := roomClient.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room.Name})
							if err == nil {
								for _, p := range parts.Participants {
									if p.IsPublisher {
										for _, t := range p.Tracks {
											if t.Type == livekit.TrackType_VIDEO {
												stream.VideoHeight = int(t.Height)
												stream.VideoWidth = int(t.Width)
												codec := t.MimeType
												if idx := strings.Index(codec, "/"); idx != -1 {
													codec = strings.ToUpper(codec[idx+1:])
												}
												if codec != "" {
													stream.VideoCodec = codec
												}
											}
										}
									}
								}
							}

							serverStat.Streams = append(serverStat.Streams, stream)
							serverStat.StreamCount++
							serverStat.ViewerCount += viewers
						}
					}
				}

				mu.Lock()
				response.Servers = append(response.Servers, serverStat)
				response.TotalStreams += serverStat.StreamCount
				response.TotalViewerCount += serverStat.ViewerCount
				mu.Unlock()

			}(srv)
		}

		wg.Wait()

		// Sort servers to maintain consistent order
		for i := 0; i < len(response.Servers); i++ {
			for j := i + 1; j < len(response.Servers); j++ {
				if response.Servers[i].Server > response.Servers[j].Server {
					response.Servers[i], response.Servers[j] = response.Servers[j], response.Servers[i]
				}
			}
		}

		writeJSON(w, http.StatusOK, response)
	}
}
