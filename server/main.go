package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	// Initialize chunker
	if err := initChunker(); err != nil {
		slog.Error("failed to initialize chunker", "error", err)
		// Non-fatal, continue without chunking support
	}

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
	case path == "/keypair" && req.Method == http.MethodPost:
		handleGenerateKeypair(w, req)
	case path == "/publish" && req.Method == http.MethodPost:
		handlePublishAnnouncement(w, req)
	case strings.HasPrefix(path, "/chunks/") && req.Method == http.MethodPost:
		geohash := strings.TrimPrefix(path, "/chunks/")
		handleAddChunk(w, req, geohash)
	case strings.HasPrefix(path, "/chunks/") && req.Method == http.MethodDelete:
		geohash := strings.TrimPrefix(path, "/chunks/")
		handleRemoveChunk(w, req, geohash)

	// Source management
	case path == "/sources" && req.Method == http.MethodGet:
		handleGetSources(w, req)
	case path == "/sources" && req.Method == http.MethodPost:
		handleAddSource(w, req)
	case strings.HasPrefix(path, "/sources/") && strings.HasSuffix(path, "/refresh") && req.Method == http.MethodPost:
		id := strings.TrimPrefix(path, "/sources/")
		id = strings.TrimSuffix(id, "/refresh")
		handleRefreshSourceMetadata(w, req, id)
	case strings.HasPrefix(path, "/sources/") && req.Method == http.MethodDelete:
		id := strings.TrimPrefix(path, "/sources/")
		handleDeleteSource(w, req, id)

	// Layer management
	case path == "/layers" && req.Method == http.MethodGet:
		handleGetLayers(w, req)
	case path == "/layers" && req.Method == http.MethodPost:
		handleAddLayer(w, req)
	case strings.HasPrefix(path, "/layers/") && strings.Contains(path, "/chunks/") && req.Method == http.MethodDelete:
		// DELETE /layers/{id}/chunks/{geohash}
		rest := strings.TrimPrefix(path, "/layers/")
		parts := strings.SplitN(rest, "/chunks/", 2)
		handleDeleteLayerChunk(w, req, parts[0], parts[1])
	case strings.HasPrefix(path, "/layers/") && req.Method == http.MethodDelete:
		id := strings.TrimPrefix(path, "/layers/")
		handleDeleteLayer(w, req, id)
	case strings.HasPrefix(path, "/layers/") && strings.HasSuffix(path, "/chunk") && req.Method == http.MethodPost:
		id := strings.TrimPrefix(path, "/layers/")
		id = strings.TrimSuffix(id, "/chunk")
		handleStartLayerChunking(w, req, id)
	case strings.HasPrefix(path, "/layers/") && strings.HasSuffix(path, "/status") && req.Method == http.MethodGet:
		id := strings.TrimPrefix(path, "/layers/")
		id = strings.TrimSuffix(id, "/status")
		handleGetLayerStatus(w, req, id)

	// Downloads
	case path == "/downloads" && req.Method == http.MethodGet:
		handleGetDownloads(w, req)

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
		"name":       config.Name,
		"about":      config.About,
		"picture":    config.Picture,
		"baseURL":    config.BaseURL,
		"relays":     config.Relays,
		"diskQuota":  config.DiskQuota,
		"hasKeypair": config.PrivateKey != "",
	}

	// Include npub if keypair exists
	if config.PrivateKey != "" {
		if npub, err := GetNpub(config.PrivateKey); err == nil {
			publicConfig["npub"] = npub
		}
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

	// Save config to file
	if err := config.Save(""); err != nil {
		slog.Error("failed to save config", "error", err)
	}

	// Publish announcement to relays
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := PublishAnnouncement(ctx); err != nil {
			slog.Error("failed to publish announcement", "error", err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

func handleGenerateKeypair(w http.ResponseWriter, r *http.Request) {
	if config.PrivateKey != "" {
		http.Error(w, "Keypair already exists", http.StatusConflict)
		return
	}

	nsec, npub, err := GenerateKeyPair()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	config.PrivateKey = nsec
	if err := config.Save(""); err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}

	slog.Info("🔑 keypair generated", "npub", npub)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"npub": npub,
	})
}

func handlePublishAnnouncement(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := PublishAnnouncement(ctx); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "published"})
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

	announcement, err := loadAnnouncement()
	if err != nil {
		http.Error(w, "Failed to load announcement", http.StatusInternalServerError)
		return
	}

	chunk, exists := announcement[geohash]
	if !exists {
		http.Error(w, "Chunk not found in announcement", http.StatusNotFound)
		return
	}

	// Delete from blossom store
	deleteChunkFromStore(chunk.File)

	// Remove from announcement
	delete(announcement, geohash)
	if err := saveAnnouncement(announcement); err != nil {
		http.Error(w, "Failed to save announcement", http.StatusInternalServerError)
		return
	}

	// Republish
	go func() {
		pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := PublishAnnouncement(pubCtx); err != nil {
			slog.Error("failed to publish after chunk removal", "error", err)
		}
	}()

	slog.Info("🗑️ chunk removed", "geohash", geohash, "file", chunk.File)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "removed",
		"geohash": geohash,
	})
}

// ============================================================================
// Source Management Handlers
// ============================================================================

func handleGetSources(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(config.Sources)
}

func handleAddSource(w http.ResponseWriter, r *http.Request) {
	var source Source
	if err := json.NewDecoder(r.Body).Decode(&source); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate
	if source.ID == "" {
		http.Error(w, "ID is required", http.StatusBadRequest)
		return
	}
	if source.URL == "" {
		http.Error(w, "URL is required", http.StatusBadRequest)
		return
	}

	source.Status = "fetching_metadata"

	// Check for duplicate ID
	for _, s := range config.Sources {
		if s.ID == source.ID {
			http.Error(w, "Source with this ID already exists", http.StatusConflict)
			return
		}
	}

	config.Sources = append(config.Sources, source)
	if err := config.Save(""); err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}

	slog.Info("📦 source added", "id", source.ID, "url", source.URL)

	// Fetch metadata in background
	go func() {
		if chunker == nil {
			return
		}
		header, err := chunker.FetchPMTilesMetadata(source.URL)
		if err != nil {
			slog.Error("failed to fetch metadata", "source", source.ID, "error", err)
			// Update source with error
			for i := range config.Sources {
				if config.Sources[i].ID == source.ID {
					config.Sources[i].Status = "error"
					config.Sources[i].Error = fmt.Sprintf("Failed to fetch metadata: %v", err)
					break
				}
			}
		} else {
			// Update source with metadata
			for i := range config.Sources {
				if config.Sources[i].ID == source.ID {
					config.Sources[i].TileType = header.TileType
					config.Sources[i].TileCompression = header.TileCompression
					config.Sources[i].MinZoom = header.MinZoom
					config.Sources[i].MaxZoom = header.MaxZoom
					config.Sources[i].Bounds = header.Bounds
					config.Sources[i].Center = header.Center
					config.Sources[i].NumTileEntries = header.NumTileEntries
					config.Sources[i].NumContents = header.NumContents
					config.Sources[i].Clustered = header.Clustered
					config.Sources[i].InternalComp = header.InternalComp
					config.Sources[i].Attribution = header.Attribution
					config.Sources[i].Description = header.Description
					config.Sources[i].VectorLayers = header.VectorLayers
					config.Sources[i].Status = "ready"
					slog.Info("📊 metadata fetched", "source", source.ID, "minZoom", header.MinZoom, "maxZoom", header.MaxZoom, "type", header.TileType)
					break
				}
			}
		}
		config.Save("")
	}()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(source)
}

func handleRefreshSourceMetadata(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	var source *Source
	var sourceIdx int
	for i := range config.Sources {
		if config.Sources[i].ID == id {
			source = &config.Sources[i]
			sourceIdx = i
			break
		}
	}

	if source == nil {
		http.Error(w, "Source not found", http.StatusNotFound)
		return
	}

	config.Sources[sourceIdx].Status = "fetching_metadata"
	config.Save("")

	header, err := chunker.FetchPMTilesMetadata(source.URL)
	if err != nil {
		config.Sources[sourceIdx].Status = "error"
		config.Sources[sourceIdx].Error = fmt.Sprintf("Failed to fetch metadata: %v", err)
		config.Save("")
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	config.Sources[sourceIdx].TileType = header.TileType
	config.Sources[sourceIdx].TileCompression = header.TileCompression
	config.Sources[sourceIdx].MinZoom = header.MinZoom
	config.Sources[sourceIdx].MaxZoom = header.MaxZoom
	config.Sources[sourceIdx].Bounds = header.Bounds
	config.Sources[sourceIdx].Center = header.Center
	config.Sources[sourceIdx].NumTileEntries = header.NumTileEntries
	config.Sources[sourceIdx].NumContents = header.NumContents
	config.Sources[sourceIdx].Clustered = header.Clustered
	config.Sources[sourceIdx].InternalComp = header.InternalComp
	config.Sources[sourceIdx].Attribution = header.Attribution
	config.Sources[sourceIdx].Description = header.Description
	config.Sources[sourceIdx].VectorLayers = header.VectorLayers
	config.Sources[sourceIdx].Status = "ready"
	config.Sources[sourceIdx].Error = ""
	config.Save("")

	slog.Info("📊 metadata refreshed", "source", id, "minZoom", header.MinZoom, "maxZoom", header.MaxZoom)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(config.Sources[sourceIdx])
}

func handleDeleteSource(w http.ResponseWriter, r *http.Request, id string) {
	found := false
	var newSources []Source
	for _, s := range config.Sources {
		if s.ID == id {
			found = true
			continue
		}
		newSources = append(newSources, s)
	}

	if !found {
		http.Error(w, "Source not found", http.StatusNotFound)
		return
	}

	config.Sources = newSources
	if err := config.Save(""); err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}

	slog.Info("🗑️ source deleted", "id", id)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// ============================================================================
// Layer Management Handlers
// ============================================================================

func handleGetLayers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(config.MapLayers)
}

func handleAddLayer(w http.ResponseWriter, r *http.Request) {
	var layer MapLayer
	if err := json.NewDecoder(r.Body).Decode(&layer); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate
	if layer.ID == "" {
		http.Error(w, "ID is required", http.StatusBadRequest)
		return
	}
	if layer.SourceID == "" {
		http.Error(w, "sourceId is required", http.StatusBadRequest)
		return
	}

	// Verify source exists
	sourceExists := false
	for _, s := range config.Sources {
		if s.ID == layer.SourceID {
			sourceExists = true
			break
		}
	}
	if !sourceExists {
		http.Error(w, "Source not found", http.StatusBadRequest)
		return
	}

	// Set defaults
	if layer.MaxZoom == 0 {
		layer.MaxZoom = 14
	}
	if layer.Precision == 0 {
		layer.Precision = 1
	}
	layer.Status = "pending"
	if layer.MaxPrecision <= 0 {
		layer.MaxPrecision = 4
	}

	// Check for duplicate ID
	for _, l := range config.MapLayers {
		if l.ID == layer.ID {
			http.Error(w, "Layer with this ID already exists", http.StatusConflict)
			return
		}
	}

	config.MapLayers = append(config.MapLayers, layer)
	if err := config.Save(""); err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}

	slog.Info("🗺️ layer added", "id", layer.ID, "sourceId", layer.SourceID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(layer)
}

func handleDeleteLayer(w http.ResponseWriter, r *http.Request, id string) {
	var deletedLayer *MapLayer
	var newLayers []MapLayer
	for i := range config.MapLayers {
		if config.MapLayers[i].ID == id {
			deletedLayer = &config.MapLayers[i]
			continue
		}
		newLayers = append(newLayers, config.MapLayers[i])
	}

	if deletedLayer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	// Delete chunk files from store and remove from announcement
	announcement, _ := loadAnnouncement()
	for gh, chunk := range deletedLayer.Chunks {
		deleteChunkFromStore(chunk.File)
		delete(announcement, gh)
	}
	if err := saveAnnouncement(announcement); err != nil {
		slog.Error("failed to save announcement after layer delete", "error", err)
	}

	config.MapLayers = newLayers
	if err := config.Save(""); err != nil {
		http.Error(w, "Failed to save config", http.StatusInternalServerError)
		return
	}

	// Republish announcement
	go func() {
		pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := PublishAnnouncement(pubCtx); err != nil {
			slog.Error("failed to publish after layer delete", "error", err)
		}
	}()

	slog.Info("🗑️ layer deleted", "id", id, "chunksRemoved", len(deletedLayer.Chunks))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func handleDeleteLayerChunk(w http.ResponseWriter, r *http.Request, layerID, geohash string) {
	// Find the layer
	var layerIdx int = -1
	for i := range config.MapLayers {
		if config.MapLayers[i].ID == layerID {
			layerIdx = i
			break
		}
	}
	if layerIdx < 0 {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	chunk, exists := config.MapLayers[layerIdx].Chunks[geohash]
	if !exists {
		http.Error(w, "Chunk not found in layer", http.StatusNotFound)
		return
	}

	// Delete file from store
	deleteChunkFromStore(chunk.File)

	// Remove from layer config
	delete(config.MapLayers[layerIdx].Chunks, geohash)
	config.Save("")

	// Remove from announcement
	announcement, err := loadAnnouncement()
	if err == nil {
		delete(announcement, geohash)
		saveAnnouncement(announcement)
	}

	// Republish
	go func() {
		pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := PublishAnnouncement(pubCtx); err != nil {
			slog.Error("failed to publish after chunk delete", "error", err)
		}
	}()

	slog.Info("🗑️ chunk deleted from layer", "layer", layerID, "geohash", geohash)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func handleStartLayerChunking(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Find the layer
	var layer *MapLayer
	for i := range config.MapLayers {
		if config.MapLayers[i].ID == id {
			layer = &config.MapLayers[i]
			break
		}
	}
	if layer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	// Find the source
	var source *Source
	for i := range config.Sources {
		if config.Sources[i].ID == layer.SourceID {
			source = &config.Sources[i]
			break
		}
	}
	if source == nil {
		http.Error(w, "Source not found for layer", http.StatusNotFound)
		return
	}

	ctx := context.Background()
	if err := chunker.StartChunking(ctx, layer, source); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	slog.Info("🚀 chunking started", "layer", id, "source", source.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "started"})
}

func handleGetLayerStatus(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	job := chunker.GetJob(id)
	if job == nil {
		// Return layer status instead
		for _, l := range config.MapLayers {
			if l.ID == id {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]interface{}{
					"status": l.Status,
					"error":  l.Error,
				})
				return
			}
		}
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(job)
}

func handleGetDownloads(w http.ResponseWriter, r *http.Request) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	downloads, err := chunker.ListDownloads()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(downloads)
}

// ============================================================================
// Store Helpers
// ============================================================================

// deleteChunkFromStore removes a chunk file from the blisk store by parsing its hash from the filename
func deleteChunkFromStore(filename string) {
	hexHash := strings.TrimSuffix(filename, ".pmtiles")
	hash, err := blossom.ParseHash(hexHash)
	if err != nil {
		slog.Error("failed to parse hash for deletion", "filename", filename, "error", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := store.Delete(ctx, hash, "blosmap"); err != nil {
		slog.Error("failed to delete from store", "hash", hexHash, "error", err)
	}
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
