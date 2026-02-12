package main

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"path/filepath"
	"strings"
)

//go:embed all:dashboard
var dashboardFS embed.FS

func (r *Router) handleDashboard(w http.ResponseWriter, req *http.Request) {
	subFS, err := fs.Sub(dashboardFS, "dashboard")
	if err != nil {
		http.Error(w, "Dashboard not available", http.StatusInternalServerError)
		return
	}

	// Strip /dashboard/ prefix
	filePath := strings.TrimPrefix(req.URL.Path, "/dashboard/")
	if filePath == "" {
		filePath = "index.html"
	}
	filePath = path.Clean(filePath)

	// Try to read the requested file
	data, err := fs.ReadFile(subFS, filePath)
	if err != nil {
		// SPA fallback: serve index.html for unmatched paths
		data, err = fs.ReadFile(subFS, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`<!DOCTYPE html>
<html><head><title>Dashboard not built</title></head>
<body style="font-family:system-ui;padding:2rem">
<h1>Dashboard not built yet</h1>
<p>Run <code>bun run build</code> from the project root, then rebuild the Go binary.</p>
</body></html>`))
			return
		}
		filePath = "index.html"
	}

	// Set content type from file extension
	contentType := mime.TypeByExtension(filepath.Ext(filePath))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", contentType)
	w.Write(data)
}
