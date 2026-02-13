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

	// Load sources and layers from data directory
	if err := LoadSources(config.DataDir); err != nil {
		slog.Error("failed to load sources", "error", err)
	}
	if err := LoadLayers(config.DataDir); err != nil {
		slog.Error("failed to load layers", "error", err)
	}

	// Migrate legacy data from config file if present
	MigrateFromConfig(config)

	// Initialize chunker
	if err := initChunker(); err != nil {
		slog.Error("failed to initialize chunker", "error", err)
		// Non-fatal, continue without chunking support
	} else {
		chunker.ResumeIncompleteJobs(context.Background())
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
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      10 * time.Minute,
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

	// Publish announcement on startup if we have a key and layers
	if config.PrivateKey != "" && len(layers) > 0 {
		go func() {
			if err := PublishAnnouncement(ctx); err != nil {
				slog.Warn("failed to publish announcement on startup", "error", err)
			}
		}()
	}

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

	// Route /dashboard to embedded frontend
	if req.URL.Path == "/dashboard" {
		http.Redirect(w, req, "/dashboard/", http.StatusMovedPermanently)
		return
	}
	if strings.HasPrefix(req.URL.Path, "/dashboard/") {
		r.handleDashboard(w, req)
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
	case path == "/announcement/preview" && req.Method == http.MethodGet:
		handleAnnouncementPreview(w, req)
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
	case strings.HasPrefix(path, "/sources/") && req.Method == http.MethodPatch:
		id := strings.TrimPrefix(path, "/sources/")
		handleUpdateSource(w, req, id)
	case strings.HasPrefix(path, "/sources/") && req.Method == http.MethodDelete:
		id := strings.TrimPrefix(path, "/sources/")
		handleDeleteSource(w, req, id)

	// Layer management
	case path == "/layers" && req.Method == http.MethodGet:
		handleGetLayers(w, req)
	case path == "/layers" && req.Method == http.MethodPost:
		handleAddLayer(w, req)
	case strings.HasPrefix(path, "/layers/") && strings.Contains(path, "/chunks/") && strings.HasSuffix(path, "/retry") && req.Method == http.MethodPost:
		// POST /layers/{id}/chunks/{geohash}/retry
		rest := strings.TrimPrefix(path, "/layers/")
		parts := strings.SplitN(rest, "/chunks/", 2)
		geohash := strings.TrimSuffix(parts[1], "/retry")
		handleRetryChunk(w, req, parts[0], geohash)
	case strings.HasPrefix(path, "/layers/") && strings.HasSuffix(path, "/retry-errors") && req.Method == http.MethodPost:
		// POST /layers/{id}/retry-errors
		id := strings.TrimPrefix(path, "/layers/")
		id = strings.TrimSuffix(id, "/retry-errors")
		handleRetryErrors(w, req, id)
	case strings.HasPrefix(path, "/layers/") && strings.Contains(path, "/chunks/") && req.Method == http.MethodDelete:
		// DELETE /layers/{id}/chunks/{geohash}
		rest := strings.TrimPrefix(path, "/layers/")
		parts := strings.SplitN(rest, "/chunks/", 2)
		handleDeleteLayerChunk(w, req, parts[0], parts[1])
	case strings.HasPrefix(path, "/layers/") && req.Method == http.MethodPatch:
		id := strings.TrimPrefix(path, "/layers/")
		handleUpdateLayer(w, req, id)
	case strings.HasPrefix(path, "/layers/") && req.Method == http.MethodDelete:
		id := strings.TrimPrefix(path, "/layers/")
		handleDeleteLayer(w, req, id)
	case strings.HasPrefix(path, "/layers/") && strings.HasSuffix(path, "/chunk") && req.Method == http.MethodPost:
		id := strings.TrimPrefix(path, "/layers/")
		id = strings.TrimSuffix(id, "/chunk")
		handleStartLayerChunking(w, req, id)
	case strings.HasPrefix(path, "/layers/") && strings.HasSuffix(path, "/cancel") && req.Method == http.MethodPost:
		id := strings.TrimPrefix(path, "/layers/")
		id = strings.TrimSuffix(id, "/cancel")
		handleCancelChunking(w, req, id)
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

// seekableBlob wraps *os.File to implement both blossom.Blob and io.ReadSeeker,
// enabling HTTP Range request support in blossom.ServeBlob.
type seekableBlob struct {
	file *os.File
	size int64
	typ  string
}

func (b *seekableBlob) Read(p []byte) (int, error)                 { return b.file.Read(p) }
func (b *seekableBlob) Close() error                               { return b.file.Close() }
func (b *seekableBlob) Seek(offset int64, whence int) (int64, error) { return b.file.Seek(offset, whence) }
func (b *seekableBlob) Type() string                               { return b.typ }
func (b *seekableBlob) Size() int64                                { return b.size }

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

	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, blossom.ErrInternal(err.Error())
	}

	// Detect content type from first 512 bytes
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	// Seek back to start after type detection
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return nil, blossom.ErrInternal(err.Error())
	}

	blob := &seekableBlob{file: file, size: info.Size(), typ: contentType}
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
	allChunks := aggregateChunks()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(allChunks)
}

func handleGetStats(w http.ResponseWriter, r *http.Request) {
	allChunks := aggregateChunks()
	chunkCount := len(allChunks)

	var totalSize int64
	for _, chunk := range allChunks {
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

	// Include admin pubkey if configured
	if config.AdminPubkey != "" {
		publicConfig["adminPubkey"] = config.AdminPubkey
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

func handleAnnouncementPreview(w http.ResponseWriter, r *http.Request) {
	announcement := buildLayerAnnouncement()

	preview := map[string]interface{}{
		"kind":    34444,
		"tags":    [][]string{{"d", "blosmap"}, {"name", config.Name}, {"about", config.About}},
		"content": announcement,
	}

	if config.PrivateKey != "" {
		if npub, err := GetNpub(config.PrivateKey); err == nil {
			preview["npub"] = npub
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(preview)
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

	// Find which layer contains this chunk
	var found bool
	for i := range layers {
		if chunk, exists := layers[i].Chunks[geohash]; exists {
			deleteChunkFromStore(chunk.File)
			delete(layers[i].Chunks, geohash)
			found = true
			break
		}
	}

	if !found {
		http.Error(w, "Chunk not found", http.StatusNotFound)
		return
	}

	if err := SaveLayers(config.DataDir); err != nil {
		http.Error(w, "Failed to save layers", http.StatusInternalServerError)
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

	slog.Info("🗑️ chunk removed", "geohash", geohash)

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
	json.NewEncoder(w).Encode(sources)
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
	for _, s := range sources {
		if s.ID == source.ID {
			http.Error(w, "Source with this ID already exists", http.StatusConflict)
			return
		}
	}

	sources = append(sources, source)
	if err := SaveSources(config.DataDir); err != nil {
		http.Error(w, "Failed to save sources", http.StatusInternalServerError)
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
			for i := range sources {
				if sources[i].ID == source.ID {
					sources[i].Status = "error"
					sources[i].Error = fmt.Sprintf("Failed to fetch metadata: %v", err)
					break
				}
			}
		} else {
			for i := range sources {
				if sources[i].ID == source.ID {
					sources[i].TileType = header.TileType
					sources[i].TileCompression = header.TileCompression
					sources[i].MinZoom = header.MinZoom
					sources[i].MaxZoom = header.MaxZoom
					sources[i].Bounds = header.Bounds
					sources[i].Center = header.Center
					sources[i].NumTileEntries = header.NumTileEntries
					sources[i].NumContents = header.NumContents
					sources[i].Clustered = header.Clustered
					sources[i].InternalComp = header.InternalComp
					sources[i].Attribution = header.Attribution
					sources[i].Description = header.Description
					sources[i].VectorLayers = header.VectorLayers
					sources[i].Status = "ready"
					slog.Info("📊 metadata fetched", "source", source.ID, "minZoom", header.MinZoom, "maxZoom", header.MaxZoom, "type", header.TileType)
					break
				}
			}
		}
		SaveSources(config.DataDir)
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
	for i := range sources {
		if sources[i].ID == id {
			source = &sources[i]
			sourceIdx = i
			break
		}
	}

	if source == nil {
		http.Error(w, "Source not found", http.StatusNotFound)
		return
	}

	sources[sourceIdx].Status = "fetching_metadata"
	SaveSources(config.DataDir)

	header, err := chunker.FetchPMTilesMetadata(source.URL)
	if err != nil {
		sources[sourceIdx].Status = "error"
		sources[sourceIdx].Error = fmt.Sprintf("Failed to fetch metadata: %v", err)
		SaveSources(config.DataDir)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(sources[sourceIdx])
		return
	}

	sources[sourceIdx].TileType = header.TileType
	sources[sourceIdx].TileCompression = header.TileCompression
	sources[sourceIdx].MinZoom = header.MinZoom
	sources[sourceIdx].MaxZoom = header.MaxZoom
	sources[sourceIdx].Bounds = header.Bounds
	sources[sourceIdx].Center = header.Center
	sources[sourceIdx].NumTileEntries = header.NumTileEntries
	sources[sourceIdx].NumContents = header.NumContents
	sources[sourceIdx].Clustered = header.Clustered
	sources[sourceIdx].InternalComp = header.InternalComp
	sources[sourceIdx].Attribution = header.Attribution
	sources[sourceIdx].Description = header.Description
	sources[sourceIdx].VectorLayers = header.VectorLayers
	sources[sourceIdx].Status = "ready"
	sources[sourceIdx].Error = ""
	SaveSources(config.DataDir)

	slog.Info("📊 metadata refreshed", "source", id, "minZoom", header.MinZoom, "maxZoom", header.MaxZoom)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sources[sourceIdx])
}

func handleUpdateSource(w http.ResponseWriter, r *http.Request, id string) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	var sourceIdx int = -1
	for i := range sources {
		if sources[i].ID == id {
			sourceIdx = i
			break
		}
	}
	if sourceIdx < 0 {
		http.Error(w, "Source not found", http.StatusNotFound)
		return
	}

	urlChanged := false
	if url, ok := updates["url"].(string); ok && url != "" {
		if url != sources[sourceIdx].URL {
			sources[sourceIdx].URL = url
			urlChanged = true
		}
	}
	if title, ok := updates["title"].(string); ok {
		sources[sourceIdx].Title = title
	}

	if err := SaveSources(config.DataDir); err != nil {
		http.Error(w, "Failed to save sources", http.StatusInternalServerError)
		return
	}

	// If URL changed, re-fetch metadata in background
	if urlChanged && chunker != nil {
		sources[sourceIdx].Status = "fetching_metadata"
		sources[sourceIdx].Error = ""
		SaveSources(config.DataDir)

		go func() {
			header, err := chunker.FetchPMTilesMetadata(sources[sourceIdx].URL)
			if err != nil {
				slog.Error("failed to fetch metadata after URL update", "source", id, "error", err)
				for i := range sources {
					if sources[i].ID == id {
						sources[i].Status = "error"
						sources[i].Error = fmt.Sprintf("Failed to fetch metadata: %v", err)
						break
					}
				}
			} else {
				for i := range sources {
					if sources[i].ID == id {
						sources[i].TileType = header.TileType
						sources[i].TileCompression = header.TileCompression
						sources[i].MinZoom = header.MinZoom
						sources[i].MaxZoom = header.MaxZoom
						sources[i].Bounds = header.Bounds
						sources[i].Center = header.Center
						sources[i].NumTileEntries = header.NumTileEntries
						sources[i].NumContents = header.NumContents
						sources[i].Clustered = header.Clustered
						sources[i].InternalComp = header.InternalComp
						sources[i].Attribution = header.Attribution
						sources[i].Description = header.Description
						sources[i].VectorLayers = header.VectorLayers
						sources[i].Status = "ready"
						sources[i].Error = ""
						slog.Info("metadata refreshed after URL update", "source", id)
						break
					}
				}
			}
			SaveSources(config.DataDir)
		}()
	}

	slog.Info("source updated", "id", id, "urlChanged", urlChanged)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sources[sourceIdx])
}

func handleDeleteSource(w http.ResponseWriter, r *http.Request, id string) {
	found := false
	var newSources []Source
	for _, s := range sources {
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

	sources = newSources
	if err := SaveSources(config.DataDir); err != nil {
		http.Error(w, "Failed to save sources", http.StatusInternalServerError)
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
	json.NewEncoder(w).Encode(layers)
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

	// Check for duplicate ID
	for _, l := range layers {
		if l.ID == layer.ID {
			http.Error(w, "Layer with this ID already exists", http.StatusConflict)
			return
		}
	}

	if layer.File != "" {
		// File layer — verify blob exists in store and extract metadata
		hash, err := blossom.ParseHash(layer.File)
		if err != nil {
			http.Error(w, "Invalid file hash", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		meta, err := store.Info(ctx, hash)
		if err != nil {
			http.Error(w, "Blob not found — upload the file first via PUT /upload", http.StatusNotFound)
			return
		}
		layer.FileSize = meta.Size
		layer.Status = "ready"

		// Extract PMTiles metadata if chunker is available
		if chunker != nil {
			blobPath := store.BlobPath(hash)
			header, err := chunker.FetchPMTilesMetadata(blobPath)
			if err != nil {
				slog.Warn("failed to extract PMTiles metadata", "error", err)
			} else {
				layer.TileType = header.TileType
				layer.MinZoom = header.MinZoom
				layer.MaxZoom = header.MaxZoom
			}
		}

		slog.Info("🗺️ file layer added", "id", layer.ID, "hash", layer.File, "size", meta.Size)
	} else {
		// Chunked layer — requires a source
		if layer.SourceID == "" {
			http.Error(w, "sourceId is required for chunked layers", http.StatusBadRequest)
			return
		}

		// Verify source exists
		sourceExists := false
		for _, s := range sources {
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
			layer.MaxPrecision = 2
		}

		slog.Info("🗺️ layer added", "id", layer.ID, "sourceId", layer.SourceID)
	}

	layers = append(layers, layer)
	if err := SaveLayers(config.DataDir); err != nil {
		http.Error(w, "Failed to save layers", http.StatusInternalServerError)
		return
	}

	// Republish announcement for file layers
	if layer.File != "" {
		go func() {
			pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := PublishAnnouncement(pubCtx); err != nil {
				slog.Error("failed to publish after file layer add", "error", err)
			}
		}()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(layer)
}

func handleUpdateLayer(w http.ResponseWriter, r *http.Request, id string) {
	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	var layerIdx int = -1
	for i := range layers {
		if layers[i].ID == id {
			layerIdx = i
			break
		}
	}
	if layerIdx < 0 {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	if title, ok := updates["title"].(string); ok {
		layers[layerIdx].Title = title
	}

	if err := SaveLayers(config.DataDir); err != nil {
		http.Error(w, "Failed to save layers", http.StatusInternalServerError)
		return
	}

	// Republish announcement with updated title
	go func() {
		pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		PublishAnnouncement(pubCtx)
	}()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(layers[layerIdx])
}

func handleDeleteLayer(w http.ResponseWriter, r *http.Request, id string) {
	var deletedLayer *MapLayer
	var newLayers []MapLayer
	for i := range layers {
		if layers[i].ID == id {
			deletedLayer = &layers[i]
			continue
		}
		newLayers = append(newLayers, layers[i])
	}

	if deletedLayer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	// Delete associated blobs from store
	if deletedLayer.File != "" {
		// File layer — delete the uploaded blob
		hash, err := blossom.ParseHash(deletedLayer.File)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := store.Delete(ctx, hash, "blosmap"); err != nil {
				slog.Error("failed to delete file layer blob", "hash", deletedLayer.File, "error", err)
			}
		}
	}

	// Delete chunk files from store
	for _, chunk := range deletedLayer.Chunks {
		deleteChunkFromStore(chunk.File)
	}

	// Clear any stale chunking job
	if chunker != nil {
		chunker.ClearJob(id)
	}

	layers = newLayers
	if err := SaveLayers(config.DataDir); err != nil {
		http.Error(w, "Failed to save layers", http.StatusInternalServerError)
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
	for i := range layers {
		if layers[i].ID == layerID {
			layerIdx = i
			break
		}
	}
	if layerIdx < 0 {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	chunk, exists := layers[layerIdx].Chunks[geohash]
	if !exists {
		http.Error(w, "Chunk not found in layer", http.StatusNotFound)
		return
	}

	// Delete file from store
	deleteChunkFromStore(chunk.File)

	// Remove from layer
	delete(layers[layerIdx].Chunks, geohash)
	SaveLayers(config.DataDir)

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

func handleRetryChunk(w http.ResponseWriter, r *http.Request, layerID, geohash string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	var layer *MapLayer
	for i := range layers {
		if layers[i].ID == layerID {
			layer = &layers[i]
			break
		}
	}
	if layer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	var source *Source
	for i := range sources {
		if sources[i].ID == layer.SourceID {
			source = &sources[i]
			break
		}
	}
	if source == nil {
		http.Error(w, "Source not found for layer", http.StatusNotFound)
		return
	}

	ctx := context.Background()
	if err := chunker.StartRetry(ctx, layer, source, []string{geohash}); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	slog.Info("🔄 chunk retry started", "layer", layerID, "geohash", geohash)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "retrying"})
}

func handleRetryErrors(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	var layer *MapLayer
	for i := range layers {
		if layers[i].ID == id {
			layer = &layers[i]
			break
		}
	}
	if layer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	missing := chunker.FindMissingChunks(layer)
	if len(missing) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "nothing_to_retry",
			"message": "No missing or errored chunks found",
		})
		return
	}

	var source *Source
	for i := range sources {
		if sources[i].ID == layer.SourceID {
			source = &sources[i]
			break
		}
	}
	if source == nil {
		http.Error(w, "Source not found for layer", http.StatusNotFound)
		return
	}

	ctx := context.Background()
	if err := chunker.StartRetry(ctx, layer, source, missing); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	slog.Info("🔄 retry errors started", "layer", id, "count", len(missing))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "retrying",
		"count":  len(missing),
	})
}

func handleStartLayerChunking(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	// Find the layer
	var layer *MapLayer
	for i := range layers {
		if layers[i].ID == id {
			layer = &layers[i]
			break
		}
	}
	if layer == nil {
		http.Error(w, "Layer not found", http.StatusNotFound)
		return
	}

	// Find the source
	var source *Source
	for i := range sources {
		if sources[i].ID == layer.SourceID {
			source = &sources[i]
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

func handleCancelChunking(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}
	if chunker.CancelJob(id) {
		slog.Info("chunking cancelled", "layer", id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "cancelled"})
	} else {
		http.Error(w, "No active chunking job for this layer", http.StatusNotFound)
	}
}

func handleGetLayerStatus(w http.ResponseWriter, r *http.Request, id string) {
	if chunker == nil {
		http.Error(w, "Chunker not initialized", http.StatusServiceUnavailable)
		return
	}

	job := chunker.GetJob(id)
	if job == nil {
		// Return layer status instead
		for _, l := range layers {
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
// Helpers
// ============================================================================

// aggregateChunks collects all chunks from all layers into a flat map
func aggregateChunks() map[string]ChunkInfo {
	all := make(map[string]ChunkInfo)
	for _, l := range layers {
		for gh, chunk := range l.Chunks {
			all[gh] = chunk
		}
	}
	return all
}

// buildLayerAnnouncement builds a LayerAnnouncement from the current layers.
// Includes any layer that has data (chunks or file), regardless of status,
// so partial progress during chunking is visible in the announcement.
func buildLayerAnnouncement() LayerAnnouncement {
	var announceLayers []Layer
	for _, ml := range layers {
		if ml.File == "" && len(ml.Chunks) == 0 {
			continue
		}
		layer := Layer{
			ID:             ml.ID,
			Title:          ml.Title,
			BlossomServer:  config.BaseURL,
			DefaultEnabled: true,
			DefaultOpacity: 1.0,
		}
		if ml.File != "" {
			layer.File = ml.File + ".pmtiles"
			layer.Kind = "file"
			layer.PMTilesType = ml.TileType
		} else {
			layer.Kind = "chunked-vector"
			layer.Announcement = ml.Chunks
		}
		announceLayers = append(announceLayers, layer)
	}
	return LayerAnnouncement{Layers: announceLayers}
}
