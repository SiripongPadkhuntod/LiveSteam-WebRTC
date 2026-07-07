package main

import (
	"testing"

	"github.com/pion/rtp"
)

func TestRewriteRTPKeepsContinuityAcrossSources(t *testing.T) {
	state := rtpContinuity{}
	first := rewriteRTP(&rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 90_000}}, "camera-a", &state, 3_000)
	second := rewriteRTP(&rtp.Packet{Header: rtp.Header{SequenceNumber: 11, Timestamp: 93_000}}, "camera-a", &state, 3_000)
	switched := rewriteRTP(&rtp.Packet{Header: rtp.Header{SequenceNumber: 50, Timestamp: 7_000}}, "camera-b", &state, 3_000)

	if second.SequenceNumber != first.SequenceNumber+1 || switched.SequenceNumber != second.SequenceNumber+1 {
		t.Fatalf("sequence is not continuous: %d, %d, %d", first.SequenceNumber, second.SequenceNumber, switched.SequenceNumber)
	}
	if second.Timestamp != first.Timestamp+3_000 || switched.Timestamp != second.Timestamp+3_000 {
		t.Fatalf("timestamp is not continuous: %d, %d, %d", first.Timestamp, second.Timestamp, switched.Timestamp)
	}
}

func TestH264PacketContainsIDR(t *testing.T) {
	tests := []struct {
		name    string
		payload []byte
		want    bool
	}{
		{name: "single IDR", payload: []byte{0x65}, want: true},
		{name: "single non-IDR", payload: []byte{0x61}, want: false},
		{name: "FU-A IDR start", payload: []byte{0x7c, 0x85}, want: true},
		{name: "FU-A IDR continuation", payload: []byte{0x7c, 0x05}, want: false},
		{name: "STAP-A with IDR", payload: []byte{0x78, 0x00, 0x01, 0x65}, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := h264PacketContainsIDR(test.payload); got != test.want {
				t.Fatalf("h264PacketContainsIDR() = %v, want %v", got, test.want)
			}
		})
	}
}
