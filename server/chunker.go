package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Chunker handles PMTiles extraction and chunking
type Chunker struct {
	mu         sync.Mutex
	pmtilesBin string
	outputDir  string
	jobs       map[string]*ChunkJob
}

// ChunkResult tracks a single completed chunk
type ChunkResult struct {
	Geohash string `json:"geohash"`
	File    string `json:"file"`
	Size    int64  `json:"size"`
	Status  string `json:"status"` // done, error, skipped
	Error   string `json:"error,omitempty"`
}

// ChunkProgress tracks the download progress of the currently extracting chunk
type ChunkProgress struct {
	Geohash   string `json:"geohash"`
	Percent   int    `json:"percent"`
	BytesInfo string `json:"bytesInfo,omitempty"` // e.g. "(64 MB/152 MB, 4.2 MB/s)"
}

// ChunkJob tracks a chunking operation
type ChunkJob struct {
	SourceID     string         `json:"sourceId"`
	Status       string         `json:"status"` // pending, chunking, ready, error
	Progress     float64        `json:"progress"`
	Error        string         `json:"error,omitempty"`
	TotalChunks  int            `json:"totalChunks"`
	DoneChunks   int            `json:"doneChunks"`
	CurrentTask  string         `json:"currentTask,omitempty"`
	CurrentChunk *ChunkProgress `json:"currentChunk,omitempty"`
	Chunks       []ChunkResult  `json:"chunks,omitempty"`
	Subdivisions int            `json:"subdivisions"` // count of subdivision operations performed
	cancel       context.CancelFunc
}

// PMTilesHeader represents metadata from a PMTiles file
type PMTilesHeader struct {
	TileCompression string     `json:"tile_compression"`
	TileType        string     `json:"tile_type"`
	MinZoom         int        `json:"minzoom"`
	MaxZoom         int        `json:"maxzoom"`
	Bounds          [4]float64 `json:"bounds"`
	Center          [3]float64 `json:"center"`

	// Extended (from pmtiles show)
	NumTileEntries int    `json:"-"`
	NumContents    int    `json:"-"`
	Clustered      bool   `json:"-"`
	InternalComp   string `json:"-"`

	// From metadata JSON
	Attribution  string   `json:"-"`
	Description  string   `json:"-"`
	VectorLayers []string `json:"-"`
}

// FetchPMTilesMetadata fetches metadata from a PMTiles file using the CLI
func (c *Chunker) FetchPMTilesMetadata(url string) (*PMTilesHeader, error) {
	if c.pmtilesBin == "" {
		return nil, fmt.Errorf("pmtiles binary not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Get header JSON
	cmd := exec.CommandContext(ctx, c.pmtilesBin, "show", "--header-json", url)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to fetch metadata: %w", err)
	}

	var header PMTilesHeader
	if err := json.Unmarshal(output, &header); err != nil {
		return nil, fmt.Errorf("failed to parse metadata: %w", err)
	}

	// Get extended info from plain `pmtiles show`
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel2()

	cmd2 := exec.CommandContext(ctx2, c.pmtilesBin, "show", url)
	output2, err := cmd2.Output()
	if err == nil {
		lines := strings.Split(string(output2), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "tile entries:") || strings.HasPrefix(line, "addressed tiles:") {
				var val int
				fmt.Sscanf(strings.TrimSpace(line[strings.Index(line, ":")+1:]), "%d", &val)
				if strings.HasPrefix(line, "tile entries:") {
					header.NumTileEntries = val
				}
			}
			if strings.HasPrefix(line, "tile contents:") {
				fmt.Sscanf(strings.TrimSpace(line[strings.Index(line, ":")+1:]), "%d", &header.NumContents)
			}
			if strings.Contains(line, "clustered") {
				header.Clustered = strings.Contains(line, "true") || strings.Contains(line, "yes")
			}
			if strings.HasPrefix(line, "internal compression:") {
				header.InternalComp = strings.TrimSpace(line[strings.Index(line, ":")+1:])
			}
		}
	}

	// Get metadata JSON
	ctx3, cancel3 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel3()

	cmd3 := exec.CommandContext(ctx3, c.pmtilesBin, "show", "--metadata", url)
	output3, err := cmd3.Output()
	if err == nil {
		var meta map[string]interface{}
		if json.Unmarshal(output3, &meta) == nil {
			if attr, ok := meta["attribution"].(string); ok {
				header.Attribution = attr
			}
			if desc, ok := meta["description"].(string); ok {
				header.Description = desc
			}
			if vl, ok := meta["vector_layers"].([]interface{}); ok {
				for _, v := range vl {
					if layer, ok := v.(map[string]interface{}); ok {
						if id, ok := layer["id"].(string); ok {
							header.VectorLayers = append(header.VectorLayers, id)
						}
					}
				}
			}
		}
	}

	return &header, nil
}

// DownloadedFile represents a downloaded PMTiles file
type DownloadedFile struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	IsRemote  bool   `json:"isRemote"`
	SourceURL string `json:"sourceUrl,omitempty"`
}

var chunker *Chunker

func initChunker() error {
	binPath, err := findPmtilesBinary()
	if err != nil {
		slog.Warn("pmtiles binary not found", "error", err)
		binPath = "" // Will fail gracefully when trying to chunk
	} else {
		slog.Info("found pmtiles binary", "path", binPath)
	}

	chunker = &Chunker{
		pmtilesBin: binPath,
		outputDir:  filepath.Join(config.DataDir, "chunks"),
		jobs:       make(map[string]*ChunkJob),
	}

	if err := os.MkdirAll(chunker.outputDir, 0755); err != nil {
		return fmt.Errorf("failed to create chunks directory: %w", err)
	}

	return nil
}

func findPmtilesBinary() (string, error) {
	// Check common locations
	candidates := []string{
		"pmtiles",                    // In PATH
		"../bin/pmtiles",             // Project bin directory
		"../bin/pmtiles-mac-silicon", // Mac Silicon specific
		"../bin/pmtiles-linux-amd64", // Linux specific
	}

	// Add platform-specific binary
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			candidates = append([]string{"../bin/pmtiles-mac-silicon"}, candidates...)
		}
	case "linux":
		candidates = append([]string{"../bin/pmtiles-linux-amd64"}, candidates...)
	}

	for _, c := range candidates {
		// Try to resolve path
		path := c
		if !filepath.IsAbs(path) && !strings.HasPrefix(path, "/") {
			// Make relative to server directory
			if abs, err := filepath.Abs(path); err == nil {
				path = abs
			}
		}

		if _, err := os.Stat(path); err == nil {
			// Verify it's executable
			if err := exec.Command(path, "--version").Run(); err == nil {
				return path, nil
			}
		}

		// Try PATH lookup
		if found, err := exec.LookPath(c); err == nil {
			return found, nil
		}
	}

	return "", fmt.Errorf("pmtiles binary not found in any expected location")
}

// ResumeIncompleteJobs restarts chunking for layers interrupted by a server restart
func (c *Chunker) ResumeIncompleteJobs(ctx context.Context) {
	for i := range layers {
		if layers[i].Status != "chunking" {
			continue
		}

		layer := &layers[i]
		var source *Source
		for j := range sources {
			if sources[j].ID == layer.SourceID {
				source = &sources[j]
				break
			}
		}
		if source == nil {
			slog.Error("cannot resume chunking: source not found", "layer", layer.ID, "sourceId", layer.SourceID)
			layers[i].Status = "error"
			layers[i].Error = "source not found for resume"
			SaveLayers(config.DataDir)
			continue
		}

		slog.Info("resuming interrupted chunking", "layer", layer.ID, "existingChunks", len(layer.Chunks))
		if err := c.StartChunking(ctx, layer, source); err != nil {
			slog.Error("failed to resume chunking", "layer", layer.ID, "error", err)
		}
	}
}

// StartChunking begins chunking a layer
func (c *Chunker) StartChunking(ctx context.Context, layer *MapLayer, source *Source) error {
	c.mu.Lock()
	if existing, exists := c.jobs[layer.ID]; exists && existing.Status == "chunking" {
		c.mu.Unlock()
		return fmt.Errorf("chunking already in progress for layer %s", layer.ID)
	}

	jobCtx, jobCancel := context.WithCancel(context.Background())
	job := &ChunkJob{
		SourceID: layer.ID,
		Status:   "chunking",
		cancel:   jobCancel,
	}
	c.jobs[layer.ID] = job
	c.mu.Unlock()

	// Update layer status immediately so frontend sees "chunking"
	for i := range layers {
		if layers[i].ID == layer.ID {
			layers[i].Status = "chunking"
			break
		}
	}
	SaveLayers(config.DataDir)

	go c.runChunking(jobCtx, layer, source, job)
	return nil
}

func (c *Chunker) runChunking(ctx context.Context, layer *MapLayer, source *Source, job *ChunkJob) {
	defer func() {
		// Update layer status
		for i := range layers {
			if layers[i].ID == layer.ID {
				layers[i].Status = job.Status
				layers[i].Error = job.Error
				break
			}
		}
		SaveLayers(config.DataDir)
	}()

	// Resolve input — for remote URLs, use directly (pmtiles extract supports HTTP Range requests)
	inputPath := source.URL
	if !strings.HasPrefix(inputPath, "http://") && !strings.HasPrefix(inputPath, "https://") {
		if !filepath.IsAbs(inputPath) {
			inputPath = filepath.Join("..", inputPath)
		}
		if _, err := os.Stat(inputPath); err != nil {
			job.Status = "error"
			job.Error = fmt.Sprintf("local file not found: %s", source.URL)
			slog.Error("failed to resolve input", "layer", layer.ID, "source", source.ID, "error", err)
			return
		}
	}

	// Determine max precision for subdivision
	maxPrecision := layer.MaxPrecision
	if maxPrecision <= 0 || maxPrecision > 4 {
		maxPrecision = 4
	}

	// Generate geohashes for the starting precision
	geohashes := generateGeohashes(layer.Precision)
	job.TotalChunks = len(geohashes)
	job.Status = "chunking"

	slog.Info("starting chunking",
		"layer", layer.ID,
		"source", source.ID,
		"precision", layer.Precision,
		"chunks", len(geohashes),
		"maxChunkSize", layer.MaxChunkSize,
		"maxPrecision", maxPrecision,
		"minZoom", layer.MinZoom,
		"maxZoom", layer.MaxZoom,
	)

	for _, gh := range geohashes {
		select {
		case <-ctx.Done():
			job.Status = "pending"
			job.Error = ""
			slog.Info("chunking cancelled, progress preserved", "layer", layer.ID, "done", job.DoneChunks)
			return
		default:
		}

		// Skip geohashes already completed (supports resume after restart)
		if isGeohashComplete(layer, gh) {
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			slog.Info("skipping completed geohash", "geohash", gh)
			continue
		}

		bbox := geohashToBBox(gh)
		ghLabel := gh
		if ghLabel == "" {
			ghLabel = "world"
		}
		outputPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", ghLabel))

		job.CurrentTask = fmt.Sprintf("Extracting geohash %s (z%d-%d)", ghLabel, layer.MinZoom, layer.MaxZoom)

		if err := c.extractRegion(ctx, inputPath, outputPath, bbox, layer.MinZoom, layer.MaxZoom, job, ghLabel); err != nil {
			slog.Error("failed to extract region", "geohash", gh, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		// Check file size for adaptive subdivision
		fileInfo, err := os.Stat(outputPath)
		if err != nil {
			slog.Error("failed to stat extracted file", "path", outputPath, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		needsSubdivision := layer.MaxChunkSize > 0 &&
			fileInfo.Size() > layer.MaxChunkSize &&
			len(gh) < maxPrecision

		if needsSubdivision {
			slog.Info("chunk exceeds size threshold, subdividing",
				"geohash", gh,
				"size", formatSize(fileInfo.Size()),
				"threshold", formatSize(layer.MaxChunkSize),
			)
			job.CurrentTask = fmt.Sprintf("Subdividing %s (%s > %s)", gh, formatSize(fileInfo.Size()), formatSize(layer.MaxChunkSize))
			job.Subdivisions++
			// Replace parent with 32 children in the count
			job.TotalChunks += 31

			c.processSubdivision(ctx, gh, outputPath, layer, job, maxPrecision)

			// Clean up parent temp file (not registered with blisk)
			os.Remove(outputPath)
		} else {
			// Leaf chunk: register with blisk store
			c.registerLeafChunk(ctx, gh, outputPath, bbox, layer, job)
		}

		// Save layers after each top-level geohash completes
		SaveLayers(config.DataDir)
		go func() {
			pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			PublishAnnouncement(pubCtx)
		}()
	}

	job.Status = "ready"
	slog.Info("chunking complete", "layer", layer.ID, "chunks", job.DoneChunks, "subdivisions", job.Subdivisions)
}

// StartRetry begins retrying specific chunks for a layer
func (c *Chunker) StartRetry(ctx context.Context, layer *MapLayer, source *Source, geohashes []string) error {
	c.mu.Lock()
	if existing, exists := c.jobs[layer.ID]; exists && existing.Status == "chunking" {
		c.mu.Unlock()
		return fmt.Errorf("chunking already in progress for layer %s", layer.ID)
	}

	jobCtx, jobCancel := context.WithCancel(context.Background())
	job := &ChunkJob{
		SourceID: layer.ID,
		Status:   "chunking",
		cancel:   jobCancel,
	}
	c.jobs[layer.ID] = job
	c.mu.Unlock()

	// Update layer status immediately so frontend sees "chunking"
	for i := range layers {
		if layers[i].ID == layer.ID {
			layers[i].Status = "chunking"
			break
		}
	}
	SaveLayers(config.DataDir)

	go c.runRetry(jobCtx, layer, source, job, geohashes)
	return nil
}

func (c *Chunker) runRetry(ctx context.Context, layer *MapLayer, source *Source, job *ChunkJob, geohashes []string) {
	defer func() {
		for i := range layers {
			if layers[i].ID == layer.ID {
				layers[i].Status = job.Status
				layers[i].Error = job.Error
				break
			}
		}
		SaveLayers(config.DataDir)
	}()

	// Resolve input
	inputPath := source.URL
	if !strings.HasPrefix(inputPath, "http://") && !strings.HasPrefix(inputPath, "https://") {
		if !filepath.IsAbs(inputPath) {
			inputPath = filepath.Join("..", inputPath)
		}
		if _, err := os.Stat(inputPath); err != nil {
			job.Status = "error"
			job.Error = fmt.Sprintf("local file not found: %s", source.URL)
			slog.Error("failed to resolve input for retry", "layer", layer.ID, "error", err)
			return
		}
	}

	maxPrecision := layer.MaxPrecision
	if maxPrecision <= 0 || maxPrecision > 4 {
		maxPrecision = 4
	}

	job.TotalChunks = len(geohashes)
	job.Status = "chunking"

	slog.Info("starting retry",
		"layer", layer.ID,
		"source", source.ID,
		"chunks", len(geohashes),
	)

	for _, gh := range geohashes {
		select {
		case <-ctx.Done():
			job.Status = "pending"
			job.Error = ""
			slog.Info("chunking cancelled, progress preserved", "layer", layer.ID, "done", job.DoneChunks)
			return
		default:
		}

		// Clean up old entry and any children before re-extracting
		cleanupChunkAndChildren(gh, layer.ID)

		bbox := geohashToBBox(gh)
		ghLabel := gh
		if ghLabel == "" {
			ghLabel = "world"
		}
		outputPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", ghLabel))

		job.CurrentTask = fmt.Sprintf("Retrying %s (z%d-%d)", ghLabel, layer.MinZoom, layer.MaxZoom)

		if err := c.extractRegion(ctx, inputPath, outputPath, bbox, layer.MinZoom, layer.MaxZoom, job, ghLabel); err != nil {
			slog.Error("failed to extract region (retry)", "geohash", gh, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		fileInfo, err := os.Stat(outputPath)
		if err != nil {
			slog.Error("failed to stat extracted file (retry)", "path", outputPath, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		needsSubdivision := layer.MaxChunkSize > 0 &&
			fileInfo.Size() > layer.MaxChunkSize &&
			len(gh) < maxPrecision

		if needsSubdivision {
			slog.Info("retry chunk exceeds threshold, subdividing",
				"geohash", gh,
				"size", formatSize(fileInfo.Size()),
				"threshold", formatSize(layer.MaxChunkSize),
			)
			job.CurrentTask = fmt.Sprintf("Subdividing %s (%s > %s)", gh, formatSize(fileInfo.Size()), formatSize(layer.MaxChunkSize))
			job.Subdivisions++
			job.TotalChunks += 31

			c.processSubdivision(ctx, gh, outputPath, layer, job, maxPrecision)

			os.Remove(outputPath)
		} else {
			c.registerLeafChunk(ctx, gh, outputPath, bbox, layer, job)
		}

		SaveLayers(config.DataDir)
		go func() {
			pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			PublishAnnouncement(pubCtx)
		}()
	}

	job.Status = "ready"
	slog.Info("retry complete", "layer", layer.ID, "chunks", job.DoneChunks, "subdivisions", job.Subdivisions)
}

// cleanupChunkAndChildren removes a chunk and all its descendants from the layer config, store, and announcement
func cleanupChunkAndChildren(gh string, layerID string) {
	for idx := range layers {
		if layers[idx].ID != layerID {
			continue
		}
		chunks := layers[idx].Chunks
		if chunks == nil {
			return
		}

		// Delete the chunk itself
		if info, exists := chunks[gh]; exists {
			deleteChunkFromStore(info.File)
			delete(chunks, gh)
		}

		// Delete all descendants (any geohash that starts with gh)
		if gh != "" {
			for childGH, childInfo := range chunks {
				if strings.HasPrefix(childGH, gh) && childGH != gh {
					deleteChunkFromStore(childInfo.File)
					delete(chunks, childGH)
				}
			}
		}
		break
	}
}

// FindMissingChunks returns geohashes that aren't covered in the layer.
// First checks the most recent job for error entries, then falls back to
// scanning for missing base-precision geohashes.
func (c *Chunker) FindMissingChunks(layer *MapLayer) []string {
	// Check job for error entries first
	c.mu.Lock()
	job := c.jobs[layer.ID]
	c.mu.Unlock()

	if job != nil && len(job.Chunks) > 0 {
		var errored []string
		for _, chunk := range job.Chunks {
			if chunk.Status == "error" {
				errored = append(errored, chunk.Geohash)
			}
		}
		if len(errored) > 0 {
			return errored
		}
	}

	// Fall back: scan for missing base geohashes
	baseGHs := generateGeohashes(layer.Precision)

	if layer.Chunks == nil || len(layer.Chunks) == 0 {
		return baseGHs
	}

	var missing []string
	for _, gh := range baseGHs {
		if isGeohashCovered(gh, layer.Chunks) {
			continue
		}
		missing = append(missing, gh)
	}
	return missing
}

// isGeohashCovered checks if a geohash is covered by the chunks map
// (either directly present or has at least one descendant from subdivision)
func isGeohashCovered(gh string, chunks map[string]ChunkInfo) bool {
	if _, exists := chunks[gh]; exists {
		return true
	}
	if gh == "" {
		// Precision 0: covered if any chunks exist at all
		return len(chunks) > 0
	}
	// Check for descendants
	for chunkGH := range chunks {
		if strings.HasPrefix(chunkGH, gh) {
			return true
		}
	}
	return false
}

// processSubdivision recursively splits an oversized chunk into 32 children.
// The parentPath must remain on disk until this function returns.
func (c *Chunker) processSubdivision(
	ctx context.Context,
	parentGH string,
	parentPath string,
	layer *MapLayer,
	job *ChunkJob,
	maxPrecision int,
) {
	slog.Info("subdividing chunk", "parent", parentGH, "children", 32)

	for _, char := range base32 {
		select {
		case <-ctx.Done():
			return
		default:
		}

		childGH := parentGH + string(char)
		childBBox := geohashToBBox(childGH)
		childPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", childGH))

		job.CurrentTask = fmt.Sprintf("Extracting %s from parent %s", childGH, parentGH)

		// Extract from parent file (local), not from remote source
		if err := c.extractRegion(ctx, parentPath, childPath, childBBox, layer.MinZoom, layer.MaxZoom, job, childGH); err != nil {
			slog.Error("failed to extract child region", "geohash", childGH, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: childGH, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		// Check child size for recursive subdivision
		childInfo, err := os.Stat(childPath)
		if err != nil {
			slog.Error("failed to stat child file", "path", childPath, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: childGH, Status: "error", Error: err.Error(),
			})
			job.DoneChunks++
			job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
			continue
		}

		needsSubdivision := layer.MaxChunkSize > 0 &&
			childInfo.Size() > layer.MaxChunkSize &&
			len(childGH) < maxPrecision

		if needsSubdivision {
			slog.Info("child chunk exceeds threshold, subdividing further",
				"geohash", childGH,
				"size", formatSize(childInfo.Size()),
				"threshold", formatSize(layer.MaxChunkSize),
			)
			job.Subdivisions++
			job.TotalChunks += 31

			c.processSubdivision(ctx, childGH, childPath, layer, job, maxPrecision)

			// Clean up child temp file after its children are extracted
			os.Remove(childPath)
		} else {
			// Leaf chunk: register with blisk store
			c.registerLeafChunk(ctx, childGH, childPath, childBBox, layer, job)
		}
	}

	slog.Info("subdivision complete", "parent", parentGH)
}

// isGeohashComplete checks if a geohash (or any of its subdivided children) is already in layer.Chunks
func isGeohashComplete(layer *MapLayer, gh string) bool {
	if layer.Chunks == nil {
		return false
	}
	if _, ok := layer.Chunks[gh]; ok {
		return true
	}
	for key := range layer.Chunks {
		if strings.HasPrefix(key, gh) {
			return true
		}
	}
	return false
}

// registerLeafChunk registers a chunk file with blisk store and updates announcement/config.
// The temp file at path is cleaned up after registration.
func (c *Chunker) registerLeafChunk(
	ctx context.Context,
	gh string,
	path string,
	bbox [4]float64,
	layer *MapLayer,
	job *ChunkJob,
) {
	f, err := os.Open(path)
	if err != nil {
		slog.Error("failed to open extracted file", "path", path, "error", err)
		job.Chunks = append(job.Chunks, ChunkResult{
			Geohash: gh, Status: "error", Error: err.Error(),
		})
		job.DoneChunks++
		job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
		return
	}
	meta, err := store.Save(ctx, f, "blosmap")
	f.Close()
	os.Remove(path) // Clean up temp extract file
	if err != nil {
		slog.Error("failed to save to store", "geohash", gh, "error", err)
		job.Chunks = append(job.Chunks, ChunkResult{
			Geohash: gh, Status: "error", Error: err.Error(),
		})
		job.DoneChunks++
		job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100
		return
	}

	hash := meta.Hash.Hex()
	size := meta.Size

	chunkInfo := ChunkInfo{
		BBox:    bbox,
		File:    fmt.Sprintf("%s.pmtiles", hash),
		MaxZoom: layer.MaxZoom,
		Size:    size,
	}

	// Persist chunk in layer
	for idx := range layers {
		if layers[idx].ID == layer.ID {
			if layers[idx].Chunks == nil {
				layers[idx].Chunks = make(map[string]ChunkInfo)
			}
			layers[idx].Chunks[gh] = chunkInfo
			break
		}
	}

	job.Chunks = append(job.Chunks, ChunkResult{
		Geohash: gh,
		File:    hash[:12],
		Size:    size,
		Status:  "done",
	})
	job.DoneChunks++
	job.Progress = float64(job.DoneChunks) / float64(job.TotalChunks) * 100

	slog.Info("registered chunk",
		"geohash", gh,
		"file", hash[:8],
		"size", formatSize(size),
		"progress", fmt.Sprintf("%.1f%%", job.Progress),
	)
}


func (c *Chunker) extractRegion(ctx context.Context, input, output string, bbox [4]float64, minZoom, maxZoom int, job *ChunkJob, ghLabel string) error {
	if c.pmtilesBin == "" {
		return fmt.Errorf("pmtiles binary not configured")
	}

	// Remove any existing output file (from a previous failed extraction)
	os.Remove(output)

	bboxStr := fmt.Sprintf("%f,%f,%f,%f", bbox[0], bbox[1], bbox[2], bbox[3])

	args := []string{
		"extract",
		input,
		output,
		fmt.Sprintf("--bbox=%s", bboxStr),
		"--minzoom", fmt.Sprintf("%d", minZoom),
		"--maxzoom", fmt.Sprintf("%d", maxZoom),
	}

	cmd := exec.CommandContext(ctx, c.pmtilesBin, args...)

	slog.Debug("running pmtiles extract", "cmd", append([]string{c.pmtilesBin}, args...))

	// Set current chunk progress before starting
	job.CurrentChunk = &ChunkProgress{Geohash: ghLabel, Percent: 0}

	// Pipe both stdout and stderr to parse progress (pmtiles may write to either)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		job.CurrentChunk = nil
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		job.CurrentChunk = nil
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		job.CurrentChunk = nil
		return fmt.Errorf("pmtiles extract failed to start: %w", err)
	}

	// Parse \r-delimited progress lines from a reader
	var stdoutErrors []string
	var stderrErrors []string
	var wg sync.WaitGroup

	parseOutput := func(r io.Reader, errors *[]string) {
		defer wg.Done()
		buf := make([]byte, 4096)
		var lineBuf []byte
		for {
			n, readErr := r.Read(buf)
			if n > 0 {
				for _, b := range buf[:n] {
					if b == '\r' || b == '\n' {
						line := strings.TrimSpace(string(lineBuf))
						lineBuf = lineBuf[:0]
						if line == "" {
							continue
						}
						if pct, info, ok := parseProgressLine(line); ok {
							job.CurrentTask = fmt.Sprintf("Extracting %s — %d%% %s", ghLabel, pct, info)
							job.CurrentChunk = &ChunkProgress{
								Geohash:   ghLabel,
								Percent:   pct,
								BytesInfo: info,
							}
						} else {
							*errors = append(*errors, line)
						}
					} else {
						lineBuf = append(lineBuf, b)
					}
				}
			}
			if readErr != nil {
				if line := strings.TrimSpace(string(lineBuf)); line != "" {
					if _, _, ok := parseProgressLine(line); !ok {
						*errors = append(*errors, line)
					}
				}
				break
			}
		}
	}

	wg.Add(2)
	go parseOutput(stdout, &stdoutErrors)
	go parseOutput(stderr, &stderrErrors)

	waitErr := cmd.Wait()
	wg.Wait()
	job.CurrentChunk = nil

	if waitErr != nil {
		// Collect error info from stderr and stdout
		allErrors := append(stderrErrors, stdoutErrors...)
		errMsg := strings.Join(allErrors, "; ")
		if errMsg != "" {
			slog.Error("pmtiles extract failed", "ghLabel", ghLabel, "errors", allErrors)
			return fmt.Errorf("pmtiles extract failed: %s", errMsg)
		}
		return fmt.Errorf("pmtiles extract failed: %w", waitErr)
	}

	return nil
}

// parseProgressLine extracts percentage and byte stats from a pmtiles progress line.
// Example input: "fetching chunks  42% |████████| (64 MB/152 MB, 4.2 MB/s) [12s:25s]"
func parseProgressLine(line string) (pct int, info string, ok bool) {
	// Find percentage: look for "XX%" pattern
	pctIdx := strings.Index(line, "%")
	if pctIdx < 1 {
		return 0, "", false
	}
	// Walk back from % to find the number
	numStart := pctIdx - 1
	for numStart > 0 && line[numStart-1] >= '0' && line[numStart-1] <= '9' {
		numStart--
	}
	if numStart == pctIdx {
		return 0, "", false
	}
	fmt.Sscanf(line[numStart:pctIdx], "%d", &pct)

	// Find parenthesized byte stats: "(XX MB/YY MB, Z MB/s)"
	parenStart := strings.Index(line, "(")
	parenEnd := strings.LastIndex(line, ")")
	if parenStart >= 0 && parenEnd > parenStart {
		info = line[parenStart : parenEnd+1]
	}

	return pct, info, true
}

// GetJob returns the current job status for a source
func (c *Chunker) GetJob(sourceID string) *ChunkJob {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jobs[sourceID]
}

// CancelJob cancels a running chunking job
func (c *Chunker) CancelJob(layerID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if job, exists := c.jobs[layerID]; exists && job.cancel != nil && job.Status == "chunking" {
		job.cancel()
		return true
	}
	return false
}

// ClearJob removes a job entry so the layer ID can be reused
func (c *Chunker) ClearJob(layerID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if job, exists := c.jobs[layerID]; exists && job.cancel != nil {
		job.cancel()
	}
	delete(c.jobs, layerID)
}

// ListDownloads returns all downloaded PMTiles files
func (c *Chunker) ListDownloads() ([]DownloadedFile, error) {
	var files []DownloadedFile

	// Check downloads directory
	downloadDir := filepath.Join(config.DataDir, "downloads")
	entries, err := os.ReadDir(downloadDir)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".pmtiles") {
			continue
		}

		path := filepath.Join(downloadDir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}

		hash, _ := hashFile(path)

		files = append(files, DownloadedFile{
			Name:     e.Name(),
			Path:     path,
			Size:     info.Size(),
			SHA256:   hash,
			IsRemote: true,
		})
	}

	// Check for local files referenced in sources
	for _, src := range sources {
		if strings.HasPrefix(src.URL, "http") {
			continue
		}
		path := src.URL
		if !filepath.IsAbs(path) {
			path = filepath.Join("..", path)
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}

		hash, _ := hashFile(path)

		files = append(files, DownloadedFile{
			Name:      filepath.Base(path),
			Path:      path,
			Size:      info.Size(),
			SHA256:    hash,
			IsRemote:  false,
			SourceURL: src.URL,
		})
	}

	return files, nil
}

// formatSize returns a human-readable size string
func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

// Geohash utilities
var base32 = "0123456789bcdefghjkmnpqrstuvwxyz"

func generateGeohashes(precision int) []string {
	if precision <= 0 {
		return []string{""} // Single chunk covering entire world
	}
	if precision > 4 {
		precision = 4 // Limit to prevent too many chunks
	}

	var result []string
	generateGeohashesRecursive("", precision, &result)
	return result
}

func generateGeohashesRecursive(prefix string, remaining int, result *[]string) {
	if remaining == 0 {
		*result = append(*result, prefix)
		return
	}
	for _, c := range base32 {
		generateGeohashesRecursive(prefix+string(c), remaining-1, result)
	}
}

func geohashToBBox(geohash string) [4]float64 {
	minLat, maxLat := -90.0, 90.0
	minLon, maxLon := -180.0, 180.0
	isLon := true

	for _, c := range geohash {
		idx := strings.IndexRune(base32, c)
		if idx == -1 {
			continue
		}

		for bit := 4; bit >= 0; bit-- {
			if (idx & (1 << bit)) != 0 {
				if isLon {
					minLon = (minLon + maxLon) / 2
				} else {
					minLat = (minLat + maxLat) / 2
				}
			} else {
				if isLon {
					maxLon = (minLon + maxLon) / 2
				} else {
					maxLat = (minLat + maxLat) / 2
				}
			}
			isLon = !isLon
		}
	}

	return [4]float64{minLon, minLat, maxLon, maxLat}
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}
