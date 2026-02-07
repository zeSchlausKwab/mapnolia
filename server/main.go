package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/pippellia-btc/blisk"
	"github.com/pippellia-btc/blossom"
	"github.com/pippellia-btc/blossy"
)

var (
	store  *blisk.Store
	config *Config
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
	defer cancel()

	// Load config
	var err error
	config, err = LoadConfig()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Initialize storage
	store, err = blisk.New(config.DataDir)
	if err != nil {
		slog.Error("failed to initialize storage", "error", err)
		os.Exit(1)
	}
	defer store.Close()

	// Create blossy server
	blossomServer, err := blossy.NewServer(
		blossy.WithBaseURL(config.BaseURL),
		blossy.WithRangeSupport(),
	)
	if err != nil {
		slog.Error("failed to create blossom server", "error", err)
		os.Exit(1)
	}

	// Configure storage hooks
	blossomServer.On.Download = LoadBlob
	blossomServer.On.Check = LoadMeta
	blossomServer.On.Upload = SaveBlob
	blossomServer.On.Delete = DeleteBlob

	// Create combined router
	router := NewRouter(blossomServer)

	// Start server
	server := &http.Server{
		Addr:         config.Address(),
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		slog.Info("🗺️  blosmap server starting",
			"address", config.Address(),
			"dataDir", config.DataDir,
			"baseURL", config.BaseURL,
		)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "error", err)
			cancel()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down server...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
}

// Router wraps blossy and adds custom API routes
type Router struct {
	blossom *blossy.Server
}

func NewRouter(blossom *blossy.Server) *Router {
	return &Router{blossom: blossom}
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Set CORS for all requests
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, *")

	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Route /api/* to our handlers
	if strings.HasPrefix(req.URL.Path, "/api/") {
		r.handleAPI(w, req)
		return
	}

	// Route everything else to blossy
	r.blossom.ServeHTTP(w, req)
}

func (r *Router) handleAPI(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/api")

	switch {
	case path == "/info" && req.Method == http.MethodGet:
		handleGetInfo(w, req)
	case path == "/chunks" && req.Method == http.MethodGet:
		handleGetChunks(w, req)
	case path == "/stats" && req.Method == http.MethodGet:
		handleGetStats(w, req)
	case path == "/config" && req.Method == http.MethodGet:
		handleGetConfig(w, req)
	case path == "/config" && req.Method == http.MethodPatch:
		handleUpdateConfig(w, req)
	case strings.HasPrefix(path, "/chunks/") && req.Method == http.MethodPost:
		geohash := strings.TrimPrefix(path, "/chunks/")
		handleAddChunk(w, req, geohash)
	case strings.HasPrefix(path, "/chunks/") && req.Method == http.MethodDelete:
		geohash := strings.TrimPrefix(path, "/chunks/")
		handleRemoveChunk(w, req, geohash)
	default:
		http.Error(w, "Not found", http.StatusNotFound)
	}
}

// ============================================================================
// Blossom Storage Hooks
// ============================================================================

func LoadBlob(r blossy.Request, hash blossom.Hash, ext string) (blossy.BlobDelivery, *blossom.Error) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	file, err := store.Load(ctx, hash)
	if errors.Is(err, blisk.ErrNotFound) {
		return nil, blossom.ErrNotFound("Blob not found")
	}
	if err != nil {
		return nil, blossom.ErrInternal(err.Error())
	}

	blob, err := blossom.BlobFromFile(file)
	if err != nil {
		return nil, blossom.ErrInternal(err.Error())
	}
	return blossy.Serve(blob), nil
}

func LoadMeta(r blossy.Request, hash blossom.Hash, ext string) (blossy.MetaDelivery, *blossom.Error) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	meta, err := store.Info(ctx, hash)
	if errors.Is(err, blisk.ErrNotFound) {
		return nil, blossom.ErrNotFound("Blob not found")
	}
	if err != nil {
		return nil, blossom.ErrInternal(err.Error())
	}

	return blossy.Found(meta.Type, meta.Size), nil
}

func SaveBlob(r blossy.Request, hints blossy.UploadHints, data io.Reader) (blossom.BlobDescriptor, *blossom.Error) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	meta, err := store.Save(ctx, data, r.Pubkey())
	if err != nil {
		return blossom.BlobDescriptor{}, blossom.ErrInternal(err.Error())
	}

	slog.Info("📥 blob uploaded", "hash", meta.Hash.Hex(), "size", meta.Size, "pubkey", r.Pubkey())

	return blossom.BlobDescriptor{
		Hash:     meta.Hash,
		Size:     meta.Size,
		Type:     meta.Type,
		Uploaded: meta.CreatedAt,
	}, nil
}

func DeleteBlob(r blossy.Request, hash blossom.Hash) *blossom.Error {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	err := store.Delete(ctx, hash, r.Pubkey())
	if errors.Is(err, blisk.ErrNotFound) {
		return blossom.ErrNotFound("Blob not found")
	}
	if err != nil {
		return blossom.ErrInternal(err.Error())
	}

	slog.Info("🗑️ blob deleted", "hash", hash.Hex(), "pubkey", r.Pubkey())
	return nil
}

// ============================================================================
// API Handlers
// ============================================================================

func handleGetInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"name":     config.Name,
		"about":    config.About,
		"picture":  config.Picture,
		"baseURL":  config.BaseURL,
		"version":  "0.1.0",
		"software": "blosmap",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

func handleGetChunks(w http.ResponseWriter, r *http.Request) {
	announcement, err := loadAnnouncement()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(announcement)
}

func handleGetStats(w http.ResponseWriter, r *http.Request) {
	announcement, _ := loadAnnouncement()
	chunkCount := len(announcement)

	// Get disk usage from blisk
	// For now, estimate from chunks
	var totalSize int64
	for _, chunk := range announcement {
		totalSize += chunk.Size
	}

	stats := map[string]interface{}{
		"chunkCount": chunkCount,
		"diskUsage":  totalSize,
		"diskQuota":  config.DiskQuota,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

func handleGetConfig(w http.ResponseWriter, r *http.Request) {
	// Return public config (no private key)
	publicConfig := map[string]interface{}{
		"name":      config.Name,
		"about":     config.About,
		"picture":   config.Picture,
		"relays":    config.Relays,
		"maxZoom":   config.MaxZoom,
		"diskQuota": config.DiskQuota,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(publicConfig)
}

func handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Update allowed fields
	if name, ok := updates["name"].(string); ok {
		config.Name = name
	}
	if about, ok := updates["about"].(string); ok {
		config.About = about
	}
	if picture, ok := updates["picture"].(string); ok {
		config.Picture = picture
	}

	// TODO: Save config and republish announcement

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

func handleAddChunk(w http.ResponseWriter, r *http.Request, geohash string) {
	slog.Info("📍 chunk requested", "geohash", geohash)

	// TODO: Trigger PMTiles extraction

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "queued",
		"geohash": geohash,
	})
}

func handleRemoveChunk(w http.ResponseWriter, r *http.Request, geohash string) {
	slog.Info("🗑️ chunk removal requested", "geohash", geohash)

	// TODO: Remove chunk and update announcement

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "removed",
		"geohash": geohash,
	})
}

// ============================================================================
// Announcement Management
// ============================================================================

type ChunkInfo struct {
	BBox    [4]float64 `json:"bbox"`
	File    string     `json:"file"`
	MaxZoom int        `json:"maxZoom"`
	Size    int64      `json:"size,omitempty"`
}

func loadAnnouncement() (map[string]ChunkInfo, error) {
	path := filepath.Join(config.DataDir, "announcement.json")

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return make(map[string]ChunkInfo), nil
	}
	if err != nil {
		return nil, err
	}

	var announcement map[string]ChunkInfo
	if err := json.Unmarshal(data, &announcement); err != nil {
		return nil, err
	}

	return announcement, nil
}

func saveAnnouncement(announcement map[string]ChunkInfo) error {
	path := filepath.Join(config.DataDir, "announcement.json")

	data, err := json.MarshalIndent(announcement, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}
