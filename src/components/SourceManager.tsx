import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  getSources,
  addSource,
  deleteSource,
  getLayers,
  addLayer,
  deleteLayer,
  startLayerChunking,
  getLayerStatus,
  type Source,
  type MapLayer,
  type ChunkJob,
} from "@/lib/api";
import { ChevronDown, ChevronRight } from "lucide-react";

export function SourceManager() {
  const [sources, setSources] = useState<Source[]>([]);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [jobs, setJobs] = useState<Record<string, ChunkJob>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openLayers, setOpenLayers] = useState<Record<string, boolean>>({});

  // Source form state
  const [newSource, setNewSource] = useState({ id: "", url: "", title: "" });
  const [addingSource, setAddingSource] = useState(false);

  // Layer form state
  const [newLayer, setNewLayer] = useState({
    id: "",
    sourceId: "",
    title: "",
    minZoom: 0,
    maxZoom: 14,
    precision: 1,
  });
  const [addingLayer, setAddingLayer] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // Poll job status for active layers
  useEffect(() => {
    const activeLayers = layers.filter(
      (l) => l.status === "chunking"
    );

    if (activeLayers.length === 0) return;

    const interval = setInterval(() => {
      activeLayers.forEach(async (l) => {
        try {
          const job = await getLayerStatus(l.id);
          setJobs((prev) => ({ ...prev, [l.id]: job }));
          if (job.status === "ready" || job.status === "error") {
            loadData();
          }
        } catch (e) {
          // Ignore errors
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [layers]);

  async function loadData() {
    try {
      const [sourcesData, layersData] = await Promise.all([
        getSources(),
        getLayers(),
      ]);
      setSources(sourcesData || []);
      setLayers(layersData || []);
      setError(null);
    } catch (e) {
      setError("Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  async function handleAddSource() {
    if (!newSource.id || !newSource.url) return;
    setAddingSource(true);
    setError(null);
    try {
      await addSource(newSource);
      setNewSource({ id: "", url: "", title: "" });
      await loadData();
    } catch (e) {
      setError("Failed to add source");
    } finally {
      setAddingSource(false);
    }
  }

  async function handleDeleteSource(id: string) {
    // Check if any layers use this source
    const usedByLayers = layers.filter((l) => l.sourceId === id);
    if (usedByLayers.length > 0) {
      setError(`Cannot delete source: used by ${usedByLayers.length} layer(s)`);
      return;
    }
    if (!confirm(`Delete source ${id}?`)) return;
    try {
      await deleteSource(id);
      await loadData();
    } catch (e) {
      setError("Failed to delete source");
    }
  }

  async function handleAddLayer() {
    if (!newLayer.id || !newLayer.sourceId) return;
    setAddingLayer(true);
    setError(null);
    try {
      await addLayer(newLayer);
      setNewLayer({ id: "", sourceId: "", title: "", minZoom: 0, maxZoom: 14, precision: 1 });
      await loadData();
    } catch (e) {
      setError("Failed to add layer");
    } finally {
      setAddingLayer(false);
    }
  }

  async function handleDeleteLayer(id: string) {
    if (!confirm(`Delete layer ${id}?`)) return;
    try {
      await deleteLayer(id);
      await loadData();
    } catch (e) {
      setError("Failed to delete layer");
    }
  }

  async function handleStartChunking(id: string) {
    try {
      await startLayerChunking(id);
      await loadData();
    } catch (e) {
      setError("Failed to start chunking");
    }
  }

  function toggleLayer(id: string) {
    setOpenLayers((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const statusColors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    downloading: "bg-blue-100 text-blue-700",
    chunking: "bg-yellow-100 text-yellow-700",
    ready: "bg-green-100 text-green-700",
    error: "bg-red-100 text-red-700",
  };

  return (
    <div className="space-y-6">
      {/* Sources Card */}
      <Card>
        <CardHeader>
          <CardTitle>PMTiles Sources</CardTitle>
          <CardDescription>
            Input PMTiles files (local or remote)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add source form */}
          <div className="rounded-lg border p-4 space-y-4">
            <h4 className="font-medium">Add New Source</h4>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="source-id">ID</Label>
                <Input
                  id="source-id"
                  value={newSource.id}
                  onChange={(e) => setNewSource({ ...newSource, id: e.target.value })}
                  placeholder="world-basemap"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="source-url">URL or Path</Label>
                <Input
                  id="source-url"
                  value={newSource.url}
                  onChange={(e) => setNewSource({ ...newSource, url: e.target.value })}
                  placeholder="https://... or ./local.pmtiles"
                />
              </div>
            </div>
            <Button onClick={handleAddSource} disabled={addingSource || !newSource.id || !newSource.url}>
              {addingSource ? "Adding..." : "Add Source"}
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Sources list */}
          {loading ? (
            <p className="text-muted-foreground">Loading sources...</p>
          ) : sources.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="text-muted-foreground">No sources configured</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add a PMTiles source to create layers
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{source.id}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${statusColors[source.status] || ""}`}>
                        {source.status}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {source.url}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteSource(source.id)}
                    className="text-destructive hover:text-destructive ml-2"
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Layers Card */}
      <Card>
        <CardHeader>
          <CardTitle>Map Layers</CardTitle>
          <CardDescription>
            Output configurations with zoom levels and chunking settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add layer form */}
          <div className="rounded-lg border p-4 space-y-4">
            <h4 className="font-medium">Create New Layer</h4>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="layer-id">Layer ID</Label>
                <Input
                  id="layer-id"
                  value={newLayer.id}
                  onChange={(e) => setNewLayer({ ...newLayer, id: e.target.value })}
                  placeholder="basemap-low-res"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-source">Source</Label>
                <select
                  id="layer-source"
                  value={newLayer.sourceId}
                  onChange={(e) => setNewLayer({ ...newLayer, sourceId: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="">Select source...</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-title">Title (optional)</Label>
                <Input
                  id="layer-title"
                  value={newLayer.title}
                  onChange={(e) => setNewLayer({ ...newLayer, title: e.target.value })}
                  placeholder="Low Resolution Basemap"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-minzoom">Min Zoom</Label>
                <Input
                  id="layer-minzoom"
                  type="number"
                  min={0}
                  max={22}
                  value={newLayer.minZoom}
                  onChange={(e) => setNewLayer({ ...newLayer, minZoom: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-maxzoom">Max Zoom</Label>
                <Input
                  id="layer-maxzoom"
                  type="number"
                  min={0}
                  max={22}
                  value={newLayer.maxZoom}
                  onChange={(e) => setNewLayer({ ...newLayer, maxZoom: parseInt(e.target.value) || 14 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="layer-precision">Geohash Precision</Label>
                <Input
                  id="layer-precision"
                  type="number"
                  min={1}
                  max={4}
                  value={newLayer.precision}
                  onChange={(e) => setNewLayer({ ...newLayer, precision: parseInt(e.target.value) || 1 })}
                />
                <p className="text-xs text-muted-foreground">
                  1 = 32, 2 = 1024, 3 = 32768 chunks
                </p>
              </div>
            </div>
            <Button
              onClick={handleAddLayer}
              disabled={addingLayer || !newLayer.id || !newLayer.sourceId || sources.length === 0}
            >
              {addingLayer ? "Creating..." : "Create Layer"}
            </Button>
          </div>

          {/* Layers list */}
          {loading ? (
            <p className="text-muted-foreground">Loading layers...</p>
          ) : layers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="text-muted-foreground">No layers configured</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create a layer from a source to start chunking
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {layers.map((layer) => {
                const job = jobs[layer.id];
                const isOpen = openLayers[layer.id] ?? false;
                const source = sources.find((s) => s.id === layer.sourceId);

                return (
                  <Collapsible
                    key={layer.id}
                    open={isOpen}
                    onOpenChange={() => toggleLayer(layer.id)}
                  >
                    <div className="rounded-lg border">
                      <CollapsibleTrigger className="flex w-full items-center justify-between p-4 hover:bg-muted/50">
                        <div className="flex items-center gap-3">
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          <div className="text-left">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{layer.title || layer.id}</span>
                              <span className={`text-xs px-2 py-0.5 rounded ${statusColors[layer.status] || ""}`}>
                                {layer.status}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Source: {layer.sourceId} | Zoom: {layer.minZoom}-{layer.maxZoom} | Precision: {layer.precision}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                          {layer.status === "pending" && (
                            <Button
                              size="sm"
                              onClick={() => handleStartChunking(layer.id)}
                            >
                              Start Chunking
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteLayer(layer.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            Delete
                          </Button>
                        </div>
                      </CollapsibleTrigger>

                      <CollapsibleContent>
                        <div className="border-t p-4 space-y-3">
                          {/* Progress bar for active jobs */}
                          {job && job.status === "chunking" && (
                            <div className="space-y-1">
                              <div className="flex justify-between text-xs text-muted-foreground">
                                <span>Chunking...</span>
                                <span>{job.doneChunks}/{job.totalChunks} ({job.progress.toFixed(1)}%)</span>
                              </div>
                              <div className="h-2 w-full rounded-full bg-muted">
                                <div
                                  className="h-2 rounded-full bg-primary transition-all"
                                  style={{ width: `${job.progress}%` }}
                                />
                              </div>
                            </div>
                          )}

                          {layer.error && (
                            <p className="text-sm text-destructive">{layer.error}</p>
                          )}

                          <div className="grid gap-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Layer ID:</span>
                              <span className="font-mono">{layer.id}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Source:</span>
                              <span className="font-mono">{layer.sourceId}</span>
                            </div>
                            {source && (
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Source URL:</span>
                                <span className="font-mono text-xs truncate max-w-xs">{source.url}</span>
                              </div>
                            )}
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Zoom Range:</span>
                              <span>{layer.minZoom} - {layer.maxZoom}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Geohash Precision:</span>
                              <span>{layer.precision} ({Math.pow(32, layer.precision)} chunks)</span>
                            </div>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
