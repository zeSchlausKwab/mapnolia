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

// ChunkJob tracks a chunking operation
type ChunkJob struct {
	SourceID    string  `json:"sourceId"`
	Status      string  `json:"status"` // pending, chunking, ready, error
	Progress    float64 `json:"progress"`
	Error       string  `json:"error,omitempty"`
	TotalChunks int     `json:"totalChunks"`
	DoneChunks  int     `json:"doneChunks"`
	CurrentTask string  `json:"currentTask,omitempty"`
	Chunks      []ChunkResult `json:"chunks,omitempty"`
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

// StartChunking begins chunking a layer
func (c *Chunker) StartChunking(ctx context.Context, layer *MapLayer, source *Source) error {
	c.mu.Lock()
	if _, exists := c.jobs[layer.ID]; exists {
		c.mu.Unlock()
		return fmt.Errorf("chunking already in progress for layer %s", layer.ID)
	}

	job := &ChunkJob{
		SourceID: layer.ID,
		Status:   "chunking",
	}
	c.jobs[layer.ID] = job
	c.mu.Unlock()

	// Update layer status in config immediately so frontend sees "chunking"
	for i := range config.MapLayers {
		if config.MapLayers[i].ID == layer.ID {
			config.MapLayers[i].Status = "chunking"
			break
		}
	}
	config.Save("")

	go c.runChunking(ctx, layer, source, job)
	return nil
}

func (c *Chunker) runChunking(ctx context.Context, layer *MapLayer, source *Source, job *ChunkJob) {
	defer func() {
		// Update layer status in config
		for i := range config.MapLayers {
			if config.MapLayers[i].ID == layer.ID {
				config.MapLayers[i].Status = job.Status
				config.MapLayers[i].Error = job.Error
				break
			}
		}
		config.Save("")
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

	// Generate geohashes for the given precision
	geohashes := generateGeohashes(layer.Precision)
	job.TotalChunks = len(geohashes)
	job.Status = "chunking"

	slog.Info("starting chunking",
		"layer", layer.ID,
		"source", source.ID,
		"precision", layer.Precision,
		"chunks", len(geohashes),
		"minZoom", layer.MinZoom,
		"maxZoom", layer.MaxZoom,
	)

	announcement, _ := loadAnnouncement()

	for i, gh := range geohashes {
		select {
		case <-ctx.Done():
			job.Status = "error"
			job.Error = "cancelled"
			return
		default:
		}

		bbox := geohashToBBox(gh)
		outputPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", gh))

		job.CurrentTask = fmt.Sprintf("Extracting geohash %s (z%d-%d)", gh, layer.MinZoom, layer.MaxZoom)

		if err := c.extractRegion(ctx, inputPath, outputPath, bbox, layer.MinZoom, layer.MaxZoom); err != nil {
			slog.Error("failed to extract region", "geohash", gh, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks = i + 1
			job.Progress = float64(i+1) / float64(len(geohashes)) * 100
			continue
		}

		// Calculate SHA256 and rename to content-addressed name
		hash, err := hashFile(outputPath)
		if err != nil {
			slog.Error("failed to hash file", "path", outputPath, "error", err)
			job.Chunks = append(job.Chunks, ChunkResult{
				Geohash: gh, Status: "error", Error: err.Error(),
			})
			job.DoneChunks = i + 1
			job.Progress = float64(i+1) / float64(len(geohashes)) * 100
			continue
		}

		finalPath := filepath.Join(c.outputDir, fmt.Sprintf("%s.pmtiles", hash))
		if outputPath != finalPath {
			if _, err := os.Stat(finalPath); os.IsNotExist(err) {
				os.Rename(outputPath, finalPath)
			} else {
				os.Remove(outputPath) // Duplicate content
			}
		}

		// Get file size
		info, _ := os.Stat(finalPath)
		size := int64(0)
		if info != nil {
			size = info.Size()
		}

		// Build chunk info
		chunkInfo := ChunkInfo{
			BBox:    bbox,
			File:    fmt.Sprintf("%s.pmtiles", hash),
			MaxZoom: layer.MaxZoom,
			Size:    size,
		}

		// Update announcement
		announcement[gh] = chunkInfo

		// Persist chunk in layer config
		for idx := range config.MapLayers {
			if config.MapLayers[idx].ID == layer.ID {
				if config.MapLayers[idx].Chunks == nil {
					config.MapLayers[idx].Chunks = make(map[string]ChunkInfo)
				}
				config.MapLayers[idx].Chunks[gh] = chunkInfo
				break
			}
		}

		job.Chunks = append(job.Chunks, ChunkResult{
			Geohash: gh,
			File:    hash[:12],
			Size:    size,
			Status:  "done",
		})
		job.DoneChunks = i + 1
		job.Progress = float64(i+1) / float64(len(geohashes)) * 100

		slog.Info("extracted chunk",
			"geohash", gh,
			"file", hash[:8],
			"size", size,
			"progress", fmt.Sprintf("%.1f%%", job.Progress),
		)

		// Save config and announcement, then publish
		config.Save("")
		if err := saveAnnouncement(announcement); err != nil {
			slog.Error("failed to save announcement", "error", err)
		} else {
			go func() {
				pubCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				PublishAnnouncement(pubCtx)
			}()
		}
	}

	job.Status = "ready"
	slog.Info("chunking complete", "layer", layer.ID, "chunks", job.DoneChunks)
}


func (c *Chunker) extractRegion(ctx context.Context, input, output string, bbox [4]float64, minZoom, maxZoom int) error {
	if c.pmtilesBin == "" {
		return fmt.Errorf("pmtiles binary not configured")
	}

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
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pmtiles extract failed: %w", err)
	}

	return nil
}

// GetJob returns the current job status for a source
func (c *Chunker) GetJob(sourceID string) *ChunkJob {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.jobs[sourceID]
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
	for _, src := range config.Sources {
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

// Geohash utilities
var base32 = "0123456789bcdefghjkmnpqrstuvwxyz"

func generateGeohashes(precision int) []string {
	if precision <= 0 {
		precision = 1
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
