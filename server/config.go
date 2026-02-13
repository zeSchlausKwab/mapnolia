package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

var configPath string // track which config file was loaded

// Config holds server configuration
type Config struct {
	// Server identity
	Name    string `json:"name"`
	About   string `json:"about"`
	Picture string `json:"picture"`

	// Network
	Host    string `json:"host"`
	Port    int    `json:"port"`
	BaseURL string `json:"baseURL"`

	// Storage
	DataDir   string `json:"dataDir"`
	DiskQuota int64  `json:"diskQuota"` // bytes

	// Nostr
	PrivateKey  string   `json:"privateKey"`            // hex or nsec
	AdminPubkey string   `json:"adminPubkey,omitempty"` // hex pubkey of admin user
	Relays      []string `json:"relays"`

	// Legacy fields — used only for migration, then cleared
	LegacySources []Source   `json:"sources,omitempty"`
	LegacyLayers  []MapLayer `json:"layers,omitempty"`
}

// Source represents an input PMTiles file
type Source struct {
	ID     string `json:"id"`
	URL    string `json:"url"`    // local path or remote URL
	Title  string `json:"title"`  // display name
	Status string `json:"status"` // pending, downloading, ready, error
	Error  string `json:"error,omitempty"`
	Size   int64  `json:"size,omitempty"` // file size once downloaded

	// Metadata from PMTiles header
	TileType        string     `json:"tileType,omitempty"`        // mvt, png, jpg, webp, avif
	TileCompression string     `json:"tileCompression,omitempty"` // gzip, br, zstd, none
	MinZoom         int        `json:"minZoom,omitempty"`
	MaxZoom         int        `json:"maxZoom,omitempty"`
	Bounds          [4]float64 `json:"bounds,omitempty"` // [minLon, minLat, maxLon, maxLat]
	Center          [3]float64 `json:"center,omitempty"` // [lon, lat, zoom]

	// Extended metadata
	NumTileEntries int      `json:"numTileEntries,omitempty"`
	NumContents    int      `json:"numContents,omitempty"`
	Clustered      bool     `json:"clustered,omitempty"`
	InternalComp   string   `json:"internalCompression,omitempty"`
	Attribution    string   `json:"attribution,omitempty"`
	Description    string   `json:"description,omitempty"`
	VectorLayers   []string `json:"vectorLayers,omitempty"`
}

// MapLayer represents an output chunked layer configuration
type MapLayer struct {
	ID           string               `json:"id"`
	SourceID     string               `json:"sourceId"`               // references a Source
	Title        string               `json:"title"`                  // display name
	MinZoom      int                  `json:"minZoom"`                // minimum zoom level to extract
	MaxZoom      int                  `json:"maxZoom"`                // maximum zoom level to extract
	Precision    int                  `json:"precision"`              // starting geohash precision (1-4)
	MaxChunkSize int64                `json:"maxChunkSize,omitempty"` // bytes; chunks exceeding this get subdivided (0 = disabled)
	MaxPrecision int                  `json:"maxPrecision,omitempty"` // max depth for recursive subdivision (default 4)
	Status       string               `json:"status"`                 // pending, chunking, ready, error
	Error        string               `json:"error,omitempty"`
	Chunks       map[string]ChunkInfo `json:"chunks,omitempty"` // geohash -> chunk info
	File         string               `json:"file,omitempty"`   // blob hash for file layers
	TileType     string               `json:"tileType,omitempty"`
	FileSize     int64                `json:"fileSize,omitempty"`
}

// ChunkInfo describes a single PMTiles chunk
type ChunkInfo struct {
	BBox    [4]float64 `json:"bbox"`
	File    string     `json:"file"`
	MaxZoom int        `json:"maxZoom"`
	Size    int64      `json:"size,omitempty"`
}

// ============================================================================
// Sources & Layers — stored in {dataDir}/, not in config
// ============================================================================

var (
	sources []Source
	layers  []MapLayer
)

func LoadSources(dataDir string) error {
	path := filepath.Join(dataDir, "sources.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		sources = []Source{}
		return nil
	}
	if err != nil {
		return fmt.Errorf("failed to read sources: %w", err)
	}
	return json.Unmarshal(data, &sources)
}

func SaveSources(dataDir string) error {
	path := filepath.Join(dataDir, "sources.json")
	data, err := json.MarshalIndent(sources, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func LoadLayers(dataDir string) error {
	path := filepath.Join(dataDir, "layers.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		layers = []MapLayer{}
		return nil
	}
	if err != nil {
		return fmt.Errorf("failed to read layers: %w", err)
	}
	return json.Unmarshal(data, &layers)
}

func SaveLayers(dataDir string) error {
	path := filepath.Join(dataDir, "layers.json")
	data, err := json.MarshalIndent(layers, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// MigrateFromConfig moves sources/layers from an old config into separate files
func MigrateFromConfig(c *Config) {
	if len(c.LegacySources) == 0 && len(c.LegacyLayers) == 0 {
		return
	}

	if len(c.LegacySources) > 0 {
		sources = c.LegacySources
		c.LegacySources = nil
	}
	if len(c.LegacyLayers) > 0 {
		layers = c.LegacyLayers
		c.LegacyLayers = nil
	}

	if err := SaveSources(c.DataDir); err != nil {
		slog.Error("failed to migrate sources", "error", err)
	}
	if err := SaveLayers(c.DataDir); err != nil {
		slog.Error("failed to migrate layers", "error", err)
	}
	if err := c.Save(""); err != nil {
		slog.Error("failed to save cleaned config", "error", err)
	}

	slog.Info("migrated sources and layers from config to data directory",
		"sources", len(sources), "layers", len(layers))
}

// ============================================================================
// Config
// ============================================================================

// Address returns the listen address
func (c *Config) Address() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// DefaultConfig returns sensible defaults
func DefaultConfig() *Config {
	return &Config{
		Name:      "blosmap server",
		About:     "A Blossom server for PMTiles map data",
		Host:      "0.0.0.0",
		Port:      3544,
		BaseURL:   "http://localhost:3544",
		DataDir:   "./data",
		DiskQuota: 10 * 1024 * 1024 * 1024, // 10GB default
		Relays: []string{
			"ws://localhost:10547", // local nak relay for dev
			"wss://relay.damus.io",
			"wss://nos.lol",
		},
	}
}

// LoadConfig loads configuration from file or environment
func LoadConfig() (*Config, error) {
	config := DefaultConfig()

	// Try to load from config file
	configPaths := []string{
		"blosmap.config.json",
		"../blosmap.config.json", // when running from server/ directory
		"config.json",
		filepath.Join(os.Getenv("HOME"), ".config", "blosmap", "config.json"),
	}

	var configData []byte
	var err error
	for _, path := range configPaths {
		configData, err = os.ReadFile(path)
		if err == nil {
			configPath = path
			slog.Info("loaded config", "path", path)
			break
		}
	}

	if configData != nil {
		if err := json.Unmarshal(configData, config); err != nil {
			return nil, fmt.Errorf("failed to parse config: %w", err)
		}
	} else {
		slog.Info("no config file found, using defaults")
	}

	// Environment overrides
	if host := os.Getenv("BLOSMAP_HOST"); host != "" {
		config.Host = host
	}
	if port := os.Getenv("BLOSMAP_PORT"); port != "" {
		fmt.Sscanf(port, "%d", &config.Port)
	}
	if baseURL := os.Getenv("BLOSMAP_BASE_URL"); baseURL != "" {
		config.BaseURL = baseURL
	}
	if dataDir := os.Getenv("BLOSMAP_DATA_DIR"); dataDir != "" {
		config.DataDir = dataDir
	}
	if privateKey := os.Getenv("BLOSMAP_PRIVATE_KEY"); privateKey != "" {
		config.PrivateKey = privateKey
	}

	// Ensure data directory exists
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data directory: %w", err)
	}

	return config, nil
}

// Save writes the config to file. If path is empty, uses the loaded config path.
func (c *Config) Save(path string) error {
	if path == "" {
		path = configPath
	}
	if path == "" {
		// Default to parent directory (project root)
		path = "../blosmap.config.json"
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
