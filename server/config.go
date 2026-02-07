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
	PrivateKey string   `json:"privateKey"` // hex or nsec
	Relays     []string `json:"relays"`

	// Map settings
	MaxZoom int `json:"maxZoom"`
}

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
		MaxZoom: 14,
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
		path = "blosmap.config.json"
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
