package main

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"sync"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// ffmpegPipeline is the local CPU reference compositor. Production replaces
// libx264 with NVENC while preserving this scene and LiveKit boundary.
type ffmpegPipeline struct {
	stdin    io.WriteCloser
	cmd      *exec.Cmd
	udp      *net.UDPConn
	track    *webrtc.TrackLocalStaticRTP
	pub      *lksdk.LocalTrackPublication
	d1       *lksdk.Room
	log      *slog.Logger
	onPacket func()
	stopOnce sync.Once
}

func startFFmpegPipeline(d1 *lksdk.Room, scene programScene, assetDir string, logger *slog.Logger, onPacket func()) (*ffmpegPipeline, error) {
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		return nil, err
	}
	port := udp.LocalAddr().(*net.UDPAddr).Port
	args := ffmpegArgs(scene, assetDir, port)
	cmd := exec.Command("ffmpeg", args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		udp.Close()
		return nil, err
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stdout
	if err := cmd.Start(); err != nil {
		stdin.Close()
		udp.Close()
		return nil, fmt.Errorf("start ffmpeg: %w", err)
	}

	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
	}, "compositor-preview-video", "compositor-preview")
	if err != nil {
		_ = cmd.Process.Kill()
		stdin.Close()
		udp.Close()
		return nil, err
	}
	pub, err := d1.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name: "compositor-preview-video", Source: livekit.TrackSource_CAMERA,
		Stream: "compositor-preview", VideoWidth: 1920, VideoHeight: 1080,
	})
	if err != nil {
		_ = cmd.Process.Kill()
		stdin.Close()
		udp.Close()
		return nil, err
	}
	pipeline := &ffmpegPipeline{stdin: stdin, cmd: cmd, udp: udp, track: track, pub: pub, d1: d1, log: logger, onPacket: onPacket}
	go pipeline.forwardOutput()
	go func() {
		if err := cmd.Wait(); err != nil {
			logger.Warn("ffmpeg compositor stopped", "error", err)
		}
	}()
	return pipeline, nil
}

func (p *ffmpegPipeline) WriteAnnexB(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	_, err := p.stdin.Write(data)
	return err
}

func (p *ffmpegPipeline) forwardOutput() {
	buffer := make([]byte, 1600)
	for {
		n, _, err := p.udp.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		var packet rtp.Packet
		if packet.Unmarshal(buffer[:n]) != nil {
			continue
		}
		if err := p.track.WriteRTP(&packet); err != nil {
			return
		}
		if p.onPacket != nil {
			p.onPacket()
			p.onPacket = nil
		}
	}
}

func (p *ffmpegPipeline) Stop() {
	p.stopOnce.Do(func() {
		_ = p.stdin.Close()
		_ = p.udp.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		if p.pub != nil {
			_ = p.d1.LocalParticipant.UnpublishTrack(p.pub.SID())
		}
	})
}

func ffmpegArgs(scene programScene, assetDir string, port int) []string {
	args := []string{"-hide_banner", "-loglevel", "warning", "-fflags", "nobuffer", "-flags", "low_delay", "-f", "h264", "-i", "pipe:0"}
	layers := append([]sceneImageLayer(nil), scene.Layers...)
	sort.SliceStable(layers, func(i, j int) bool { return layers[i].ZIndex < layers[j].ZIndex })
	visible := make([]sceneImageLayer, 0, len(layers))
	for _, layer := range layers {
		if !layer.Visible || !stringsHasAssetPrefix(layer.Src) {
			continue
		}
		visible = append(visible, layer)
		args = append(args, "-loop", "1", "-framerate", "60", "-i", filepath.Join(assetDir, filepath.Base(layer.Src)))
	}
	filter := "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black[base0]"
	current := "base0"
	for index, layer := range visible {
		width := max(2, int(layer.Width*19.2))
		height := max(2, int(layer.Height*10.8))
		x := max(0, int(layer.X*19.2))
		y := max(0, int(layer.Y*10.8))
		imageLabel := "img" + strconv.Itoa(index+1)
		outputLabel := "v" + strconv.Itoa(index+1)
		filter += fmt.Sprintf(";[%d:v]scale=%d:%d[%s];[%s][%s]overlay=%d:%d[%s]", index+1, width, height, imageLabel, current, imageLabel, x, y, outputLabel)
		current = outputLabel
	}
	args = append(args,
		"-filter_complex", filter, "-map", "["+current+"]", "-an",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
		"-profile:v", "baseline", "-pix_fmt", "yuv420p", "-r", "60", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-bf", "0",
		"-b:v", "8000k", "-maxrate", "8000k", "-bufsize", "134k",
		"-f", "rtp", fmt.Sprintf("rtp://127.0.0.1:%d?pkt_size=1200", port),
	)
	return args
}

func stringsHasAssetPrefix(value string) bool {
	return len(value) > len("/api/assets/") && value[:len("/api/assets/")] == "/api/assets/"
}
