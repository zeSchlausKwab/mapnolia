package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// LayerAnnouncement is the content of a kind 34444 event
type LayerAnnouncement struct {
	Layers []Layer `json:"layers"`
}

// Layer represents a map layer in the announcement
type Layer struct {
	ID            string                `json:"id"`
	Title         string                `json:"title"`
	Kind          string                `json:"kind"`
	BlossomServer string                `json:"blossomServer"`
	Announcement  map[string]ChunkInfo  `json:"announcement,omitempty"`
	File          string                `json:"file,omitempty"`
	PMTilesType   string                `json:"pmtilesType,omitempty"`
	DefaultEnabled bool                 `json:"defaultEnabled"`
	DefaultOpacity float64              `json:"defaultOpacity"`
}

// PublishAnnouncement publishes a kind 34444 event to configured relays
func PublishAnnouncement(ctx context.Context) error {
	if config.PrivateKey == "" {
		slog.Warn("no private key configured, skipping announcement")
		return nil
	}

	// Parse private key
	sk, err := parsePrivateKey(config.PrivateKey)
	if err != nil {
		return err
	}

	pubkey, err := nostr.GetPublicKey(sk)
	if err != nil {
		return fmt.Errorf("failed to derive pubkey: %w", err)
	}

	// Load current chunks
	chunks, err := loadAnnouncement()
	if err != nil {
		return fmt.Errorf("failed to load chunks: %w", err)
	}

	// Build announcement content
	announcement := LayerAnnouncement{
		Layers: []Layer{
			{
				ID:             "basemap",
				Title:          "OpenStreetMap Basemap",
				Kind:           "chunked-vector",
				BlossomServer:  config.BaseURL,
				Announcement:   chunks,
				DefaultEnabled: true,
				DefaultOpacity: 1.0,
			},
		},
	}

	contentJSON, err := json.Marshal(announcement)
	if err != nil {
		return fmt.Errorf("failed to marshal content: %w", err)
	}

	// Build event
	event := nostr.Event{
		Kind:      34444,
		PubKey:    pubkey,
		CreatedAt: nostr.Timestamp(time.Now().Unix()),
		Tags: nostr.Tags{
			{"d", "blosmap"},
			{"name", config.Name},
			{"about", config.About},
		},
		Content: string(contentJSON),
	}

	// Add picture tag if set
	if config.Picture != "" {
		event.Tags = append(event.Tags, nostr.Tag{"picture", config.Picture})
	}

	// Add relay tags
	for _, relay := range config.Relays {
		event.Tags = append(event.Tags, nostr.Tag{"r", relay})
	}

	// Sign event
	if err := event.Sign(sk); err != nil {
		return fmt.Errorf("failed to sign event: %w", err)
	}

	slog.Info("📢 publishing announcement",
		"id", event.ID,
		"pubkey", pubkey,
		"relays", len(config.Relays),
	)

	// Publish to all relays concurrently and wait for completion
	var wg sync.WaitGroup
	for _, relayURL := range config.Relays {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()

			// Use independent context so parent cancellation doesn't affect us
			publishCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			relay, err := nostr.RelayConnect(publishCtx, url)
			if err != nil {
				slog.Error("failed to connect to relay", "url", url, "error", err)
				return
			}
			defer relay.Close()

			if err := relay.Publish(publishCtx, event); err != nil {
				slog.Error("failed to publish to relay", "url", url, "error", err)
				return
			}

			slog.Info("✅ published to relay", "url", url, "id", event.ID[:8])
		}(relayURL)
	}

	wg.Wait()
	return nil
}

// GenerateKeyPair generates a new Nostr keypair
func GenerateKeyPair() (string, string, error) {
	sk := nostr.GeneratePrivateKey()
	pubkey, err := nostr.GetPublicKey(sk)
	if err != nil {
		return "", "", err
	}
	nsec, _ := nip19.EncodePrivateKey(sk)
	npub, _ := nip19.EncodePublicKey(pubkey)
	return nsec, npub, nil
}

// GetNpub returns the npub for a given private key (hex or nsec)
func GetNpub(privateKey string) (string, error) {
	sk, err := parsePrivateKey(privateKey)
	if err != nil {
		return "", err
	}

	pubkey, err := nostr.GetPublicKey(sk)
	if err != nil {
		return "", err
	}

	npub, _ := nip19.EncodePublicKey(pubkey)
	return npub, nil
}

// parsePrivateKey converts an nsec or hex private key to hex format
func parsePrivateKey(privateKey string) (string, error) {
	if len(privateKey) == 64 {
		return privateKey, nil
	}
	if len(privateKey) > 4 && privateKey[:4] == "nsec" {
		_, decoded, err := nip19.Decode(privateKey)
		if err != nil {
			return "", fmt.Errorf("invalid nsec: %w", err)
		}
		return decoded.(string), nil
	}
	return "", fmt.Errorf("invalid private key format")
}
